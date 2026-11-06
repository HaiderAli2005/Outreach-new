import type { Mailbox, SendingDomain } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { logger } from "../../../lib/logger.js";
import { withLock } from "../../../lib/locks.js";
import { addWarmup, cancelMailboxes, cancelWarmup, listAllDomains, listAllMailboxes, listWarmups, mailboxCredentials, MAILBOX_DEAD, type IkDomain, type IkMailbox, type InboxKitCtx, type Warmup } from "../../../integrations/inboxkit.js";
import { logSystem } from "../../systemLog.js";
import { checkPoolDomain } from "../auth.js";
import { startSupplierWarmedLadder, toRepliesOnly } from "../lifecycle.js";
import { signIn } from "../manual.js";
import { invalidateConsole } from "../metrics.js";
import { DOMAIN_DEAD, expireQuotes, placeDue, reconcilePlacing, repairPlaced, withPlaceLock } from "./orders.js";
import { inboxKitKey, inboxKitSettings, INBOXKIT_PROVIDER, SUPPLIER } from "./settings.js";

/**
 * Keeps every domain Aperture ordered through InboxKit moving, from the order to the ladder, and back out again:
 *
 *   ordered      InboxKit registers the domain and builds its mailboxes          (mailboxes CREATING)
 *   signed in    each mailbox active at InboxKit: Aperture takes its app password from the API, signs in over SMTP and
 *                IMAP, and keeps the password in the secret store                 (CONNECTING)
 *   DNS          SPF, DKIM and DMARC resolve                                      (domain AGING, sends nothing)
 *   warming      InboxKit's warmup network warms every mailbox for warmupDays (28), counted from when warmup really
 *                started; its health is read every sync                           (AGING until agingUntil)
 *   ladder       warmup done and healthy: the ladder starts at 10 a day, then 20, then 30, a week each
 *   live         ACTIVE at 30 a day, InboxKit warmup kept on alongside (or cancelled, per settings)
 *   retired      a burned mailbox retires once its conversations are quiet (lifecycle.ts); its InboxKit plan is then
 *                cancelled here so it stops being billed
 *
 * It runs every 10 minutes, and a minute after any InboxKit webhook. It is safe to run any number of times: every step
 * reads InboxKit's current state and only moves things forward.
 */

const MIN = 60_000;
const DAY = 86_400_000;
/** The lowest InboxKit warmup inbox rate that lets a domain start sending. */
const MIN_INBOX_RATE = 80;
/**
 * A new mailbox's app password can take hours before Google or Microsoft accept it over SMTP and IMAP, so sign-in is
 * retried at every sync for 3 days after the order (and 6 times after that) before it is left for an operator.
 */
const SIGN_IN_PATIENCE = 3 * DAY;
const MAX_SIGN_IN_ATTEMPTS = 6;
/** Warmup the order should have booked but InboxKit doesn't show after this long is booked again. */
const WARMUP_GRACE = DAY;
/** A mailbox InboxKit hasn't created after this long is flagged for an operator. */
const CREATE_PATIENCE = 3 * DAY;
/** Warmup health good enough to start sending. */
const GOOD_HEALTH = ["excellent", "good"];

export interface SyncReport {
  skipped?: string;
  placed: number;
  adopted: number;
  signedIn: number;
  signInFailed: number;
  warmupsRead: number;
  laddered: number;
  held: number;
  cancelled: number;
  problems: number;
}

const blank = (): SyncReport => ({ placed: 0, adopted: 0, signedIn: 0, signInFailed: 0, warmupsRead: 0, laddered: 0, held: 0, cancelled: 0, problems: 0 });

type DomainRow = SendingDomain & { mailboxes: Mailbox[] };

