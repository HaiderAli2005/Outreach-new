import { Resolver } from "node:dns/promises";
import { createPublicKey, randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { secretStore } from "../../integrations/secrets.js";
import { logSystem } from "../systemLog.js";
import { credsFor, transportFor } from "../sending/transport/index.js";
import { buildOutbound, newMessageId } from "../sending/message.js";
import { countSend } from "../sending/pool.js";
import { parseInbound } from "../sending/inbound.js";
import { degradeDomain } from "./lifecycle.js";
import { onDnsReady } from "./restock.js";

/**
 * Our own authentication, checked every day. A domain whose own signature does not verify must never carry real
 * volume: an unsigned domain burns fast.
 *
 *   verifyDomainDns   SPF, DKIM (a key of at least 1024 bits) and DMARC records resolve. A newly added domain moves
 *                     from REGISTERED on only once all three do (to AGING, or straight to ACTIVE if it came warmed);
 *                     an ACTIVE domain that loses DKIM degrades.
 *   seedInboxTest     one real message a day per sending domain to a mailbox we control on another provider, read
 *                     back over IMAP, and its Authentication-Results checked for spf=pass, dkim=pass, dmarc=pass.
 *                     Without a pass, a domain cannot leave WARMING; an ACTIVE domain that fails degrades at once.
 */

const COMMON_SELECTORS = ["default", "google", "selector1", "selector2", "s1", "s2", "mail", "dkim", "k1", "zoho", "zmail"];

type TxtResolver = (name: string) => Promise<string[][]>;

/**
 * DNS lookups with a time limit. The machine's own DNS servers answer first; when they do not answer at all (a
 * timeout or a refused connection, common on Windows with a VPN or an IPv6-only DNS server), the same question goes
 * to public resolvers. Without the limit one silent server holds an operator's request for minutes.
 */
const DNS_TIMEOUT_MS = 2_500;
const systemDns = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
const publicDns = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
publicDns.setServers(["1.1.1.1", "8.8.8.8"]);
const NO_ANSWER = new Set(["ETIMEOUT", "ECONNREFUSED", "EREFUSED", "ESERVFAIL", "ECANCELLED", "EBADRESP", "ECONNRESET", "EFILE"]);

async function boundedTxt(name: string): Promise<string[][]> {
  try {
    return await systemDns.resolveTxt(name);
  } catch (e) {
    if (!NO_ANSWER.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
    return publicDns.resolveTxt(name);
  }
}

let resolver: TxtResolver = boundedTxt;
export function setTxtResolver(r: TxtResolver | null): void {
  resolver = r ?? boundedTxt;
}

// ─── footprint: who the domain depends on ───────────────────────────────────

type NsResolver = (name: string) => Promise<string[]>;
async function boundedNs(name: string): Promise<string[]> {
  try {
    return await systemDns.resolveNs(name);
  } catch (e) {
    if (!NO_ANSWER.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
    return publicDns.resolveNs(name);
  }
}
let nsResolver: NsResolver = boundedNs;
export function setNsResolver(r: NsResolver | null): void {
  nsResolver = r ?? boundedNs;
}

/** The registrar of record, read from public RDAP (the registry's own lookup service). */
type RegistrarLookup = (domain: string) => Promise<string | null>;
async function rdapRegistrar(domain: string): Promise<string | null> {
  const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { accept: "application/rdap+json" }, signal: AbortSignal.timeout(6_000) });
  if (!res.ok) return null;
  const body = (await res.json()) as { entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, unknown][]] }[] };
  const reg = body.entities?.find((e) => e.roles?.includes("registrar"));
  const fn = reg?.vcardArray?.[1]?.find((f) => f[0] === "fn")?.[3];
  return typeof fn === "string" && fn.trim() ? fn.trim().slice(0, 60) : null;
}
let registrarLookup: RegistrarLookup = rdapRegistrar;
export function setRegistrarLookup(r: RegistrarLookup | null): void {
  registrarLookup = r ?? rdapRegistrar;
}

const baseDomain = (host: string) => host.toLowerCase().replace(/\.$/, "").split(".").slice(-2).join(".");

