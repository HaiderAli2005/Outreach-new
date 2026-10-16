import { prisma } from "../../lib/prisma.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { isValidDomain } from "../../lib/normalize.js";
import { mailboxCredentialRef, secretStore } from "../../integrations/secrets.js";
import { MAX_INBOXES_PER_DOMAIN, SENDS_PER_WARM_INBOX } from "../../config/plans.js";
import { logSystem } from "../systemLog.js";
import { REGION_TZ } from "../sending/schedule.js";
import { credsFor, transportFor, transportRefFor } from "../sending/transport/index.js";
import { checkPoolDomain } from "./auth.js";
import { retireMailbox, toRepliesOnly } from "./lifecycle.js";
import { invalidateConsole } from "./metrics.js";
import { PERSONA_SEED } from "./personaSeed.js";
import { localPartFor } from "./personas.js";
import { activateWarmed, closeFilledReorders } from "./restock.js";

/**
 * Domains and mailboxes an operator bought elsewhere (any registrar, any mail host) and adds by hand.
 *
 *   warmed  already sending elsewhere: goes ACTIVE as soon as SPF, DKIM and DMARC pass, mailboxes at 30 a day
 *   new     fresh: waits for DNS, ages 30 days sending nothing, then the 5 / 10 / 20 / 30 ladder
 *
 * Every mailbox signs in over SMTP and IMAP before it may send. Its password goes into the secret store, never into
 * this database, a log or an API response.
 */

export interface MailboxInput {
  address: string;
  firstName: string;
  lastName?: string | null;
  username?: string | null;
  password: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export interface DomainInput {
  name: string;
  warmed: boolean;
  region: string;
  locale: string;
  registrar?: string | null;
  dkimSelector?: string | null;
  mailboxes: MailboxInput[];
}

const clean = (s: string) => s.trim().toLowerCase();

function checkMailboxes(domain: string, list: MailboxInput[], existing: string[]): void {
  if (list.length + existing.length > MAX_INBOXES_PER_DOMAIN) throw badRequest(`A domain holds at most ${MAX_INBOXES_PER_DOMAIN} mailboxes (90 emails a day)`);
  const seen = new Set(existing);
  for (const m of list) {
    const address = clean(m.address);
    if (!address.endsWith(`@${domain}`)) throw badRequest(`${address} is not on ${domain}`);
    const local = address.split("@")[0];
    if (local.replace(/[^a-z]/g, "").length < 2) throw badRequest(`${address} reads as automated. Use a real first name before the @.`);
    if (seen.has(address)) throw badRequest(`${address} is listed twice`);
    seen.add(address);
    try {
      localPartFor(m.firstName);
    } catch {
      throw badRequest(`"${m.firstName}" is too short for a sender name`);
    }
  }
}

async function personaFor(firstName: string, lastName: string | null | undefined, locale: string): Promise<string> {
  const name = firstName.trim();
  const region = PERSONA_SEED[locale]?.region ?? "global";
  const p = await prisma.persona.upsert({ where: { firstName_locale: { firstName: name, locale } }, create: { firstName: name, lastName: lastName?.trim() || null, locale, region }, update: {} });
  return p.id;
}

/** Stores the sign-in and checks it over SMTP and IMAP. A mailbox that cannot sign in is held back in ERROR. */
async function signIn(mailboxId: string, login?: { username?: string | null; password: string }): Promise<{ ok: boolean; error?: string }> {
  const m = await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
  const ref = m.credentialRef ?? mailboxCredentialRef(m.id);
  if (login) await secretStore().put(ref, JSON.stringify({ u: login.username?.trim() || m.address, p: login.password }));
  if (!m.credentialRef) await prisma.mailbox.update({ where: { id: m.id }, data: { credentialRef: ref } });
  let check: { smtp: boolean; imap: boolean; error?: string };
  try {
    check = await transportFor(m.transportRef).verify(await credsFor({ ...m, credentialRef: ref }));
  } catch (e) {
    check = { smtp: false, imap: false, error: (e as Error).message };
  }
  const ok = check.smtp && check.imap;
  const error = ok ? null : (check.error ?? (!check.smtp ? "SMTP sign-in failed" : "IMAP sign-in failed")).slice(0, 300);
  const waiting = m.status === "CONNECTING" || m.status === "ERROR";
  await prisma.mailbox.update({
    where: { id: m.id },
    data: { lastError: error, attempts: ok ? 0 : { increment: 1 }, ...(waiting ? { status: ok ? "CONNECTING" : "ERROR" } : {}) },
  });
  return ok ? { ok } : { ok, error: error ?? undefined };
}

async function createMailboxRow(domain: { id: string; region: string }, input: MailboxInput, locale: string) {
  const address = clean(input.address);
  const taken = await prisma.mailbox.findFirst({ where: { address, status: { not: "RETIRED" } }, select: { id: true } });
  if (taken) throw conflict(`${address} is already in the pool`);
  const m = await prisma.mailbox.create({
    data: {
      organizationId: null,
      sendingDomainId: domain.id,
      address,
      firstName: input.firstName.trim(),
      lastName: input.lastName?.trim() || null,
      fromNameDefault: [input.firstName.trim(), input.lastName?.trim()].filter(Boolean).join(" "),
      personaId: await personaFor(input.firstName, input.lastName, locale),
      provider: "manual",
      status: "CONNECTING",
      transportRef: transportRefFor(address),
      smtpHost: input.smtpHost.trim(),
      smtpPort: input.smtpPort,
      imapHost: input.imapHost.trim(),
      imapPort: input.imapPort,
      timezone: REGION_TZ[domain.region] ?? "UTC",
      dailyLimit: SENDS_PER_WARM_INBOX,
    },
  });
  return { id: m.id, address };
}

async function createMailbox(domain: { id: string; region: string }, input: MailboxInput, locale: string) {
  const m = await createMailboxRow(domain, input, locale);
  const r = await signIn(m.id, { username: input.username, password: input.password });
  return { ...m, ok: r.ok, error: r.error };
}

/** After a mailbox signs in on a warmed domain that is already live, it goes straight to full capacity. */
async function promoteIfWarmed(domainId: string): Promise<void> {
  const d = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: domainId }, select: { prewarmed: true, status: true } });
  if (d.prewarmed && d.status === "ACTIVE") await activateWarmed(domainId);
}

