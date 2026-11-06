import { sequenceOf } from "../domain/campaignSequence.js";
import type { Contact } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { addDays, dateKeyInTz, tzMidnightUtc, workdaysLeft, dayKeyOf } from "../lib/time.js";
import { inWindow, nextSlot, prospectTz, windowFor } from "../domain/sending/schedule.js";
import { isFreeMailDomain } from "../lib/normalize.js";
import { verifierFor } from "../integrations/verifier.js";
import { getSettings } from "../domain/settings.js";
import { blockEmail } from "../domain/suppression.js";
import { personalizeContact } from "../domain/personalize.js";
import { activeSendBatch, closePastBatches } from "../domain/batches.js";
import { SEND_FLOOR } from "../domain/scoring.js";
import { APPROVED } from "../domain/approval.js";
import { addUsage } from "../domain/usage.js";
import { logSystem } from "../domain/systemLog.js";
import { forEachOrg, autopilotOrgs } from "./runner.js";
import { dailyPlan } from "../domain/sending/dailyPlan.js";
import { rewriteAfterBlock } from "../domain/sending/pipeline.js";
import { languageFor } from "../domain/prospectLanguage.js";
import { sendFirstTouch } from "../domain/sending/pipeline.js";
import { reviewsWeekly } from "../domain/supply.js";

/** People written per run (every 30 minutes), several at a time: about 2,000 a day, and a run stays well under its time limit. */
const PERSONALIZE_BATCH = 60;
const WRITE_CONCURRENCY = 6;
/** Addresses checked per run. */
const VERIFY_BATCH = 150;
const VERIFY_RETRY_MS = 7 * 86_400_000;
const TIER_ORDER = (c: Pick<Contact, "tier">) => ({ A: 0, B: 1, C: 2 })[c.tier as "A" | "B" | "C"] ?? 3;

export async function verifyNew(orgId: string): Promise<{ good: number; dropped: number }> {
  const verify = await verifierFor(orgId);
  if (!verify) return { good: 0, dropped: 0 };
  const rows = await prisma.contact.findMany({
    where: {
      organizationId: orgId,
      status: "NEW",
      personalizationStatus: "pending",
      fitScore: { gte: SEND_FLOOR },
      OR: [{ verifyResult: null }, { verifyResult: { notIn: ["ok"] }, OR: [{ verifiedAt: null }, { verifiedAt: { lt: new Date(Date.now() - VERIFY_RETRY_MS) } }] }],
    },
    orderBy: [{ fitScore: "desc" }, { createdAt: "asc" }],
    take: VERIFY_BATCH,
  });
  let good = 0;
  let dropped = 0;
  for (const c of rows.sort((a, b) => TIER_ORDER(a) - TIER_ORDER(b))) {
    const hadPrior = !!c.verifyResult && c.verifyResult !== "error";
    const v = await verify(c.email);
    if (v.noCredits) {
      await logSystem(orgId, "ERROR", "verify", "Email verification is out of credits. Leads wait unverified until it is topped up.");
      break;
    }
    if (v.transient) continue;
    await addUsage(orgId, "emailsVerified");
    await prisma.contact.update({ where: { id: c.id }, data: { verifyResult: v.result, verifyQuality: v.quality, verifiedAt: new Date() } });
    if (v.result === "catch_all") {
      // Catch-all servers accept anything, so the address can't be confirmed. The pool never sends to them.
      await prisma.contact.update({ where: { id: c.id }, data: { status: "REJECTED" } });
      dropped++;
    } else if (v.bad || (!v.ok && hadPrior)) {
      await prisma.contact.update({ where: { id: c.id }, data: { status: "BOUNCED" } });
      await blockEmail(orgId, c.emailNormalized, "BOUNCED", c.id, { emailOnly: !v.bad });
      dropped++;
    } else if (v.ok) good++;
  }
  return { good, dropped };
}

