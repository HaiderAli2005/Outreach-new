import type { Mailbox, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logSystem } from "../systemLog.js";
import { secretStore } from "../../integrations/secrets.js";
import { AGING_DAYS, SENDS_PER_WARM_INBOX, WARMUP_DAYS_TO_ACTIVE, WARMUP_RAMP } from "../../config/plans.js";

/**
 * The shared pool's state machines. Every rule here acts on new cold emails only: a mailbox that stops taking new
 * people keeps sending follow-ups and replies to the people already pinned to it, until it is genuinely quiet.
 *
 * Health counts hard bounces and complaints only. Soft bounces (4xx) are temporary and never count.
 *
 *   Mailbox  WARMING --(warmup_day 29, bounce < 2%)--> ACTIVE
 *            ACTIVE | WARMING --(bounce > 5% over last 50 sends)--> REPLIES_ONLY
 *            REPLIES_ONLY --(no inbound reply on any pinned prospect for 30 days)--> RETIRED
 *   Domain   REGISTERED --(SPF, DKIM, DMARC resolve)--> AGING (30 days, sends nothing)
 *            AGING --(aged)--> WARMING (28 days on the ladder, real traffic) --(all mailboxes ACTIVE and our own
 *                   DKIM verified by the seed test)--> ACTIVE
 *            ACTIVE --(bounce > 5% over last 200 sends, or DKIM failing)--> DEGRADED (mailboxes go REPLIES_ONLY)
 *            DEGRADED --(all mailboxes RETIRED)--> RETIRED
 *
 * The warmup ladder is a CAP THAT RISES, nothing more. No warmup service, no bot network, no warmup sender: the
 * router already prefers each customer's least-used domain, a new domain is least used of all, and the ladder caps
 * how much real traffic it may take (5, 10, 20, then 30 a day). Every warmup email is a real, paid email.
 */

const DAY = 86_400_000;
/** Sends that reached a mailbox server one way or another. Queued and refused attempts are not sends. */
export const DELIVERED_OR_BOUNCED = ["SENT", "DELIVERED", "HARD_BOUNCE", "SOFT_BOUNCE", "COMPLAINT"] as const;

export const MAILBOX_WINDOW = 50;
export const DOMAIN_WINDOW = 200;
export const DEGRADE_RATE = 0.05;
export const ACTIVATE_MAX_RATE = 0.02;
export const WARMUP_HOLD_RATE = 0.03;
export const QUIET_DAYS = 30;

/** The daily cap for a warmup day: 5, 10, 20, then 30. */
export function capForWarmupDay(day: number): number {
  let cap = 0;
  for (const [from, c] of WARMUP_RAMP) if (day >= from) cap = c;
  return Math.min(cap, SENDS_PER_WARM_INBOX);
}

/** The first day of the level below this one (5 -> stays at 1, 10 -> 1, 20 -> 8, 30 -> 15). */
export function stepBack(day: number): number {
  const starts = WARMUP_RAMP.map(([from]) => from);
  const level = starts.filter((s) => day >= s).length - 1;
  return starts[Math.max(0, level - 1)] ?? 1;
}

/** A complaint is ten times worse than a bounce: 0.1% complaints is as bad as 1% bounces. */
export const COMPLAINT_WEIGHT = 10;

/**
 * What one send counts for in a health rate. Hard bounces 1, complaints 10, soft bounces nothing. An authentication
 * failure is our own fault: it counts against the sending domain only (countAuth), never a customer or an address.
 */
export function badWeight(status: string, countAuth = false): number {
  if (status === "HARD_BOUNCE") return 1;
  if (status === "COMPLAINT") return COMPLAINT_WEIGHT;
  if (status === "AUTH_FAILURE" && countAuth) return 1;
  return 0;
}