export async function addDomain(input: DomainInput, operatorId: string) {
  const name = clean(input.name).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!isValidDomain(name)) throw badRequest("That doesn't look like a domain, for example decoderhubs.com");
  if (!input.mailboxes.length) throw badRequest("Add at least one mailbox");
  if (await prisma.sendingDomain.findFirst({ where: { organizationId: null, name }, select: { id: true } })) throw conflict(`${name} is already in the pool`);
  checkMailboxes(name, input.mailboxes, []);

  const now = new Date();
  const domain = await prisma.sendingDomain.create({
    data: {
      organizationId: null,
      name,
      priceCents: 0,
      status: "REGISTERED",
      prewarmed: input.warmed,
      registrar: input.registrar?.trim() || "unknown",
      region: input.region,
      registeredAt: now,
      dkimSelector: input.dkimSelector?.trim() || null,
      agingUntil: input.warmed ? null : new Date(now.getTime() + 30 * 86_400_000),
    },
  });
  const rows = [];
  for (const m of input.mailboxes) rows.push(await createMailboxRow(domain, m, input.locale));
  // Every mailbox signs in at once. DNS is checked after, because a warmed domain whose DNS passes goes live with
  // the mailboxes that signed in.
  const mailboxes = await Promise.all(
    rows.map(async (row, i) => {
      const r = await signIn(row.id, { username: input.mailboxes[i].username, password: input.mailboxes[i].password });
      return { ...row, ok: r.ok, error: r.error };
    }),
  );
  const dns = await checkPoolDomain({ ...domain }, now);
  await closeFilledReorders();
  await invalidateConsole();
  await logSystem(null, "INFO", "pool", `${name} added by an operator as a ${input.warmed ? "warmed" : "new"} domain with ${mailboxes.length} mailbox${mailboxes.length === 1 ? "" : "es"}.`, { domainId: domain.id, operatorId });
  return { id: domain.id, name, dns, mailboxes };
}

export async function addMailbox(domainId: string, input: MailboxInput & { locale: string }, operatorId: string) {
  const d = await prisma.sendingDomain.findUnique({ where: { id: domainId }, include: { mailboxes: { where: { status: { not: "RETIRED" } }, select: { address: true } } } });
  if (!d || d.organizationId) throw notFound("Pool domain");
  if (d.status === "DEGRADED" || d.status === "RETIRED") throw conflict(`${d.name} is ${d.status.toLowerCase()} and takes no new mailboxes`);
  checkMailboxes(d.name, [input], d.mailboxes.map((m) => m.address));
  const m = await createMailbox(d, input, input.locale);
  if (m.ok) await promoteIfWarmed(d.id);
  await invalidateConsole();
  await logSystem(null, "INFO", "pool", `${m.address} added to ${d.name} by an operator.`, { domainId: d.id, operatorId });
  return m;
}