export async function personalizeNew(orgId: string): Promise<number> {
  const settings = await getSettings(orgId);
  if (!settings.personalizationEnabled) return 0;
  const verifierConfigured = !!(await verifierFor(orgId));
  const rows = await prisma.contact.findMany({
    where: {
      organizationId: orgId,
      status: "NEW",
      personalizationStatus: { in: ["pending", "retry_1", "retry_2"] },
      fitScore: { gte: SEND_FLOOR },
      campaign: { status: "ACTIVE" },
      ...(verifierConfigured && settings.requireVerifiedEmail ? { verifyResult: "ok" } : {}),
    },
    include: { campaign: { select: { marketBrief: true, language: true, sequence: true } } },
    orderBy: [{ fitScore: "desc" }, { createdAt: "asc" }],
    take: PERSONALIZE_BATCH,
  });
  let done = 0;
  const one = async (c: (typeof rows)[number]) => {
    const company = c.companyDomain ? await prisma.company.findUnique({ where: { organizationId_domain: { organizationId: orgId, domain: c.companyDomain } }, select: { description: true } }) : null;
    // Their own language: their website's main one, else their country's, else the workspace's (when switched on).
    const fallback = c.campaign?.language || settings.language;
    const language = settings.matchProspectLanguage ? await languageFor(c, fallback) : fallback;
    const r = await personalizeContact(c, settings, { marketBrief: c.campaign?.marketBrief, companyDescription: company?.description, language, sequence: c.campaign ? sequenceOf(c.campaign) : null });
    await addUsage(orgId, "aiCalls");
    if (r.status === "failed") {
      const attempt = c.personalizationStatus === "retry_2" ? 3 : c.personalizationStatus === "retry_1" ? 2 : 1;
      if (attempt < 3) {
        await prisma.contact.update({ where: { id: c.id }, data: { personalizationStatus: `retry_${attempt}` } });
        return;
      }
    }
    await prisma.contact.update({
      where: { id: c.id },
      data: {
        personalization: r.body, messageSubject: r.subject, followup2: r.followup2, followup3: r.followup3, followup4: r.followup4, personalizationStatus: r.status === "failed" ? "fallback" : r.status, status: "PERSONALIZED",
        // A fallback is the customer's own sequence, in the workspace's language: the sign-off and footer follow it.
        language: r.status === "done" ? language : fallback,
      },
    });
    done++;
  };
  for (let i = 0; i < rows.length; i += WRITE_CONCURRENCY) await Promise.all(rows.slice(i, i + WRITE_CONCURRENCY).map(one));
  return done;
}

/** Refusals that will hit every other person today too, so the run stops instead of trying the rest. */
const STOP_FOR_TODAY = new Set(["INSUFFICIENT_CREDITS", "COLD_EMAIL_PAUSED", "CUSTOMER_PAUSED", "NO_CAPACITY", "SENDING_UNAVAILABLE", "VERIFIER_UNAVAILABLE", "AWAITING_APPROVAL", "CONSENT_REQUIRED", "BUDGET_PAUSED", "BUDGET_REACHED"]);

const STOP_NOTICE: Record<string, string> = {
  INSUFFICIENT_CREDITS: "Sending stopped: your balance is used up. Everything is paused, replies included, until you add credits.",
  COLD_EMAIL_PAUSED: "Cold email is paused. Your live conversations are still running. Add credits to resume sending.",
  CUSTOMER_PAUSED: "New emails are paused because too many recent ones bounced. Re-verify your list in Billing → Credits to restart.",
  NO_CAPACITY: "No sending capacity was free today. Your people go out tomorrow.",
  AWAITING_APPROVAL: "Nothing has been sent yet: approve your first 20 people and their emails to start.",
  CONSENT_REQUIRED: "Nothing has been sent yet: confirm you are authorised to send on your company's behalf.",
  BUDGET_REACHED: "Today's budget is spent. Sending continues tomorrow.",
  BUDGET_PAUSED: "Sending is paused: your daily budget is set to zero.",
};

async function noticeOncePerDay(orgId: string, code: string): Promise<void> {
  const message = STOP_NOTICE[code];
  if (!message) return;
  const since = new Date(Date.now() - 20 * 3_600_000);
  const seen = await prisma.systemLog.findFirst({ where: { organizationId: orgId, source: "send", message, createdAt: { gte: since } }, select: { id: true } });
  if (!seen) await logSystem(orgId, code === "NO_CAPACITY" ? "INFO" : "WARN", "send", message);
}

/**
 * Starts today's new people. Each one gets a random minute inside their OWN working hours (their time zone, the
 * workspace's sending days and window) and goes out through the send pipeline (domain/sending/pipeline.ts) when that
 * minute comes. Follow-ups are not started here; they go out from the mailbox each conversation is pinned to.
 *
 * `ignoreWindow` sends whoever is ready at once (tests and the admin "send now" button only).
 */