/** Weighted bad rate over the newest `n` real sends that match `where`. */
export async function windowRate(where: Prisma.SendWhereInput, n: number, opts: { countAuth?: boolean } = {}): Promise<{ sends: number; bad: number; rate: number }> {
  const statuses = [...DELIVERED_OR_BOUNCED, ...(opts.countAuth ? (["AUTH_FAILURE"] as const) : [])];
  const rows = await prisma.send.findMany({ where: { ...where, status: { in: statuses } }, orderBy: { sentAt: "desc" }, take: n, select: { status: true } });
  const bad = rows.reduce((a, r) => a + badWeight(r.status, opts.countAuth), 0);
  return { sends: rows.length, bad, rate: rows.length ? bad / rows.length : 0 };
}

export interface LifecycleReport {
  mailboxesActivated: number;
  mailboxesRepliesOnly: number;
  mailboxesRetired: number;
  warmupAdvanced: number;
  warmupHeld: number;
  warmupSteppedBack: number;
  domainsWarming: number;
  domainsActivated: number;
  domainsDegraded: number;
  domainsRetired: number;
}

const blank = (): LifecycleReport => ({ mailboxesActivated: 0, mailboxesRepliesOnly: 0, mailboxesRetired: 0, warmupAdvanced: 0, warmupHeld: 0, warmupSteppedBack: 0, domainsWarming: 0, domainsActivated: 0, domainsDegraded: 0, domainsRetired: 0 });

const pool = { organizationId: null } as const;

/** Moves a mailbox to REPLIES_ONLY: it keeps its pinned conversations and takes no new people. */
export async function toRepliesOnly(m: Pick<Mailbox, "id" | "address">, reason: string, now = new Date()): Promise<void> {
  const r = await prisma.mailbox.updateMany({ where: { id: m.id, status: { in: ["ACTIVE", "WARMING"] } }, data: { status: "REPLIES_ONLY", degradedAt: now, degradeReason: reason.slice(0, 300), sendCapToday: 0 } });
  if (r.count) await logSystem(null, "WARN", "pool", `${m.address} stopped taking new people: ${reason}. Conversations already on it carry on.`, { mailboxId: m.id });
}

// ─── 7.1 mailbox ────────────────────────────────────────────────────────────

/** Hourly. Pulls unhealthy mailboxes out of rotation and promotes warmed ones. */
export async function evaluateMailboxHealth(now = new Date()): Promise<LifecycleReport> {
  const report = blank();
  const live = await prisma.mailbox.findMany({ where: { ...pool, status: { in: ["ACTIVE", "WARMING"] } }, select: { id: true, address: true, status: true, warmupDay: true } });
  for (const m of live) {
    const w = await windowRate({ mailboxId: m.id }, MAILBOX_WINDOW);
    if (w.sends >= MAILBOX_WINDOW && w.rate > DEGRADE_RATE) {
      await toRepliesOnly(m, `${(w.rate * 100).toFixed(1)}% of its last ${w.sends} emails bounced`, now);
      report.mailboxesRepliesOnly++;
      continue;
    }
    if (m.status === "WARMING" && m.warmupDay >= WARMUP_DAYS_TO_ACTIVE && w.rate < ACTIVATE_MAX_RATE) {
      await prisma.mailbox.update({ where: { id: m.id }, data: { status: "ACTIVE", activatedAt: now, sendCapToday: SENDS_PER_WARM_INBOX } });
      report.mailboxesActivated++;
    }
  }
  return report;
}

/**
 * Hourly, acting once a day per mailbox in the mailbox's own time zone. First resets yesterday's count at local
 * midnight (not UTC, or a business-hours mailbox would spend its whole allowance in one burst at the boundary).
 * Then steps the ladder, judging the mailbox's last 50 sends:
 *
 *   under 3% hard bounces, and no authentication failure in 7 days  -> warmup_day + 1
 *   3% or more                                                      -> hold (a mailbox can sit at day 12 for weeks)
 *   5% or more                                                      -> back to the start of the previous band
 */