const NS_PROVIDERS: [RegExp, string][] = [
  [/cloudflare\.com$/, "Cloudflare"],
  [/domaincontrol\.com$/, "GoDaddy"],
  [/registrar-servers\.com$/, "Namecheap"],
  [/porkbun\.com$/, "Porkbun"],
  [/awsdns/, "AWS Route 53"],
  [/googledomains\.com$|google\.com$/, "Google Cloud DNS"],
  [/dynadot\.com$/, "Dynadot"],
  [/dns-parking\.com$|hostinger/, "Hostinger"],
  [/azure-dns/, "Azure DNS"],
  [/name\.com$/, "Name.com"],
  [/nsone\.net$/, "NS1"],
];

/** Who runs a domain's DNS, from its NS records: a known provider's name, or the nameservers' own domain. */
export function nameserverProvider(ns: string[]): string | null {
  const host = ns.map((n) => n.toLowerCase().replace(/\.$/, "")).sort()[0];
  if (!host) return null;
  return NS_PROVIDERS.find(([re]) => re.test(host))?.[1] ?? baseDomain(host);
}

/** Whose servers a mailbox sends through, from its SMTP host. */
export function mailHostProvider(smtpHost: string | null): string | null {
  if (!smtpHost) return null;
  const h = smtpHost.toLowerCase();
  if (/gmail\.com$|google\.com$|googlemail\.com$/.test(h)) return "Google";
  if (/office365\.com$|outlook\.com$|microsoft/.test(h)) return "Microsoft";
  if (/zoho\./.test(h)) return "Zoho";
  return baseDomain(h);
}

/**
 * Fills in the registrar, the DNS provider and the sending servers by looking them up, so the footprint view needs
 * no typing. A registrar an operator typed is never overwritten. Any lookup that fails leaves the old value.
 */
