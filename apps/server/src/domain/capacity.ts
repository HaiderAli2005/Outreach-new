import { prisma } from "../lib/prisma.js";
import { formatUsd, PRICE_PER_EMAIL } from "./money.js";
import { poolCapacity } from "./sending/pool.js";
import { WARMUP_DAYS_TO_ACTIVE, VOLUME_MAX, VOLUME_MIN, VOLUME_PRESETS, VOLUME_RECOMMEND_CAP, VOLUME_RECOMMEND_MARKET_DAYS, VOLUME_STEP } from "../config/plans.js";
import { WORKING_DAYS_PER_MONTH } from "./usage.js";
import { SEQUENCE_EMAILS } from "./money.js";

/**
 * What the shared pool can still take. A customer is never sold more emails a day than the pool can deliver:
 *
 *   available = pool daily capacity - emails a day already committed to other launched customers
 *
 * Internal outreach only ever uses what is left over, so it doesn't count against customers.
 */
const DAY = 86_400_000;

export interface Capacity {
  total: number;
  committed: number;
  available: number;
  /** When more of the pool goes live: the earliest warming or aging pool domain reaching full capacity. */
  moreOn: Date | null;
}

export async function capacityFor(orgId: string | null, now = new Date()): Promise<Capacity> {
  const [total, committedAgg, upcoming] = await Promise.all([
    poolCapacity(),
    prisma.orgSettings.aggregate({
      where: { autopilotEnabled: true, ...(orgId ? { organizationId: { not: orgId } } : {}), organization: { kind: "CUSTOMER", onboarding: { launchedAt: { not: null } } } },
      _sum: { dailyBudgetDecicents: true },
    }),
    prisma.sendingDomain.findMany({ where: { organizationId: null, status: { in: ["AGING", "WARMING"] } }, select: { status: true, agingUntil: true, warmupStartedAt: true } }),
  ]);
  const committed = Number((committedAgg._sum.dailyBudgetDecicents ?? 0n) / PRICE_PER_EMAIL);
  let moreOn: Date | null = null;
  for (const d of upcoming) {
    const start = d.status === "WARMING" ? d.warmupStartedAt : d.agingUntil;
    if (!start) continue;
    const live = new Date(start.getTime() + WARMUP_DAYS_TO_ACTIVE * DAY);
    if (live > now && (!moreOn || live < moreOn)) moreOn = live;
  }
  return { total, committed, available: Math.max(0, total - committed), moreOn };
}

/** "in about 3 weeks", for a preset the pool can't take yet. */
export function whenText(moreOn: Date | null, now = new Date()): string {
  if (!moreOn) return "more capacity is being added";
  const days = Math.max(1, Math.ceil((moreOn.getTime() - now.getTime()) / DAY));
  if (days < 7) return `more capacity in about ${days} day${days === 1 ? "" : "s"}`;
  const weeks = Math.round(days / 7);
  return `more capacity in about ${weeks} week${weeks === 1 ? "" : "s"}`;
}

export const dateText = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

const dollars = (d: bigint) => formatUsd(d).replace(/\.00$/, "");

/** What a number of emails a day costs and reaches. Exact: one flat price. */
export function quote(emails: number) {
  const perDay = BigInt(emails) * PRICE_PER_EMAIL;
  return {
    emails,
    perDay: dollars(perDay),
    perDayDeciCents: perDay.toString(),
    people: Math.floor(emails / SEQUENCE_EMAILS),
    perMonth: dollars(perDay * BigInt(WORKING_DAYS_PER_MONTH)),
  };
}

/** Every stop on a slider from the minimum to `max`, so the page looks prices up instead of working them out. */
export function quotes(max: number) {
  const out = [];
  for (let e = VOLUME_MIN; e <= max; e += VOLUME_STEP) out.push(quote(e));
  return out;
}

/**
 * The "How many emails a day?" step. The customer chooses from the whole product range; the pool is ours to size,
 * never theirs to wait for, so setup never stops on it and the page never talks about it. Every email is prepaid and
 * charged only when it is sent, so a pool that is short for a while slows sending without costing the customer
 * anything, and the shortfall is raised to the team (see `reportShortfall`).
 *
 *   slider           the product minimum to maximum
 *   recommended      min(reachable market / 90 days, 1,000), as a preset, and never the maximum
 */
export function volumeOptions(reachable: number | null) {
  const max = VOLUME_MAX;
  const presets = VOLUME_PRESETS.map((p) => ({ emails: p, disabled: false, reason: null }));
  const byMarket = reachable && reachable > 0 ? Math.floor(reachable / VOLUME_RECOMMEND_MARKET_DAYS) : Number.POSITIVE_INFINITY;
  const target = Math.min(byMarket, VOLUME_RECOMMEND_CAP);
  const below = VOLUME_PRESETS.filter((p) => p < max);
  const recommended = [...below].filter((p) => p <= target).pop() ?? below[0] ?? VOLUME_MIN;
  return { ready: true as const, liveOn: null, min: VOLUME_MIN, max, step: VOLUME_STEP, presets, recommended, stops: quotes(max) };
}

/**
 * Tells the team when launched customers have asked for more emails a day than the pool delivers, so domains are
 * added before anyone notices. Logged once per call site; the admin console lists it under System.
 */
export async function reportShortfall(orgId: string, why: string): Promise<void> {
  const cap = await capacityFor(null);
  if (cap.committed <= cap.total) return;
  const { logSystem } = await import("./systemLog.js");
  await logSystem(orgId, "WARN", "capacity", `Pool short: customers have ${cap.committed.toLocaleString("en-US")} emails a day committed, the pool delivers ${cap.total.toLocaleString("en-US")}. Add sending domains (${why}).`, { committed: cap.committed, total: cap.total });
}

/** Emails everyone who asked to hear when they can start, once the pool has room. Each is told once. */
export async function notifyCapacityReady(now = new Date()): Promise<{ notified: number }> {
  const waiting = await prisma.onboarding.findMany({ where: { capacityNotifyAt: { not: null }, capacityNotifiedAt: null, launchedAt: null }, select: { organizationId: true } });
  if (!waiting.length) return { notified: 0 };
  const { notifyOwners } = await import("./sending/health.js");
  const { env } = await import("../config/env.js");
  let notified = 0;
  for (const w of waiting) {
    if ((await capacityFor(w.organizationId, now)).available < VOLUME_MIN) continue;
    await notifyOwners(w.organizationId, "You can start sending", `Sending capacity is ready for you. Pick how many emails a day and start your campaign: ${env.WEB_ORIGIN.split(",")[0].trim()}/onboarding`);
    await prisma.onboarding.update({ where: { organizationId: w.organizationId }, data: { capacityNotifiedAt: now } });
    notified++;
  }
  return { notified };
}