export async function advanceWarmup(now = new Date()): Promise<LifecycleReport> {
  const report = blank();
  await prisma.$executeRawUnsafe(
    `UPDATE "Mailbox" m SET "sentToday" = 0, "sentTodayOn" = (now() AT TIME ZONE m."timezone")::date
     WHERE m."organizationId" IS NULL AND (m."sentTodayOn" IS NULL OR m."sentTodayOn" < (now() AT TIME ZONE m."timezone")::date)`,
  );
  const due = await prisma.$queryRawUnsafe<{ id: string; warmupDay: number; localDay: Date }[]>(
    `SELECT m.id, m."warmupDay", (now() AT TIME ZONE m."timezone")::date AS "localDay" FROM "Mailbox" m
     WHERE m."organizationId" IS NULL AND m.status = 'WARMING'
       AND (m."warmupCheckedOn" IS NULL OR m."warmupCheckedOn" < (now() AT TIME ZONE m."timezone")::date)`,
  );
  for (const m of due) {
    const [w, authFail] = await Promise.all([
      windowRate({ mailboxId: m.id }, MAILBOX_WINDOW),
      prisma.send.findFirst({ where: { mailboxId: m.id, status: "AUTH_FAILURE", sentAt: { gte: new Date(now.getTime() - 7 * DAY) } }, select: { id: true } }),
    ]);
    let day = m.warmupDay;
    if (w.rate >= DEGRADE_RATE) {
      day = stepBack(day);
      report.warmupSteppedBack++;
    } else if (w.rate >= WARMUP_HOLD_RATE || authFail) {
      report.warmupHeld++;
    } else {
      day = Math.min(WARMUP_DAYS_TO_ACTIVE, day + 1);
      report.warmupAdvanced++;
    }
    await prisma.mailbox.update({ where: { id: m.id }, data: { warmupDay: day, sendCapToday: capForWarmupDay(day), warmupCheckedOn: m.localDay } });
  }
  return report;
}

/**
 * Daily. A REPLIES_ONLY mailbox still costs money every month, so it is retired as soon as it is quiet: nobody
 * pinned to it has replied in 30 days and its last sequence email went out over a week ago.
 */
export async function retireQuietMailboxes(now = new Date()): Promise<LifecycleReport> {
  const report = blank();
  const quietSince = new Date(now.getTime() - QUIET_DAYS * DAY);
  const candidates = await prisma.mailbox.findMany({ where: { ...pool, status: "REPLIES_ONLY" }, select: { id: true, address: true, providerId: true } });
  for (const m of candidates) {
    const [recentReply, recentSend] = await Promise.all([
      prisma.message.findFirst({ where: { direction: "INBOUND", createdAt: { gte: quietSince }, contact: { assignedMailboxId: m.id } }, select: { id: true } }),
      prisma.send.findFirst({ where: { mailboxId: m.id, sentAt: { gte: new Date(now.getTime() - 7 * DAY) } }, select: { id: true } }),
    ]);
    if (recentReply || recentSend) continue;
    await retireMailbox(m, now);
    report.mailboxesRetired++;
  }
  return report;
}

export async function retireMailbox(m: { id: string; address: string }, now = new Date(), why = `quiet for ${QUIET_DAYS} days`): Promise<void> {
  const row = await prisma.mailbox.findUnique({ where: { id: m.id }, select: { credentialRef: true, provider: true } });
  if (row?.credentialRef) await secretStore().remove(row.credentialRef).catch(() => undefined);
  await prisma.mailbox.update({ where: { id: m.id }, data: { status: "RETIRED", retiredAt: now, sendCapToday: 0 } });
  // A mailbox Aperture ordered is cancelled at its supplier by the next sync (inboxkit/sync.ts); any other one by hand.
  const cancel = row?.provider === "inboxkit" ? "Its InboxKit plan is cancelled automatically." : "Cancel it with its mail provider so it stops costing money.";
  await logSystem(null, "INFO", "pool", `${m.address} retired: ${why}. ${cancel}`, { mailboxId: m.id });
}