/** Takes InboxKit's app password for an active mailbox and signs it in. The password never leaves the secret store. */
async function connectMailbox(ctx: InboxKitCtx, m: Mailbox, ik: IkMailbox, report: SyncReport): Promise<void> {
  try {
    const creds = await mailboxCredentials(ctx, ik.uid);
    const password = creds.appPassword ?? creds.password;
    if (!password) return; // Not issued yet; next sync.
    // signIn stores the password first and only then the reference to it, so a mailbox never looks signed in without one.
    if (m.status === "CREATING") await prisma.mailbox.update({ where: { id: m.id }, data: { status: "CONNECTING" } });
    const r = await signIn(m.id, { username: m.address, password });
    if (r.ok) report.signedIn++;
    else report.signInFailed++;
  } catch (e) {
    logger.warn({ mailboxId: m.id, err: (e as Error).message }, "inboxkit: could not sign a mailbox in");
    await prisma.mailbox.update({ where: { id: m.id }, data: { status: "ERROR", lastError: `Couldn't sign in with InboxKit's password yet: ${(e as Error).message}`.slice(0, 300), attempts: { increment: 1 } } }).catch(() => undefined);
    report.signInFailed++;
  }
}

/** InboxKit says a mailbox is suspended, failed or gone. One that sends stops taking new people; one in setup fails. */
async function mailboxGone(m: Mailbox, ik: IkMailbox, report: SyncReport): Promise<void> {
  const why = `InboxKit reports it ${ik.status.replace(/_/g, " ")}`;
  if (m.status === "ACTIVE" || m.status === "WARMING") {
    await toRepliesOnly(m, why);
    report.problems++;
  } else if (m.status === "CREATING" || m.status === "CONNECTING") {
    await prisma.mailbox.update({ where: { id: m.id }, data: { status: "ERROR", lastError: why } });
    await logSystem(null, "ERROR", "pool", `${m.address}: ${why} before it was ready. Ask InboxKit support or retire it.`, { mailboxId: m.id });
    report.problems++;
  }
}

/** A domain's supplier warmup counts from when its last mailbox's warmup started, so every mailbox gets the full time. */
function warmupStart(boxes: Mailbox[], byMailbox: Map<string, Warmup>): Date | null {
  const live = boxes.filter((b) => b.status !== "RETIRED" && b.status !== "ERROR");
  if (!live.length) return null;
  let latest: Date | null = null;
  for (const b of live) {
    const w = (b.providerId && byMailbox.get(b.providerId)) || byMailbox.get(b.address);
    if (!w?.startedAt) return null;
    const t = new Date(w.startedAt);
    if (Number.isNaN(t.getTime())) return null;
    if (!latest || t > latest) latest = t;
  }
  return latest;
}

/** Why a supplier-warmed domain may not start the ladder yet, or null when it may. */
export function holdReason(d: Pick<SendingDomain, "agingUntil" | "spfOk" | "dkimOk" | "dmarcOk">, boxes: Pick<Mailbox, "status" | "credentialRef" | "lastError" | "warmupHealth" | "warmupInboxRate" | "address" | "supplierWarmupStatus">[], now = new Date()): string | null {
  if (!d.agingUntil) return "InboxKit warmup hasn't started on every mailbox yet";
  if (d.agingUntil > now) return `InboxKit warmup runs until ${d.agingUntil.toISOString().slice(0, 10)}`;
  if (!(d.spfOk && d.dkimOk && d.dmarcOk)) return "SPF, DKIM or DMARC is not passing";
  const live = boxes.filter((b) => b.status !== "RETIRED");
  if (!live.length) return "no mailbox left on it";
  const notReady = live.filter((b) => b.status !== "CONNECTING" || !b.credentialRef || b.lastError);
  if (notReady.length) return `not every mailbox is ready: ${notReady.map((b) => `${b.address} (${b.lastError ?? b.status.toLowerCase().replace(/_/g, " ")})`).join(", ")}. Fix or retire it and the domain carries on`;
  const notWarming = live.filter((b) => b.supplierWarmupStatus !== "active");
  if (notWarming.length) return `InboxKit warmup isn't running on ${notWarming.map((b) => `${b.address} (${(b.supplierWarmupStatus ?? "none").replace(/_/g, " ")})`).join(", ")}`;
  const unhealthy = live.filter((b) => !b.warmupHealth || !GOOD_HEALTH.includes(b.warmupHealth) || (b.warmupInboxRate !== null && Number(b.warmupInboxRate) < MIN_INBOX_RATE));
  if (unhealthy.length) return `InboxKit warmup health is low on ${unhealthy.map((b) => `${b.address} (${b.warmupHealth ?? "?"}, inbox ${b.warmupInboxRate === null ? "?" : `${Number(b.warmupInboxRate).toFixed(0)}%`})`).join(", ")}`;
  return null;
}