export async function detectFootprint(domainId: string): Promise<void> {
  const d = await prisma.sendingDomain.findUnique({ where: { id: domainId }, select: { name: true, registrar: true, nameserverSet: true, ipPoolId: true, mailboxes: { where: { status: { not: "RETIRED" } }, select: { smtpHost: true } } } });
  if (!d) return;
  const [ns, registrar] = await Promise.all([
    nsResolver(d.name).catch(() => [] as string[]),
    !d.registrar || d.registrar === "unknown" ? registrarLookup(d.name).catch(() => null) : Promise.resolve(null),
  ]);
  const counts = new Map<string, number>();
  for (const m of d.mailboxes) {
    const p = mailHostProvider(m.smtpHost);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const servers = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const dnsBy = nameserverProvider(ns);
  const data = {
    ...(registrar ? { registrar } : {}),
    ...(dnsBy && dnsBy !== d.nameserverSet ? { nameserverSet: dnsBy } : {}),
    ...(servers && servers !== d.ipPoolId ? { ipPoolId: servers } : {}),
  };
  if (Object.keys(data).length) await prisma.sendingDomain.update({ where: { id: domainId }, data });
}

async function txt(name: string): Promise<string[]> {
  try {
    return (await resolver(name)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

/** Bits of the RSA key in a DKIM record ("v=DKIM1; k=rsa; p=MIIB..."), or 0 when there is none. */
export function dkimKeyBits(record: string): number {
  const p = record.match(/(?:^|;)\s*p=([A-Za-z0-9+/=\s]+)/)?.[1]?.replace(/\s+/g, "");
  if (!p) return 0;
  try {
    const key = createPublicKey({ key: Buffer.from(p, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyDetails?.modulusLength ?? 0;
  } catch {
    return 0;
  }
}

export async function checkDomainDns(domain: string, selectors: string[]): Promise<{ spf: boolean; dkim: boolean; dmarc: boolean; selector: string | null }> {
  // Every lookup at once, so the whole check takes as long as the slowest single answer.
  const [root, dmarc, ...keys] = await Promise.all([txt(domain), txt(`_dmarc.${domain}`), ...selectors.map((s) => txt(`${s}._domainkey.${domain}`))]);
  const spf = root.some((r) => /^v=spf1\b/i.test(r.trim()));
  const dmarcOk = dmarc.some((r) => /^v=DMARC1\b/i.test(r.trim()));
  const found = keys.findIndex((recs) => recs.some((r) => dkimKeyBits(r) >= 1024));
  const selector = found >= 0 ? selectors[found] : null;
  return { spf, dkim: !!selector, dmarc: dmarcOk, selector };
}

/** Checks one pool domain's SPF, DKIM and DMARC records now, and moves it on when they pass. */
export async function checkPoolDomain(
  d: { id: string; name: string; status: string; dkimSelector: string | null; dnsVerifiedAt: Date | null },
  now = new Date(),
): Promise<{ spf: boolean; dkim: boolean; dmarc: boolean; moved: "active" | "aging" | null }> {
  const [r] = await Promise.all([checkDomainDns(d.name, [...(d.dkimSelector ? [d.dkimSelector] : []), ...COMMON_SELECTORS]), detectFootprint(d.id).catch(() => undefined)]);
  const ok = r.spf && r.dkim && r.dmarc;
  await prisma.sendingDomain.update({ where: { id: d.id }, data: { spfOk: r.spf, dkimOk: r.dkim, dmarcOk: r.dmarc, dkimSelector: r.selector ?? d.dkimSelector, dnsCheckedAt: now, ...(ok && !d.dnsVerifiedAt ? { dnsVerifiedAt: now } : {}) } });
  let moved: "active" | "aging" | null = null;
  if (d.status === "REGISTERED" && ok) {
    moved = await onDnsReady(d.id, now);
  } else if (d.status === "ACTIVE" && !r.dkim) {
    await degradeDomain(d, "its DKIM record no longer resolves", now);
  } else if (!ok && d.status !== "REGISTERED") {
    await logSystem(null, "ERROR", "pool", `${d.name}: ${[!r.spf && "SPF", !r.dkim && "DKIM", !r.dmarc && "DMARC"].filter(Boolean).join(", ")} not found in DNS. It takes no new people until fixed.`, { domainId: d.id });
  }
  return { spf: r.spf, dkim: r.dkim, dmarc: r.dmarc, moved };
}

/** Daily. Checks every pool domain's SPF, DKIM and DMARC records. */
export async function verifyDomainDns(now = new Date()): Promise<{ checked: number; aging: number; failing: number }> {
  const domains = await prisma.sendingDomain.findMany({
    where: { organizationId: null, status: { in: ["REGISTERED", "AGING", "WARMING", "ACTIVE"] }, OR: [{ dnsCheckedAt: null }, { dnsCheckedAt: { lt: new Date(now.getTime() - 20 * 3_600_000) } }, { status: "REGISTERED" }] },
  });
  let aging = 0;
  let failing = 0;
  for (const d of domains) {
    const r = await checkPoolDomain(d, now);
    if (!(r.spf && r.dkim && r.dmarc)) failing++;
    if (r.moved) aging++;
  }
  return { checked: domains.length, aging, failing };
}

/** spf=pass, dkim=pass (signed by this domain) and dmarc=pass in a received message's Authentication-Results. */
export function readAuthResults(headers: string, domain: string): { spf: boolean; dkim: boolean; dmarc: boolean; signedBy: string | null } {
  const ar = (headers.match(/^authentication-results:[^\n]*(\n[ \t][^\n]*)*/gim) ?? []).join(" ").replace(/\s+/g, " ").toLowerCase();
  const d = domain.toLowerCase();
  const dkimPasses = [...ar.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g)].map((m) => m[1]);
  const signedBy = dkimPasses.find((x) => x === d || x.endsWith(`.${d}`)) ?? dkimPasses[0] ?? null;
  return { spf: /\bspf=pass\b/.test(ar), dkim: !!signedBy && (signedBy === d || signedBy.endsWith(`.${d}`)), dmarc: /\bdmarc=pass\b/.test(ar), signedBy };
}

/** Daily. Reads yesterday's seed messages back, then sends today's. */
export async function seedInboxTest(now = new Date()): Promise<{ read: number; passed: number; failed: number; sent: number; skipped?: string }> {
  if (!env.SEED_MAILBOX_ADDRESS) return { read: 0, passed: 0, failed: 0, sent: 0, skipped: "SEED_MAILBOX_ADDRESS is not set" };
  const store = secretStore();
  const password = await store.get("seed");
  if (!password) return { read: 0, passed: 0, failed: 0, sent: 0, skipped: "no seed mailbox password in the secret store (key: seed)" };
  const seed = { address: env.SEED_MAILBOX_ADDRESS, username: env.SEED_MAILBOX_ADDRESS, password, smtpHost: "", smtpPort: 0, imapHost: env.SEED_IMAP_HOST, imapPort: env.SEED_IMAP_PORT };

  // 1. Read back what came in.
  let read = 0;
  let passed = 0;
  let failed = 0;
  const lastUid = Number((await store.get("seed:last-uid")) ?? 0);
  const waiting = await prisma.sendingDomain.findMany({ where: { organizationId: null, seedToken: { not: null } } });
  if (waiting.length) {
    const msgs = await transportFor("smtp:seed").fetchNew(seed, lastUid, 500);
    let maxUid = lastUid;
    for (const m of msgs) {
      maxUid = Math.max(maxUid, m.uid);
      const p = await parseInbound(m.source);
      const d = waiting.find((w) => w.seedToken && (p.subject.includes(w.seedToken) || p.text.includes(w.seedToken)));
      if (!d) continue;
      read++;
      const headers = p.raw.slice(0, Math.max(0, p.raw.search(/\r?\n\r?\n/)));
      const r = readAuthResults(headers, d.name);
      const ok = r.spf && r.dkim && r.dmarc;
      ok ? passed++ : failed++;
      await prisma.sendingDomain.update({
        where: { id: d.id },
        data: { seedToken: null, seedResult: `spf=${r.spf ? "pass" : "fail"} dkim=${r.dkim ? "pass" : "fail"}${r.signedBy ? ` (d=${r.signedBy})` : ""} dmarc=${r.dmarc ? "pass" : "fail"}`, ...(ok ? { dkimVerifiedAt: now } : {}), ...(r.dkim ? {} : { dkimOk: false }) },
      });
      if (!r.dkim && d.status === "ACTIVE") await degradeDomain(d, "its own DKIM signature failed the daily seed check", now);
      else if (!ok) await logSystem(null, "ERROR", "pool", `${d.name} failed the daily seed check (${r.spf ? "" : "SPF "}${r.dkim ? "" : "DKIM "}${r.dmarc ? "" : "DMARC"}). It cannot leave warmup until it passes.`, { domainId: d.id });
    }
    if (maxUid > lastUid) await store.put("seed:last-uid", String(maxUid));
  }

  // 2. Send today's. Only domains that send anyway (AGING sends nothing at all).
  const due = await prisma.sendingDomain.findMany({
    where: { organizationId: null, status: { in: ["WARMING", "ACTIVE"] }, pausedAt: null, OR: [{ seedTestAt: null }, { seedTestAt: { lt: new Date(now.getTime() - 20 * 3_600_000) } }] },
    include: { mailboxes: { where: { status: { in: ["ACTIVE", "WARMING", "REPLIES_ONLY"] }, credentialRef: { not: null } }, take: 1 } },
  });
  let sent = 0;
  for (const d of due) {
    const m = d.mailboxes[0];
    if (!m) continue;
    const token = randomUUID().slice(0, 12);
    try {
      const r = await transportFor(m.transportRef).send(
        await credsFor(m),
        buildOutbound({ fromName: m.fromNameDefault ?? m.address.split("@")[0], fromAddress: m.address, to: env.SEED_MAILBOX_ADDRESS, subject: `Check ${token}`, body: `Daily delivery check ${token}.`, messageId: newMessageId(m.address), unsubscribeUrl: `https://${d.name}/u/seed` }),
      );
      await countSend(m.id);
      if (r.outcome === "SENT") {
        await prisma.sendingDomain.update({ where: { id: d.id }, data: { seedToken: token, seedTestAt: now } });
        sent++;
      }
    } catch (e) {
      logger.warn({ domain: d.name, err: (e as Error).message }, "seed send failed");
    }
  }
  return { read, passed, failed, sent };
}