export async function pushQueue(orgId: string, opts: { now?: Date; ignoreWindow?: boolean } = {}): Promise<{ pushed: number; scheduled?: number; reason?: string }> {
  const settings = await getSettings(orgId);
  const now = opts.now ?? new Date();
  const tz = settings.timezone;
  const dayKey = dateKeyInTz(tz, now);
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { region: true } });

  let batchId: string | null = null;
  let batchQuotaLeft = Number.POSITIVE_INFINITY;
  const today = tzMidnightUtc(dayKey, tz);
  // A weekly list paces sending only when someone reviews it; approved automatically, people go day by day.
  if (reviewsWeekly(settings)) {
    await closePastBatches(orgId, dayKey);
    const batch = await activeSendBatch(orgId, dayKey);
    if (batch) {
      batchId = batch.id;
      if (batch.status === "APPROVED") await prisma.weeklyBatch.update({ where: { id: batch.id }, data: { status: "SENDING" } });
      const [pushedToday, remaining] = await Promise.all([
        prisma.send.count({ where: { organizationId: orgId, isFirstTouch: true, status: { not: "REJECTED" }, sentAt: { gte: today }, contact: { batchId: batch.id } } }),
        prisma.contact.count({ where: { organizationId: orgId, batchId: batch.id, status: { in: ["NEW", "PERSONALIZED", "QUEUED"] } } }),
      ]);
      const days = Math.max(1, workdaysLeft(dayKeyOf(batch.weekStart), dayKey));
      const fairShare = Math.ceil((remaining + pushedToday) / days);
      batchQuotaLeft = Math.max(0, fairShare - pushedToday);
    }
  }
  // Today's share of the budget for new people: what follow-ups leave, between a fifth and a half of the day.
  const cap = (await dailyPlan(orgId, settings, now)).newAllowed;
  const already = await prisma.send.count({ where: { organizationId: orgId, isFirstTouch: true, status: { not: "REJECTED" }, sentAt: { gte: today } } });
  const remaining = Math.max(0, cap - already);

  let pool = await prisma.contact.findMany({
    where: {
      organizationId: orgId,
      status: { in: ["PERSONALIZED", "QUEUED"] },
      sequenceStoppedAt: null,
      fitScore: { gte: SEND_FLOOR },
      campaign: { status: "ACTIVE" },
      OR: [{ verifyResult: null }, { verifyResult: "ok" }],
      ...APPROVED,
    },
    orderBy: [{ fitScore: "desc" }, { createdAt: "asc" }],
    take: Math.min(1000, cap * 4 + 40),
  });
  // This week's batch goes first, then CSV imports and the best tier.
  pool.sort(
    (a, b) =>
      Number(b.batchId === batchId) - Number(a.batchId === batchId) ||
      Number(b.source === "csv") - Number(a.source === "csv") ||
      TIER_ORDER(a) - TIER_ORDER(b),
  );
  if (!pool.length) {
    const waiting = await prisma.contact.count({ where: { organizationId: orgId, status: { in: ["PERSONALIZED", "QUEUED"] }, sequenceStoppedAt: null, approvedAt: null } });
    if (!waiting) return { pushed: 0, reason: "nothing-sendable" };
    if (settings.launchMode === "APPROVE_FIRST_BATCH" && !settings.firstBatchApprovedAt) await noticeOncePerDay(orgId, "AWAITING_APPROVAL");
    return { pushed: 0, reason: "awaiting_approval" };
  }

  // Nobody else at a company that is already talking to us.
  const talking = new Set(
    (await prisma.contact.findMany({ where: { organizationId: orgId, repliedAt: { not: null } }, select: { domain: true } }))
      .map((r) => r.domain)
      .filter((d): d is string => !!d && !isFreeMailDomain(d)),
  );
  pool = pool.filter((c) => !(c.domain && talking.has(c.domain)));
  const windowOf = (c: Contact) => windowFor(settings, prospectTz(c, settings, org?.region));

  let pushed = 0;
  let stopped: string | undefined;
  const send = async (c: Contact): Promise<boolean> => {
    const out = await sendFirstTouch(orgId, c.id, c.campaignId);
    if (out.ok) {
      pushed++;
      if (batchId && c.batchId === batchId) batchQuotaLeft--;
      return true;
    }
    if (STOP_FOR_TODAY.has(out.code)) {
      stopped = out.code;
      await noticeOncePerDay(orgId, out.code);
    } else {
      const r = refused.get(out.code) ?? { n: 0, message: out.message };
      r.n++;
      refused.set(out.code, r);
    }
    return false;
  };
  // Every other refusal is said too, once a day each, so an email that keeps not going is never silent.
  const refused = new Map<string, { n: number; message: string }>();

  if (opts.ignoreWindow) {
    for (const c of pool) {
      if (pushed >= remaining || stopped) break;
      if (batchId && c.batchId === batchId && batchQuotaLeft <= 0) continue;
      await send(c);
    }
    return { pushed, ...(stopped ? { reason: stopped.toLowerCase() } : !remaining ? { reason: "daily-cap-reached" } : !pushed ? { reason: "nothing-sent" } : {}) };
  }

  // 1. Whoever's minute has come, inside their own window.
  const due = pool.filter((c) => c.nextTouchAt && c.nextTouchAt <= now);
  for (const c of due) {
    const w = windowOf(c);
    const quotaGone = pushed >= remaining || (batchId && c.batchId === batchId && batchQuotaLeft <= 0);
    if (quotaGone || !inWindow(w, now)) {
      // Today is full, or the slot passed while sending was held back: a fresh random minute in the next window.
      const from = quotaGone ? tzMidnightUtc(addDays(dateKeyInTz(w.tz, now), 1), w.tz) : now;
      await prisma.contact.update({ where: { id: c.id }, data: { nextTouchAt: nextSlot(w, from) } });
      continue;
    }
    if (stopped) break;
    await send(c);
  }

  // 2. Give today's remaining room to people without a slot yet, spread over their own windows.
  const pending = await prisma.contact.count({ where: { organizationId: orgId, status: { in: ["PERSONALIZED", "QUEUED"] }, sequenceStoppedAt: null, nextTouchAt: { gt: now, lt: new Date(now.getTime() + 24 * 3_600_000) } } });
  let room = Math.max(0, cap - already - pushed - pending);
  let scheduled = 0;
  for (const c of pool) {
    if (room <= 0) break;
    if (c.nextTouchAt) continue;
    const w = windowOf(c);
    await prisma.contact.update({ where: { id: c.id }, data: { nextTouchAt: nextSlot(w, now), timezone: c.timezone ?? w.tz } });
    scheduled++;
    room--;
  }
  await noteRefusals(orgId, refused);
  return { pushed, scheduled, ...(stopped ? { reason: stopped.toLowerCase() } : !remaining ? { reason: "daily-cap-reached" } : {}) };
}