/** Where a supplier-warmed domain joins the ladder: day 8, 10 a day, then 20 and 30, a week each, then ACTIVE. */
export const SUPPLIER_WARMED_LADDER_DAY = 8;

/** A supplier-warmed domain whose warmup is done and healthy: it starts the ladder at 10 a day (inboxkit/sync.ts). */
export async function startSupplierWarmedLadder(domainId: string, now = new Date()): Promise<number> {
  const r = await prisma.sendingDomain.updateMany({ where: { id: domainId, status: "AGING", externalWarmup: true }, data: { status: "WARMING", warmupStartedAt: now, lastError: null } });
  if (!r.count) return 0;
  return startLadder({ domainId }, SUPPLIER_WARMED_LADDER_DAY);
}

// ─── 7.3 domain ─────────────────────────────────────────────────────────────

/**
 * Starts the ladder for a domain's connected mailboxes (or the ones given), at day 1 (cap 5 today) for a fresh domain.
 * A domain the supplier already warmed starts further up (day 8: 10 a day, then 20, then 30, a week each).
 */
async function startLadder(where: { domainId?: string; ids?: string[] }, day = 1): Promise<number> {
  const clause = where.domainId ? `m."sendingDomainId" = $1` : `m.id = ANY($1::text[])`;
  const start = Math.max(1, Math.min(WARMUP_DAYS_TO_ACTIVE - 1, Math.floor(day)));
  return prisma.$executeRawUnsafe(
    `UPDATE "Mailbox" m SET status = 'WARMING', "warmupDay" = ${start}, "sendCapToday" = ${capForWarmupDay(start)}, "warmupStartedAt" = now(),
       "warmupCheckedOn" = (now() AT TIME ZONE m."timezone")::date
     WHERE ${clause} AND m.status = 'CONNECTING' AND m."credentialRef" IS NOT NULL AND m."lastError" IS NULL`,
    where.domainId ?? where.ids ?? [],
  );
}

/** Pulls a domain out of rotation: it takes no new people, and its mailboxes keep their conversations. */
export async function degradeDomain(d: { id: string; name: string }, reason: string, now = new Date(), measured?: { rate: number; sends: number }): Promise<void> {
  const w = measured ?? (await windowRate({ domainId: d.id }, DOMAIN_WINDOW, { countAuth: true }));
  const r = await prisma.sendingDomain.updateMany({
    where: { id: d.id, status: { in: ["ACTIVE", "WARMING"] } },
    data: { status: "DEGRADED", degradedAt: now, degradeReason: reason.slice(0, 300), degradeBounceRate: Math.min(w.rate, 9.9999).toFixed(4), degradeSends: w.sends },
  });
  if (!r.count) return;
  const boxes = await prisma.mailbox.findMany({ where: { sendingDomainId: d.id, status: { in: ["ACTIVE", "WARMING"] } }, select: { id: true, address: true } });
  for (const m of boxes) await toRepliesOnly(m, `its domain ${d.name} degraded`, now);
  await logSystem(null, "WARN", "pool", `${d.name} degraded: ${reason}. Its mailboxes now serve replies only.`, { domainId: d.id });
}