/**
 * The work itself, without a lock: the job runner already holds "job:inboxkit-sync" around it. Anything else (the
 * admin "Sync now" button, webhooks) calls `syncInboxKit`, which takes that same lock.
 */
export async function runSync(now = new Date()): Promise<SyncReport> {
  const report = blank();
  const { key } = await inboxKitKey();
  const s = await inboxKitSettings();
  if (!key || !s.workspaceUid) return { ...report, skipped: "InboxKit is not set up" };
  const ctx: InboxKitCtx = { key, workspace: s.workspaceUid };

  await expireQuotes(now);
  try {
    const placedNow = await withPlaceLock(() => placeDue(now));
    report.placed = placedNow.ran ? placedNow.result.placed : 0;
  } catch (e) {
    logger.error({ err: (e as Error).message }, "inboxkit: placing due batches failed");
  }
  await repairPlaced(now);

  const domains: DomainRow[] = await prisma.sendingDomain.findMany({ where: { organizationId: null, supplier: SUPPLIER, status: { not: "RETIRED" } }, include: { mailboxes: true } });
  const unconfirmed = await prisma.supplierOrderItem.count({ where: { OR: [{ status: "PLACING" }, { status: "REJECTED", message: { startsWith: "InboxKit never confirmed" } }] } });
  const retiredToCancel = await prisma.mailbox.findMany({ where: { provider: INBOXKIT_PROVIDER, status: "RETIRED", supplierCancelRequestedAt: null }, select: { id: true, providerId: true, address: true } });
  if (!domains.length && !unconfirmed && !retiredToCancel.length) return report;

  // 1. What InboxKit has: domains, mailboxes and warmups, read once each.
  const [ikDomains, ikMailboxes, warmups] = await Promise.all([listAllDomains(ctx), listAllMailboxes(ctx), domains.length ? listWarmups(ctx) : Promise.resolve([] as Warmup[])]);
  const domainByName = new Map<string, IkDomain>(ikDomains.map((d) => [d.name, d]));
  const mailboxByEmail = new Map<string, IkMailbox>(ikMailboxes.map((m) => [m.email, m]));
  const warmupByMailbox = new Map<string, Warmup>();
  for (const w of warmups) {
    if (w.mailboxUid) warmupByMailbox.set(w.mailboxUid, w);
    if (w.email) warmupByMailbox.set(w.email, w);
  }
  report.warmupsRead = warmups.length;
  // A domain counts as at InboxKit when it is in either list (a new one can show its mailboxes first).
  report.adopted = (await reconcilePlacing(new Set([...domainByName.keys(), ...ikMailboxes.map((m) => m.domain)]), now)).adopted;

  const missingWarmup: string[] = [];
  for (const d of domains) {
    // 2. The domain itself.
    const ikd = domainByName.get(d.name);
    if (ikd) {
      if (ikd.uid !== d.providerId || ikd.status !== d.providerStatus) await prisma.sendingDomain.update({ where: { id: d.id }, data: { providerId: ikd.uid, providerStatus: ikd.status } });
      if (DOMAIN_DEAD.includes(ikd.status) && ikd.status !== d.providerStatus) {
        await logSystem(null, "ERROR", "pool", `${d.name}: InboxKit reports the domain ${ikd.status.replace(/_/g, " ")}. It will not finish setting up; retire it or ask InboxKit support.`, { domainId: d.id });
        await prisma.mailbox.updateMany({ where: { sendingDomainId: d.id, status: "CREATING" }, data: { status: "ERROR", lastError: `InboxKit reports its domain ${ikd.status.replace(/_/g, " ")}` } });
        report.problems++;
      }
    }

    // 3. Its mailboxes: ids and states, sign-in once InboxKit has them ready, warmup health.
    for (const m of d.mailboxes) {
      if (m.status === "RETIRED") continue;
      const ik = mailboxByEmail.get(m.address);
      if (!ik) {
        if (m.status === "CREATING" && now.getTime() - m.createdAt.getTime() > CREATE_PATIENCE && !m.lastError) {
          await prisma.mailbox.update({ where: { id: m.id }, data: { lastError: "InboxKit hasn't created this mailbox after 3 days. Check the order in InboxKit." } });
          await logSystem(null, "WARN", "pool", `${m.address}: InboxKit hasn't created it after 3 days. Check the order in InboxKit.`, { mailboxId: m.id });
          report.problems++;
        }
        continue;
      }
      const w = warmupByMailbox.get(ik.uid) ?? warmupByMailbox.get(m.address);
      await prisma.mailbox.update({
        where: { id: m.id },
        data: {
          providerId: ik.uid,
          providerStatus: ik.status,
          supplierSyncedAt: now,
          // No subscription listed any more means no warmup: say so, so nothing reads an old "active".
          ...(w
            ? { supplierWarmupStatus: w.status, warmupHealth: w.health, warmupScore: w.score === null ? null : w.score.toFixed(2), warmupInboxRate: w.inboxRate === null ? null : w.inboxRate.toFixed(2), supplierWarmupDay: w.day }
            : { supplierWarmupStatus: "none", warmupHealth: null, warmupScore: null, warmupInboxRate: null }),
        },
      });
      if ((MAILBOX_DEAD as readonly string[]).includes(ik.status)) {
        if (m.status !== "REPLIES_ONLY" && m.status !== "ERROR") await mailboxGone(m, ik, report);
        continue;
      }
      if (ik.status === "active") {
        const patient = now.getTime() - m.createdAt.getTime() < SIGN_IN_PATIENCE || m.attempts < MAX_SIGN_IN_ATTEMPTS;
        const needsSignIn = m.status === "CREATING" || (m.status === "ERROR" && patient) || (m.status === "CONNECTING" && !m.credentialRef);
        if (needsSignIn) await connectMailbox(ctx, m, ik, report);
        // Warmup was paid for with the order; book it again only if InboxKit still doesn't show it a day later, and
        // only before the domain sends (once it sends, a missing warmup was cancelled on purpose).
        const beforeSending = (d.status === "REGISTERED" || d.status === "AGING") && (m.status === "CREATING" || m.status === "CONNECTING" || m.status === "ERROR");
        if (d.externalWarmup && !w && beforeSending && now.getTime() - d.createdAt.getTime() > WARMUP_GRACE) missingWarmup.push(ik.uid);
      }
    }

    // 4. DNS: InboxKit sets the records; once they resolve the domain waits in AGING for its warmup.
    const load = () => prisma.sendingDomain.findUniqueOrThrow({ where: { id: d.id }, include: { mailboxes: true } });
    let fresh = await load();
    if (fresh.status === "REGISTERED" && fresh.mailboxes.some((b) => b.status !== "CREATING")) {
      await checkPoolDomain(fresh, now).catch((e: Error) => logger.warn({ domain: d.name, err: e.message }, "inboxkit: DNS check failed"));
      fresh = await load();
    }

    // 5. Warmup clock: from when InboxKit's warmup actually started on every mailbox, so each gets the full time.
    const clock: { supplierWarmupAt?: Date; agingUntil?: Date } = {};
    const started = fresh.externalWarmup ? warmupStart(fresh.mailboxes, warmupByMailbox) : null;
    if (started) {
      const until = new Date(started.getTime() + (fresh.warmupTargetDays ?? s.warmupDays) * DAY);
      if (fresh.supplierWarmupAt?.getTime() !== started.getTime()) clock.supplierWarmupAt = started;
      if (fresh.status === "AGING" && fresh.agingUntil?.getTime() !== until.getTime()) clock.agingUntil = until;
    }
    await prisma.sendingDomain.update({ where: { id: d.id }, data: { supplierSyncedAt: now, ...clock } });

    // 6. Warmup done and healthy: join the ladder at 10 a day.
    const current = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d.id }, include: { mailboxes: true } });
    if (current.status === "AGING" && current.externalWarmup) {
      const hold = holdReason(current, current.mailboxes, now);
      if (!hold) {
        const n = await startSupplierWarmedLadder(d.id, now);
        if (n) {
          report.laddered++;
          await logSystem(null, "INFO", "pool", `${d.name} finished ${current.warmupTargetDays ?? s.warmupDays} days of InboxKit warmup in good health and starts sending at 10 a day per mailbox, then 20 and 30.`, { domainId: d.id });
          if (!s.keepWarmupAfterLive) {
            const uids = current.mailboxes.filter((b) => b.providerId && b.status !== "RETIRED").map((b) => b.providerId!);
            await cancelWarmup(ctx, uids).catch((e: Error) => logSystem(null, "WARN", "pool", `${d.name}: InboxKit warmup could not be cancelled (${e.message}). Cancel it in InboxKit to stop paying for it.`));
          }
        }
      } else if (current.agingUntil && current.agingUntil <= now) {
        // Past its warmup time but held: say why once, on the domain, for the operator.
        if (current.lastError !== hold) {
          await prisma.sendingDomain.update({ where: { id: d.id }, data: { lastError: hold.slice(0, 300) } });
          await logSystem(null, "WARN", "pool", `${d.name} is held back from sending: ${hold}.`, { domainId: d.id });
        }
        report.held++;
      }
    }
  }

  // 7. Warmup that an order should have booked but InboxKit doesn't show (booked late, or lost): book it now.
  if (missingWarmup.length) await addWarmup(ctx, missingWarmup).catch((e: Error) => logger.warn({ err: e.message, count: missingWarmup.length }, "inboxkit: could not book warmup"));

  // 8. Retired mailboxes stop being billed. One InboxKit doesn't list (never created, already deleted) bills nothing.
  if (retiredToCancel.length) {
    const toCancel: { id: string; uid: string }[] = [];
    const nothingToCancel: string[] = [];
    for (const m of retiredToCancel) {
      const ik = mailboxByEmail.get(m.address) ?? (m.providerId ? ikMailboxes.find((x) => x.uid === m.providerId) : undefined);
      if (!ik || ["cancelled", "deleted", "archived", "scheduled_for_cancellation"].includes(ik.status)) nothingToCancel.push(m.id);
      else toCancel.push({ id: m.id, uid: ik.uid });
    }
    if (nothingToCancel.length) await prisma.mailbox.updateMany({ where: { id: { in: nothingToCancel } }, data: { supplierCancelRequestedAt: now } });
    const cancelled = async (list: { id: string; uid: string }[]) => {
      await cancelMailboxes(ctx, list.map((x) => x.uid));
      await cancelWarmup(ctx, list.map((x) => x.uid)).catch(() => undefined);
      await prisma.mailbox.updateMany({ where: { id: { in: list.map((x) => x.id) } }, data: { supplierCancelRequestedAt: now } });
      report.cancelled += list.length;
    };
    for (let i = 0; i < toCancel.length; i += 100) {
      const chunk = toCancel.slice(i, i + 100);
      try {
        await cancelled(chunk);
      } catch {
        // One bad mailbox must not hold up the rest: try them one by one.
        for (const one of chunk) {
          await cancelled([one]).catch((e: Error) => logSystem(null, "WARN", "pool", `InboxKit didn't take the cancellation of a retired mailbox (${e.message}). It is tried again at the next sync.`, { mailboxId: one.id }));
        }
      }
    }
    if (report.cancelled) await logSystem(null, "INFO", "pool", `Cancelled ${report.cancelled} retired mailbox${report.cancelled === 1 ? "" : "es"} at InboxKit so they stop being billed.`);
  }

  if (report.signedIn || report.laddered || report.adopted || report.problems) await invalidateConsole();
  return report;
}

/** One sync at a time, across every API instance. */
export async function syncInboxKit(now = new Date()): Promise<SyncReport> {
  const r = await withLock("job:inboxkit-sync", 15 * MIN, () => runSync(now));
  return r.ran ? r.result : { ...blank(), skipped: "already running" };
}

let nudge: NodeJS.Timeout | null = null;

/** An InboxKit webhook arrived: sync a minute from now (several webhooks in a row make one sync). */
export function nudgeSync(delayMs = MIN): void {
  if (nudge) return;
  nudge = setTimeout(() => {
    nudge = null;
    void syncInboxKit().catch((e: Error) => logger.error({ err: e.message }, "inboxkit: webhook sync failed"));
  }, delayMs);
  nudge.unref();
}