async function noteRefusals(orgId: string, refused: Map<string, { n: number; message: string }>): Promise<void> {
  // Once an hour per reason: a new problem shows up quickly, a lasting one doesn't flood the page.
  const since = new Date(Date.now() - 3_600_000);
  for (const [code, r] of refused) {
    const head = `Not sent yet (${code})`;
    const said = await prisma.systemLog.count({ where: { organizationId: orgId, source: "send", createdAt: { gte: since }, message: { startsWith: head } } });
    if (!said) await logSystem(orgId, "WARN", "send", `${head}: ${r.message} ${r.n} ${r.n === 1 ? "person was" : "people were"} held back this run.`.slice(0, 500));
  }
}

/** Every 5 minutes: whoever's random minute has come goes out. Cheap; the 30-minute run does the heavy lifting. */
/** Emails this late mean the sender is not getting to a workspace; said once a day on its System page. */
const OVERDUE_MS = 15 * 60_000;

async function flagOverdue(now = new Date()): Promise<void> {
  const late = await prisma.contact.groupBy({
    by: ["organizationId"],
    where: { organization: { AND: [{ status: "ACTIVE" }, autopilotOrgs] }, status: { in: ["PERSONALIZED", "QUEUED"] }, sequenceStoppedAt: null, nextTouchAt: { lt: new Date(now.getTime() - OVERDUE_MS), gt: new Date(now.getTime() - 6 * 3_600_000) } },
    _count: { _all: true },
  });
  for (const l of late) {
    const since = new Date(now.getTime() - 86_400_000);
    const said = await prisma.systemLog.count({ where: { organizationId: l.organizationId, source: "send", createdAt: { gte: since }, message: { startsWith: "Emails are late" } } });
    if (!said) await logSystem(l.organizationId, "WARN", "send", `Emails are late: ${l._count._all} were due more than 15 minutes ago and have not gone out. Sending catches up on the next runs.`);
  }
}

export async function runFirstTouchesJob() {
  await flagOverdue().catch(() => undefined);
  // Workspaces side by side, each with a time limit: one slow mailbox elsewhere never holds up anyone's sends.
  return forEachOrg("first-touches", autopilotOrgs, (orgId) => pushQueue(orgId), { concurrency: 6, perOrgMs: 90_000 });
}

/**
 * People whose first email the content check blocked before blocks were rewritten (they were dropped): written again,
 * if they were never emailed and were blocked fewer times than the rewrite limit. Idempotent.
 */
export async function restoreBlockedForRewrite(orgId: string): Promise<number> {
  const rows = await prisma.contact.findMany({
    where: { organizationId: orgId, status: "REJECTED", firstContactedAt: null, sends: { some: { isFirstTouch: true, status: "REJECTED", rejectCode: "CONTENT_BLOCKED", sentAt: { gte: new Date(Date.now() - 14 * 86_400_000) } } } },
    select: { id: true },
    take: 500,
  });
  let n = 0;
  for (const r of rows) if (await rewriteAfterBlock(r.id)) n++;
  return n;
}

export async function runSendForOrg(orgId: string) {
  await restoreBlockedForRewrite(orgId).catch(() => 0);
  const verified = await verifyNew(orgId);
  const personalized = await personalizeNew(orgId);
  const push = await pushQueue(orgId);
  return { verified, personalized, push };
}

export function runSendJob() {
  return forEachOrg("send", autopilotOrgs, runSendForOrg, { concurrency: 4, perOrgMs: 20 * 60_000 });
}