/** Hourly. Ages, warms, activates, degrades and retires pool domains. */
export async function evaluateDomainHealth(now = new Date()): Promise<LifecycleReport> {
  const report = blank();

  // AGING -> WARMING: the quiet aging days are over and the domain's own SPF, DKIM and DMARC still resolve. A domain that
  // starts emailing days after registration looks like a throwaway spam domain, which is why it waits.
  // A domain the supplier warms (externalWarmup) leaves AGING through its own check instead (inboxkit/sync.ts), which
  // also needs the supplier's warmup to be healthy.
  const aged = await prisma.sendingDomain.findMany({ where: { ...pool, status: "AGING", externalWarmup: false, agingUntil: { lte: now }, spfOk: true, dkimOk: true, dmarcOk: true }, select: { id: true } });
  for (const d of aged) {
    await prisma.sendingDomain.update({ where: { id: d.id }, data: { status: "WARMING", warmupStartedAt: now } });
    await startLadder({ domainId: d.id });
    report.domainsWarming++;
  }
  // Mailboxes connected after their domain started warming start their own ladder at day 1.
  const late = await prisma.mailbox.findMany({ where: { ...pool, status: "CONNECTING", credentialRef: { not: null }, lastError: null, sendingDomain: { status: { in: ["WARMING", "ACTIVE"] }, prewarmed: false } }, select: { id: true, sendingDomain: { select: { externalWarmup: true } } } });
  const fresh = late.filter((m) => !m.sendingDomain?.externalWarmup).map((m) => m.id);
  const supplierWarmed = late.filter((m) => m.sendingDomain?.externalWarmup).map((m) => m.id);
  if (fresh.length) await startLadder({ ids: fresh });
  if (supplierWarmed.length) await startLadder({ ids: supplierWarmed }, SUPPLIER_WARMED_LADDER_DAY);
  // On a domain that came warmed, a newly signed-in mailbox goes straight to full capacity.
  await prisma.mailbox.updateMany({
    where: { ...pool, status: "CONNECTING", credentialRef: { not: null }, lastError: null, sendingDomain: { status: "ACTIVE", prewarmed: true } },
    data: { status: "ACTIVE", warmupDay: WARMUP_DAYS_TO_ACTIVE, sendCapToday: SENDS_PER_WARM_INBOX, dailyLimit: SENDS_PER_WARM_INBOX, warmupStartedAt: now, activatedAt: now },
  });

  // WARMING -> ACTIVE once every mailbox still in service is ACTIVE and the seed test has verified our own DKIM.
  // A domain whose signature does not verify must never carry full volume.
  const warming = await prisma.sendingDomain.findMany({ where: { ...pool, status: "WARMING" }, select: { id: true, dkimVerifiedAt: true, dkimOk: true, mailboxes: { select: { status: true } } } });
  for (const d of warming) {
    const inService = d.mailboxes.filter((m) => m.status !== "RETIRED");
    const dkimFresh = d.dkimOk && !!d.dkimVerifiedAt && now.getTime() - d.dkimVerifiedAt.getTime() < 3 * DAY;
    if (inService.length && inService.every((m) => m.status === "ACTIVE") && dkimFresh) {
      await prisma.sendingDomain.update({ where: { id: d.id }, data: { status: "ACTIVE", activatedAt: now } });
      report.domainsActivated++;
    }
  }

  // ACTIVE (or still warming) -> DEGRADED on 5% over its last 200 sends. Authentication failures count here, against
  // the domain, because they are the domain's (our) fault.
  const live = await prisma.sendingDomain.findMany({ where: { ...pool, status: { in: ["ACTIVE", "WARMING"] } }, select: { id: true, name: true } });
  for (const d of live) {
    const w = await windowRate({ domainId: d.id }, DOMAIN_WINDOW, { countAuth: true });
    if (w.sends < DOMAIN_WINDOW || w.rate <= DEGRADE_RATE) continue;
    await degradeDomain(d, `${(w.rate * 100).toFixed(1)}% of its last ${w.sends} emails bounced`, now, w);
    report.domainsDegraded++;
  }

  // DEGRADED -> RETIRED when nothing on it is left in service.
  const degraded = await prisma.sendingDomain.findMany({ where: { ...pool, status: "DEGRADED" }, select: { id: true, mailboxes: { select: { status: true } } } });
  for (const d of degraded) {
    if (d.mailboxes.every((m) => m.status === "RETIRED")) {
      await prisma.sendingDomain.update({ where: { id: d.id }, data: { status: "RETIRED", retiredAt: now } });
      report.domainsRetired++;
    }
  }
  return report;
}

/** A newly bought pool domain: DNS is set, so it starts its quiet aging period. */
export function agingUntilFrom(start: Date): Date {
  return new Date(start.getTime() + AGING_DAYS * DAY);
}