/** Signs a mailbox in again, with a new password when one is given. */
export async function testMailbox(mailboxId: string, login?: { username?: string | null; password: string }) {
  const m = await prisma.mailbox.findUnique({ where: { id: mailboxId }, select: { id: true, organizationId: true, sendingDomainId: true, status: true } });
  if (!m || m.organizationId) throw notFound("Pool mailbox");
  if (m.status === "RETIRED") throw conflict("This mailbox is retired");
  const r = await signIn(m.id, login);
  if (r.ok && m.sendingDomainId) await promoteIfWarmed(m.sendingDomainId);
  return r;
}

export async function checkDomainNow(domainId: string) {
  const d = await prisma.sendingDomain.findUnique({ where: { id: domainId } });
  if (!d || d.organizationId) throw notFound("Pool domain");
  const r = await checkPoolDomain(d);
  await invalidateConsole();
  return r;
}

export async function pauseDomain(domainId: string, reason: string, operatorId: string) {
  const d = await prisma.sendingDomain.findUnique({ where: { id: domainId } });
  if (!d || d.organizationId) throw notFound("Pool domain");
  await prisma.sendingDomain.update({ where: { id: d.id }, data: { pausedAt: new Date(), pauseReason: reason } });
  await logSystem(null, "WARN", "pool", `${d.name} paused by an operator: ${reason}.`, { domainId: d.id, operatorId });
  await invalidateConsole();
}

/** Stops new people on one mailbox; it still finishes the conversations already pinned to it. */
export async function mailboxRepliesOnly(mailboxId: string, operatorId: string) {
  const m = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!m || m.organizationId) throw notFound("Pool mailbox");
  if (m.status !== "ACTIVE" && m.status !== "WARMING") throw conflict(`This mailbox is ${m.status.toLowerCase().replace("_", " ")}`);
  await toRepliesOnly(m, "set by an operator");
  await logSystem(null, "INFO", "pool", `${m.address} set to replies only by an operator.`, { mailboxId: m.id, operatorId });
  await invalidateConsole();
}

export async function retireMailboxNow(mailboxId: string, operatorId: string) {
  const m = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
  if (!m || m.organizationId) throw notFound("Pool mailbox");
  if (m.status === "RETIRED") return;
  await retireMailbox(m, new Date(), "retired by an operator");
  await logSystem(null, "INFO", "pool", `${m.address} retired by an operator.`, { mailboxId: m.id, operatorId });
  await invalidateConsole();
}

export async function retireDomain(domainId: string, operatorId: string) {
  const d = await prisma.sendingDomain.findUnique({ where: { id: domainId }, include: { mailboxes: true } });
  if (!d || d.organizationId) throw notFound("Pool domain");
  const now = new Date();
  for (const m of d.mailboxes.filter((x) => x.status !== "RETIRED")) await retireMailbox(m, now, "its domain was retired by an operator");
  await prisma.sendingDomain.update({ where: { id: d.id }, data: { status: "RETIRED", retiredAt: now } });
  await logSystem(null, "INFO", "pool", `${d.name} retired by an operator.`, { domainId: d.id, operatorId });
  await invalidateConsole();
}

/** Every pool domain with its mailboxes, newest first. No password, ever. */
export async function listDomains() {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [domains, sends] = await Promise.all([
    prisma.sendingDomain.findMany({
      where: { organizationId: null },
      orderBy: [{ createdAt: "desc" }],
      include: { mailboxes: { orderBy: { address: "asc" }, include: { persona: { select: { locale: true } } } } },
    }),
    prisma.send.groupBy({ by: ["domainId"], where: { sentAt: { gte: since }, domainId: { not: null } }, _count: { _all: true } }),
  ]);
  const sent7 = new Map(sends.map((s) => [s.domainId, s._count._all]));
  const today = new Date().toISOString().slice(0, 10);
  return domains.map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    warmed: d.prewarmed,
    region: d.region,
    registrar: d.registrar,
    dns: { spf: d.spfOk, dkim: d.dkimOk, dmarc: d.dmarcOk, selector: d.dkimSelector, checkedAt: d.dnsCheckedAt },
    agingUntil: d.agingUntil,
    activatedAt: d.activatedAt,
    pausedAt: d.pausedAt,
    pauseReason: d.pauseReason,
    createdAt: d.createdAt,
    sent7: sent7.get(d.id) ?? 0,
    mailboxes: d.mailboxes.map((m) => ({
      id: m.id,
      address: m.address,
      name: m.fromNameDefault ?? m.firstName,
      locale: m.persona?.locale ?? null,
      status: m.status,
      warmupDay: m.warmupDay,
      capToday: m.sendCapToday,
      sentToday: m.sentTodayOn && m.sentTodayOn.toISOString().slice(0, 10) === today ? m.sentToday : 0,
      smtpHost: m.smtpHost,
      imapHost: m.imapHost,
      error: m.lastError,
    })),
  }));
}
