import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { dateOnly, dayKeyOf } from "../../lib/time.js";
import { logSystem } from "../systemLog.js";
import { formatUsd, PRICE_PER_EMAIL } from "../money.js";
import type { CostPrices } from "../../config/internalCosts.js";
import { costPrices } from "../costPrices.js";
import { costStack } from "./economics.js";
import { AGING_DAYS, LEAD_TIME_WEEKS, WARMUP_DAYS_TO_ACTIVE, domainsNeeded } from "../../config/plans.js";
import { poolSettings } from "./settings.js";
import { DOMAIN_DAILY_CAP, poolCapacity } from "../sending/pool.js";
import { planBatch } from "./names.js";
import { badWeight, capForWarmupDay, COMPLAINT_WEIGHT, DELIVERED_OR_BOUNCED } from "./lifecycle.js";

/**
 * The numbers behind /admin/pool: is the pool healthy, and can we sell another customer. Every formula here is a
 * plain function first, so a hand calculation on seeded data can check it.
 */

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const EWMA_ALPHA = 0.3;
export const EWMA_SEED_WEEKS = 4;
const pool = { organizationId: null } as const;

// ─── 10.1 burn rate ─────────────────────────────────────────────────────────

/**
 * EWMA of domains degraded per week, oldest week first. For the first four weeks it is the simple mean of the
 * weeks observed; after that, alpha * this week + (1 - alpha) * previous.
 */
export function ewmaSeries(weekly: number[], alpha = EWMA_ALPHA): number[] {
  const out: number[] = [];
  weekly.forEach((w, i) => {
    if (i < EWMA_SEED_WEEKS) out.push(weekly.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1));
    else out.push(alpha * w + (1 - alpha) * out[i - 1]);
  });
  return out;
}

/** Domains degraded in each whole week from the pool's first domain up to `now`, oldest first. */
export async function weeklyDegraded(now = new Date()): Promise<number[]> {
  const first = await prisma.sendingDomain.findFirst({ where: pool, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  if (!first) return [];
  const weeks = Math.max(1, Math.floor((now.getTime() - first.createdAt.getTime()) / WEEK));
  const degraded = await prisma.sendingDomain.findMany({ where: { ...pool, degradedAt: { not: null, gte: new Date(now.getTime() - weeks * WEEK) } }, select: { degradedAt: true } });
  const counts = new Array<number>(weeks).fill(0);
  for (const d of degraded) {
    const ago = Math.floor((now.getTime() - d.degradedAt!.getTime()) / WEEK);
    if (ago >= 0 && ago < weeks) counts[weeks - 1 - ago]++;
  }
  return counts;
}

export async function currentEwma(now = new Date()): Promise<number> {
  const s = ewmaSeries(await weeklyDegraded(now));
  return s.length ? s[s.length - 1] : 0;
}

// ─── 10.2 risk score ────────────────────────────────────────────────────────

export type RiskBand = "AT_RISK" | "WATCH" | "HEALTHY" | "INSUFFICIENT_DATA";

export interface DomainRiskInput {
  sends7: number;
  bad7: number;
  complaints7: number;
  sends30: number;
  bad30: number;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/**
 *   br7 = (hard bounces + complaints) / sends over 7 days;  br30 the same over 30;  cr7 = complaints / sends, 7 days
 *   risk = 0.50 clamp(br7 / 0.05) + 0.30 clamp((br7 - br30) / 0.02) + 0.20 clamp(cr7 / 0.003)
 * Fewer than 200 sends in the 30-day window is INSUFFICIENT_DATA and is not scored.
 */
export function riskScore(x: DomainRiskInput): { risk: number | null; band: RiskBand; br7: number; br30: number; cr7: number; trend: number } {
  const br7 = x.sends7 ? x.bad7 / x.sends7 : 0;
  const br30 = x.sends30 ? x.bad30 / x.sends30 : 0;
  const cr7 = x.sends7 ? x.complaints7 / x.sends7 : 0;
  const trend = br7 - br30;
  if (x.sends30 < 200) return { risk: null, band: "INSUFFICIENT_DATA", br7, br30, cr7, trend };
  const risk = 0.5 * clamp(br7 / 0.05) + 0.3 * clamp(trend / 0.02) + 0.2 * clamp(cr7 / 0.003);
  return { risk, band: risk >= 0.7 ? "AT_RISK" : risk >= 0.4 ? "WATCH" : "HEALTHY", br7, br30, cr7, trend };
}

export interface DomainRisk extends ReturnType<typeof riskScore> {
  domainId: string;
  name: string;
  sends7: number;
}

export async function computeRiskScores(now = new Date()): Promise<DomainRisk[]> {
  const active = await prisma.sendingDomain.findMany({ where: { ...pool, status: "ACTIVE" }, select: { id: true, name: true } });
  if (!active.length) return [];
  const d30 = dateOnly(dayKeyOf(new Date(now.getTime() - 30 * DAY)));
  const d7 = dateOnly(dayKeyOf(new Date(now.getTime() - 7 * DAY)));
  const rows = await prisma.domainHealthDaily.findMany({ where: { domainId: { in: active.map((d) => d.id) }, day: { gt: d30 } } });
  return active.map((d) => {
    const mine = rows.filter((r) => r.domainId === d.id);
    const last7 = mine.filter((r) => r.day > d7);
    const sum = (rs: typeof mine, f: (r: (typeof mine)[number]) => number) => rs.reduce((a, r) => a + f(r), 0);
    const input: DomainRiskInput = {
      sends7: sum(last7, (r) => r.sends),
      bad7: sum(last7, (r) => r.hardBounces + r.complaints),
      complaints7: sum(last7, (r) => r.complaints),
      sends30: sum(mine, (r) => r.sends),
      bad30: sum(mine, (r) => r.hardBounces + r.complaints),
    };
    return { domainId: d.id, name: d.name, sends7: input.sends7, ...riskScore(input) };
  });
}

// ─── 10.3 predicted burn, 10.4 shelf ────────────────────────────────────────

/** predicted = at-risk domains + EWMA x 4.3 weeks x the share of the active pool not already at risk. */
export function predictedBurn(atRisk: number, activeDomains: number, ewma: number) {
  const share = activeDomains ? (activeDomains - atRisk) / activeDomains : 0;
  const background = ewma * 4.3 * share;
  return { atRisk, background, total: atRisk + background };
}

export interface RestockTargets {
  spareDomainsMin: number;
  spareMultiplier: number;
  maxBuyPerBatch: number;
  committed: number;
  capacityTotal: number;
}

export type ReorderDriver = "burnReplacement" | "spareShortfall" | "demandShortfall";

/**
 * runway = warm shelf / max(EWMA, 0.1). The reorder number is the largest of:
 *   burn replacement   ceil((lead time - runway) x EWMA), only while domains are burning and the runway is under the lead time
 *   spare shortfall    spareDomainsMin - warm shelf
 *   demand shortfall   domains for (committed x spareMultiplier - capacity), when demand outgrows the pool
 * capped at maxBuyPerBatch.
 */
export function shelfRunway(warmShelf: number, ewma: number, t?: RestockTargets) {
  const runwayWeeks = warmShelf / Math.max(ewma, 0.1);
  // Nothing has burned yet, so there is nothing to replace: an empty shelf is the spare minimum's job, not this one.
  const burnReplacement = ewma > 0 && runwayWeeks < LEAD_TIME_WEEKS ? Math.max(1, Math.ceil((LEAD_TIME_WEEKS - runwayWeeks) * ewma)) : 0;
  const spareShortfall = t ? Math.max(0, t.spareDomainsMin - warmShelf) : 0;
  const deficit = t ? Math.ceil(t.committed * t.spareMultiplier - t.capacityTotal) : 0;
  const demandShortfall = deficit > 0 ? domainsNeeded(deficit) : 0;
  const reasons: [ReorderDriver, number][] = [["burnReplacement", burnReplacement], ["spareShortfall", spareShortfall], ["demandShortfall", demandShortfall]];
  const [driver, most] = reasons.reduce((a, b) => (b[1] > a[1] ? b : a));
  const domainsToBuy = t ? Math.min(most, t.maxBuyPerBatch) : most;
  return { runwayWeeks, reorder: domainsToBuy > 0, domainsToBuy, reorderBecause: { burnReplacement, spareShortfall, demandShortfall, driver: most > 0 ? driver : null } };
}

/** What the restock targets are measured against right now. */
export async function restockTargets(capacityTotal?: number): Promise<RestockTargets> {
  const [s, committed, total] = await Promise.all([poolSettings(), committedEmails("CUSTOMER"), capacityTotal ?? poolCapacity()]);
  return { spareDomainsMin: s.spareDomainsMin, spareMultiplier: Number(s.spareMultiplier), maxBuyPerBatch: s.maxBuyPerBatch, committed, capacityTotal: total };
}

/** Emails a day launched customers (or internal outreach) asked for: the daily budget at $0.04 an email. */
async function committedEmails(kind: "CUSTOMER" | "INTERNAL"): Promise<number> {
  const agg = await prisma.orgSettings.aggregate({ where: { autopilotEnabled: true, organization: { kind, onboarding: { launchedAt: { not: null } } } }, _sum: { dailyBudgetDecicents: true } });
  return Number((agg._sum.dailyBudgetDecicents ?? 0n) / PRICE_PER_EMAIL);
}

const DRIVER_TEXT: Record<ReorderDriver, string> = {
  burnReplacement: "to replace domains burning faster than the shelf refills",
  spareShortfall: "to keep the spare shelf at its minimum",
  demandShortfall: "because customer demand is outgrowing the pool",
};

// ─── jobs ───────────────────────────────────────────────────────────────────

/**
 * Daily. Rewrites yesterday's and today's domain_health_daily from the sends table, so a missed webhook increment
 * can never leave the counters wrong for long.
 */
export async function rollUpDomainHealth(now = new Date()): Promise<number> {
  const since = dateOnly(dayKeyOf(new Date(now.getTime() - DAY)));
  const rows = await prisma.$queryRaw<{ domainId: string; day: Date; sends: bigint; hard: bigint; complaints: bigint }[]>`
    SELECT domain_id AS "domainId", (sent_at AT TIME ZONE 'UTC')::date AS day,
           COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','HARD_BOUNCE','SOFT_BOUNCE','COMPLAINT')) AS sends,
           COUNT(*) FILTER (WHERE status = 'HARD_BOUNCE') AS hard,
           COUNT(*) FILTER (WHERE status = 'COMPLAINT') AS complaints
    FROM sends
    WHERE domain_id IS NOT NULL AND sent_at >= ${since}
    GROUP BY 1, 2`;
  for (const r of rows) {
    const data = { sends: Number(r.sends), hardBounces: Number(r.hard), complaints: Number(r.complaints) };
    await prisma.domainHealthDaily.upsert({ where: { domainId_day: { domainId: r.domainId, day: r.day } }, create: { domainId: r.domainId, day: r.day, ...data }, update: data });
  }
  return rows.length;
}

// ─── dilution ───────────────────────────────────────────────────────────────

/**
 * Average distinct customers per domain per day, over the last 7 days. It explains the burn rate:
 *   under 2   each domain serves about one customer: no protection, verification is the only defence
 *   2 to 10   weak      10 to 30  working      30+  as mixed as a large pool gets
 */
export async function computeDilution(now = new Date()): Promise<number | null> {
  const since = new Date(now.getTime() - 7 * DAY);
  const rows = await prisma.$queryRaw<{ customers: bigint }[]>`
    SELECT COUNT(DISTINCT customer_id) AS customers
    FROM sends
    WHERE domain_id IS NOT NULL AND sent_at >= ${since} AND status IN ('SENT','DELIVERED','HARD_BOUNCE','SOFT_BOUNCE','COMPLAINT')
    GROUP BY domain_id, (sent_at AT TIME ZONE 'UTC')::date`;
  if (!rows.length) return null;
  return rows.reduce((a, r) => a + Number(r.customers), 0) / rows.length;
}

export function dilutionRegime(d: number | null): string {
  if (d === null) return "no sends yet";
  if (d < 2) return "no protection";
  if (d < 10) return "weak";
  if (d < 30) return "working";
  return "fully mixed";
}

/** Daily. One row of pool counts for the trend lines. */
export async function snapshotPoolMetrics(now = new Date()) {
  const day = dateOnly(dayKeyOf(now));
  const monthAgo = new Date(now.getTime() - 30 * DAY);
  const [activeDomains, warmingDomains, activeMailboxes, warmingMailboxes, repliesOnly, degraded, retired, ewma] = await Promise.all([
    prisma.sendingDomain.count({ where: { ...pool, status: "ACTIVE" } }),
    prisma.sendingDomain.count({ where: { ...pool, status: "WARMING" } }),
    prisma.mailbox.count({ where: { ...pool, status: "ACTIVE" } }),
    prisma.mailbox.count({ where: { ...pool, status: "WARMING" } }),
    prisma.mailbox.count({ where: { ...pool, status: "REPLIES_ONLY" } }),
    prisma.sendingDomain.count({ where: { ...pool, degradedAt: { gte: monthAgo } } }),
    prisma.sendingDomain.count({ where: { ...pool, retiredAt: { gte: monthAgo } } }),
    currentEwma(now),
  ]);
  const [dilution, unmatchedOpen, capacity, committed] = await Promise.all([
    computeDilution(now),
    prisma.inboundMessage.count({ where: { kind: "unmatched", handledAt: null } }),
    poolCapacity(),
    committedEmails("CUSTOMER"),
  ]);
  const data = { capacity, committed, activeDomains, warmingDomains, activeMailboxes, warmingMailboxes, repliesOnlyMailboxes: repliesOnly, domainsDegraded: degraded, domainsRetired: retired, ewmaWeeklyBurn: ewma.toFixed(3), dilution: dilution === null ? null : dilution.toFixed(2), unmatchedOpen };
  return prisma.poolMetricsDaily.upsert({ where: { day }, create: { day, ...data }, update: data });
}

/** Weekly. Stores the EWMA on today's row (the daily snapshot keeps it current too). */
export async function recomputeEwmaBurn(now = new Date()): Promise<number> {
  const ewma = await currentEwma(now);
  await snapshotPoolMetrics(now);
  return ewma;
}

/** Daily. Raises a restock request for an operator. It never buys anything by itself. */
export async function checkReorderTrigger(now = new Date()) {
  const [ewma, warmShelf, targets] = await Promise.all([currentEwma(now), prisma.sendingDomain.count({ where: { ...pool, status: { in: ["AGING", "WARMING"] } } }), restockTargets()]);
  const s = shelfRunway(warmShelf, ewma, targets);
  if (!s.reorder) return { ...s, created: false };
  const pending = await prisma.poolReorder.findFirst({ where: { status: { in: ["PENDING", "APPROVED"] } }, select: { id: true } });
  if (pending) return { ...s, created: false };
  await prisma.poolReorder.create({ data: { domainsToBuy: s.domainsToBuy, runwayWeeks: s.runwayWeeks.toFixed(2), ewmaBurn: ewma.toFixed(3) } });
  await logSystem(null, "CRITICAL", "pool", `Restock needed ${DRIVER_TEXT[s.reorderBecause.driver!]}: the warm shelf is ${warmShelf} domain${warmShelf === 1 ? "" : "s"}, covering ${s.runwayWeeks.toFixed(1)} weeks. Add ${s.domainsToBuy} domain${s.domainsToBuy === 1 ? "" : "s"} on /admin/domains.`, s.reorderBecause);
  return { ...s, created: true };
}

/** Weighted bad rate per domain over the last 7 days: hard bounces 1, complaints 10, authentication failures 1. */
export async function sevenDayRates(domainIds: string[], now = new Date()): Promise<Map<string, { sends: number; rate: number }>> {
  const out = new Map<string, { sends: number; rate: number }>();
  if (!domainIds.length) return out;
  const rows = await prisma.send.groupBy({
    by: ["domainId", "status"],
    where: { domainId: { in: domainIds }, sentAt: { gte: new Date(now.getTime() - 7 * DAY) }, status: { in: [...DELIVERED_OR_BOUNCED, "AUTH_FAILURE"] } },
    _count: { _all: true },
  });
  for (const id of domainIds) {
    const mine = rows.filter((r) => r.domainId === id);
    const sends = mine.reduce((a, r) => a + r._count._all, 0);
    const bad = mine.reduce((a, r) => a + r._count._all * badWeight(r.status, true), 0);
    out.set(id, { sends, rate: sends ? bad / sends : 0 });
  }
  return out;
}

export type BurnKind = "bounces" | "dkim" | "seed" | "other";

/** Which of the three burn rules fired, read from the reason the lifecycle wrote. */
export function burnKind(reason: string | null): BurnKind {
  if (!reason) return "other";
  if (/bounced/.test(reason)) return "bounces";
  if (/seed check/.test(reason)) return "seed";
  if (/DKIM record/.test(reason)) return "dkim";
  return "other";
}

/**
 * What burned mailboxes still carry. A burned mailbox stops cold email but keeps every person already pinned to
 * it: their follow-ups and replies still go out from it, and it is billed until it retires.
 */
async function burnImpact(degradedDomains: { name: string }[], prices: CostPrices, now: Date) {
  const monthAgo = new Date(now.getTime() - 30 * DAY);
  const onBurned = { assignedMailbox: { organizationId: null, status: "REPLIES_ONLY" as const } };
  const onDomain = { organizationId: true, assignedMailbox: { select: { sendingDomainId: true } } } as const;
  const [live, running, boxes] = await Promise.all([
    prisma.contact.findMany({ where: { ...onBurned, hasInbound: true, lastMessageAt: { gte: monthAgo } }, select: onDomain }),
    prisma.contact.findMany({ where: { ...onBurned, hasInbound: false, sequenceStoppedAt: null, status: "CONTACTED" }, select: onDomain }),
    prisma.mailbox.findMany({
      where: { organizationId: null, status: "REPLIES_ONLY" },
      select: { warmupDay: true, sendingDomainId: true, degradedAt: true, sendingDomain: { select: { name: true, status: true, degradedAt: true } } },
    }),
  ]);
  // Burned mailboxes grouped by domain, each with the conversations it still carries, most conversations first.
  const groups = new Map<string, { domain: string; domainBurned: boolean; burnedOn: Date | null; mailboxes: number; liveConversations: number; sequencesRunning: number; customers: Set<string> }>();
  for (const m of boxes) {
    const key = m.sendingDomainId ?? "none";
    const g = groups.get(key) ?? { domain: m.sendingDomain?.name ?? "unknown", domainBurned: m.sendingDomain?.status === "DEGRADED", burnedOn: m.sendingDomain?.degradedAt ?? m.degradedAt, mailboxes: 0, liveConversations: 0, sequencesRunning: 0, customers: new Set<string>() };
    g.mailboxes++;
    if (m.degradedAt && (!g.burnedOn || m.degradedAt < g.burnedOn)) g.burnedOn = m.degradedAt;
    groups.set(key, g);
  }
  const tally = (rows: typeof live, field: "liveConversations" | "sequencesRunning") => {
    for (const c of rows) {
      const g = groups.get(c.assignedMailbox?.sendingDomainId ?? "none");
      if (!g) continue;
      g[field]++;
      g.customers.add(c.organizationId);
    }
  };
  tally(live, "liveConversations");
  tally(running, "sequencesRunning");
  const byDomain = [...groups.values()]
    .map(({ customers, ...g }) => ({ ...g, customers: customers.size }))
    .sort((a, b) => b.liveConversations + b.sequencesRunning - (a.liveConversations + a.sequencesRunning));
  // What the burned mailboxes could send a day when they burned: each one's cap at its warmup step (a mailbox that
  // burned on warmup day 3 was sending 5, not 30), and never more than one domain's cap per domain.
  const perDomain = new Map<string, number>();
  for (const m of boxes) perDomain.set(m.sendingDomainId ?? "none", (perDomain.get(m.sendingDomainId ?? "none") ?? 0) + capForWarmupDay(m.warmupDay));
  const capacityLost = [...perDomain.values()].reduce((a, v) => a + Math.min(DOMAIN_DAILY_CAP, v), 0);
  const costCents = Math.round((boxes.length * prices.repliesOnlyMailboxMonthUsd + (degradedDomains.length * prices.domainYearUsd) / 12) * 100);
  return {
    mailboxes: boxes.length,
    domains: degradedDomains.length,
    capacityLost,
    monthlyCostCents: costCents,
    monthlyCost: formatUsd(BigInt(costCents) * 10n),
    liveConversations: live.length,
    sequencesRunning: running.length,
    customersAffected: new Set([...live, ...running].map((c) => c.organizationId)).size,
    byDomain,
  };
}

/** The last 30 days, one point a day: what the pool sent, how much of it was bad, and capacity against demand. */
async function dailyTrend(domainIds: string[], now: Date, today: { capacity: number; committed: number; sentToday: number }) {
  const from = dateOnly(dayKeyOf(new Date(now.getTime() - 29 * DAY)));
  const [health, metrics] = await Promise.all([
    domainIds.length ? prisma.domainHealthDaily.groupBy({ by: ["day"], where: { domainId: { in: domainIds }, day: { gte: from } }, _sum: { sends: true, hardBounces: true, complaints: true } }) : Promise.resolve([]),
    prisma.poolMetricsDaily.findMany({ where: { day: { gte: from } }, select: { day: true, capacity: true, committed: true } }),
  ]);
  const todayKey = dayKeyOf(now);
  // Capacity and what customers asked for are levels: they hold until something changes them. A day with no snapshot
  // (the job didn't run) keeps the last known level instead of breaking the line; before the first snapshot it stays
  // empty, because the pool didn't exist yet.
  let lastCapacity: number | null = null;
  let lastCommitted: number | null = null;
  return Array.from({ length: 30 }, (_, i) => {
    const key = dayKeyOf(new Date(from.getTime() + i * DAY));
    const h = health.find((r) => dayKeyOf(r.day) === key);
    const m = metrics.find((r) => dayKeyOf(r.day) === key);
    const isToday = key === todayKey;
    const sends = isToday ? Math.max(today.sentToday, h?._sum.sends ?? 0) : (h?._sum.sends ?? 0);
    // Weighted the way the burn rule weighs it: a complaint counts as ten hard bounces.
    const bad = (h?._sum.hardBounces ?? 0) + COMPLAINT_WEIGHT * (h?._sum.complaints ?? 0);
    lastCapacity = isToday ? today.capacity : (m?.capacity ?? lastCapacity);
    lastCommitted = isToday ? today.committed : (m?.committed ?? lastCommitted);
    return {
      day: key,
      sends,
      bad,
      badRate: sends ? Number((bad / sends).toFixed(4)) : null,
      capacity: lastCapacity,
      committed: lastCommitted,
    };
  });
}

const dayDiff = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / DAY);
const IN_SERVICE = ["CONNECTING", "WARMING", "ACTIVE"];
export const HELD_DAYS = 3;

// ─── the console ────────────────────────────────────────────────────────────

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export async function consoleView(now = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const monthAgo = new Date(now.getTime() - 30 * DAY);
  const [domains, mailboxes, degraded7, degraded30, retiredMonth, weekly, risks, capacity, reorders] = await Promise.all([
    prisma.sendingDomain.findMany({
      where: pool,
      select: {
        id: true, name: true, status: true, registrar: true, nameserverSet: true, ipPoolId: true, prewarmed: true, pausedAt: true, pauseReason: true, spfOk: true, dkimOk: true, dmarcOk: true,
        agingUntil: true, warmupStartedAt: true, activatedAt: true, degradedAt: true, retiredAt: true, degradeReason: true, degradeBounceRate: true, degradeSends: true,
        forcedActiveAt: true, forcedActiveById: true, forcedActiveReason: true, forcedFromDay: true,
        mailboxes: { select: { status: true, warmupDay: true, warmupCheckedOn: true, warmupStartedAt: true, sendCapToday: true } },
      },
    }),
    prisma.mailbox.groupBy({ by: ["status"], where: pool, _count: { _all: true } }),
    prisma.sendingDomain.count({ where: { ...pool, degradedAt: { gte: weekAgo } } }),
    prisma.sendingDomain.count({ where: { ...pool, degradedAt: { gte: monthAgo } } }),
    prisma.sendingDomain.count({ where: { ...pool, retiredAt: { gte: monthAgo } } }),
    weeklyDegraded(now),
    computeRiskScores(now),
    poolCapacity(),
    prisma.poolReorder.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const series = ewmaSeries(weekly);
  const ewma = series.length ? series[series.length - 1] : 0;
  const count = (s: string) => mailboxes.find((m) => m.status === s)?._count._all ?? 0;
  const active = domains.filter((d) => d.status === "ACTIVE");
  const warming = domains.filter((d) => d.status === "WARMING");
  const aging = domains.filter((d) => d.status === "AGING");
  const atRisk = risks.filter((r) => r.band === "AT_RISK");
  const predicted = predictedBurn(atRisk.length, active.length, ewma);
  const targets = await restockTargets(capacity);
  const shelf = shelfRunway(aging.length + warming.length, ewma, targets);

  // Warming pipeline by how far each domain's slowest mailbox has got.
  const bucket = (d: (typeof warming)[number]) => {
    const days = d.mailboxes.filter((m) => m.status === "WARMING" || m.status === "ACTIVE").map((m) => m.warmupDay);
    const day = days.length ? Math.min(...days) : 0;
    return day <= 7 ? "d1-7" : day <= 14 ? "d8-14" : day <= 21 ? "d15-21" : "d22-28";
  };
  const pipeline = { aging: aging.length, "d1-7": 0, "d8-14": 0, "d15-21": 0, "d22-28": 0 } as Record<string, number>;
  for (const d of warming) pipeline[bucket(d)]++;

  // Committed: what launched customers asked for each day. Internal outreach only uses what is left over.
  // Emails a day are the daily budget at $0.04 an email.
  const committed = targets.committed;
  const internal = await committedEmails("INTERNAL");
  const headroom = capacity ? (capacity - committed) / capacity : 0;
  // Room for more customers at 500 emails a day ($20 a day), once their sequences are running at full volume.
  const roomFor500 = capacity ? Math.max(0, Math.floor((capacity - committed) / 500)) : 0;
  const dilution = await computeDilution(now);
  const paused = domains.filter((d) => d.pausedAt);
  const sentToday = await prisma.send.count({ where: { domainId: { in: domains.map((d) => d.id) }, sentAt: { gte: new Date(new Date(now).setUTCHours(0, 0, 0, 0)) }, status: { in: [...DELIVERED_OR_BOUNCED] } } });

  // Revenue. Costs come from costStack below, the one place they are worked out.
  const revenueAgg = await prisma.creditLedger.aggregate({ where: { kind: "CHARGE", sendId: { not: null }, createdAt: { gte: monthAgo }, organization: { kind: "CUSTOMER" } }, _sum: { amount: true } });
  const revenue = -(revenueAgg._sum.amount ?? 0n);

  const concentration = (key: "registrar" | "nameserverSet" | "ipPoolId") => {
    const live = domains.filter((d) => d.status !== "RETIRED");
    const m = new Map<string, number>();
    for (const d of live) m.set(d[key] ?? "unknown", (m.get(d[key] ?? "unknown") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, n]) => ({ value, domains: n, share: live.length ? pct(n / live.length) : "0.0%" }));
  };

  // Warming up: where each domain on the shelf is, when it should go live, and whether its ladder has stalled.
  const shelfDomains = [...aging, ...warming];
  const rates = await sevenDayRates([...shelfDomains.map((d) => d.id), ...domains.filter((d) => d.forcedActiveAt).map((d) => d.id)], now);
  const today = new Date(now.getTime());
  const warmingRows = shelfDomains
    .map((d) => {
      const boxes = d.mailboxes.filter((m) => IN_SERVICE.includes(m.status));
      const day = d.status === "WARMING" && boxes.length ? Math.min(...boxes.map((m) => m.warmupDay)) : 0;
      const remaining = Math.max(0, WARMUP_DAYS_TO_ACTIVE - day);
      const activeOn = d.status === "AGING" ? new Date((d.agingUntil ?? now).getTime() + WARMUP_DAYS_TO_ACTIVE * DAY) : new Date(today.getTime() + remaining * DAY);
      // Held: the slowest mailbox is 3 or more days behind where the ladder would have it, or the ladder has not
      // been checked for 3 days.
      const laggards = boxes.filter((m) => m.status === "WARMING");
      const behind = laggards.length
        ? Math.max(
            ...laggards.map((m) => {
              const expected = m.warmupStartedAt ? Math.min(WARMUP_DAYS_TO_ACTIVE, dayDiff(now, m.warmupStartedAt) + 1) : m.warmupDay;
              const unchecked = m.warmupCheckedOn ? dayDiff(now, m.warmupCheckedOn) : 0;
              return Math.max(expected - m.warmupDay, unchecked);
            }),
          )
        : 0;
      const r = rates.get(d.id);
      return {
        id: d.id,
        domain: d.name,
        status: d.status,
        warmupDay: day,
        daysRemaining: d.status === "AGING" ? Math.max(0, dayDiff(d.agingUntil ?? now, now)) + WARMUP_DAYS_TO_ACTIVE : remaining,
        activeOn,
        capToday: boxes.reduce((a, m) => a + (m.status === "CONNECTING" ? 0 : m.sendCapToday), 0),
        mailboxes: boxes.length,
        bounce7: r ? Number(r.rate.toFixed(4)) : 0,
        sends7: r?.sends ?? 0,
        held: d.status === "WARMING" && behind >= HELD_DAYS,
        behindDays: d.status === "WARMING" ? behind : 0,
      };
    })
    .sort((a, b) => a.activeOn.getTime() - b.activeOn.getTime());

  // Burned in the last 30 days, newest first, with what decided it.
  const burned = domains
    .filter((d) => (d.degradedAt && d.degradedAt >= monthAgo) || (d.retiredAt && d.retiredAt >= monthAgo))
    .map((d) => {
      const retired = !!d.retiredAt && d.retiredAt >= monthAgo;
      const on = retired ? d.retiredAt! : d.degradedAt!;
      return {
        id: d.id,
        domain: d.name,
        kind: retired ? ("retired" as const) : ("degraded" as const),
        on,
        reason: d.degradeReason,
        reasonKind: burnKind(d.degradeReason),
        bounceRate: d.degradeBounceRate === null ? null : Number(d.degradeBounceRate),
        sends: d.degradeSends,
        daysLasted: d.activatedAt && d.degradedAt ? dayDiff(d.degradedAt, d.activatedAt) : null,
        forcedFromDay: d.forcedActiveAt ? d.forcedFromDay : null,
      };
    })
    .sort((a, b) => b.on.getTime() - a.on.getTime());

  // Promoted early by an operator: kept in view so a later burn traces back to the decision.
  const forcedUsers = await prisma.user.findMany({ where: { id: { in: domains.map((d) => d.forcedActiveById).filter((x): x is string => !!x) } }, select: { id: true, email: true } });
  const forced = domains
    .filter((d) => d.forcedActiveAt)
    .map((d) => ({
      id: d.id,
      domain: d.name,
      status: d.status,
      at: d.forcedActiveAt,
      fromDay: d.forcedFromDay,
      reason: d.forcedActiveReason,
      by: forcedUsers.find((u) => u.id === d.forcedActiveById)?.email ?? null,
      bounce7: Number((rates.get(d.id)?.rate ?? 0).toFixed(4)),
    }))
    .sort((a, b) => b.at!.getTime() - a.at!.getTime());

  const byStatus = <T extends string>(xs: { status: T }[], all: readonly T[]) => Object.fromEntries(all.map((k) => [k, xs.filter((x) => x.status === k).length])) as Record<T, number>;
  const degradedNow = domains.filter((d) => d.status === "DEGRADED");
  const charts = {
    daily: await dailyTrend(domains.map((d) => d.id), now, { capacity, committed, sentToday }),
    ewma: series.map((v) => Number(v.toFixed(3))),
    domains: byStatus(domains, ["REGISTERED", "AGING", "WARMING", "ACTIVE", "DEGRADED", "RETIRED"] as const),
    mailboxes: Object.fromEntries(["CONNECTING", "ERROR", "WARMING", "ACTIVE", "REPLIES_ONLY", "RETIRED"].map((k) => [k, count(k)])),
    burnImpact: await burnImpact(degradedNow, await costPrices(), now),
  };

  return {
    version: CONSOLE_VERSION,
    charts,
    burned,
    forced,
    health: {
      activeDomains: active.length,
      activeMailboxes: count("ACTIVE"),
      warmingDomains: warming.length,
      warmingMailboxes: count("WARMING"),
      repliesOnlyMailboxes: count("REPLIES_ONLY"),
      retiredThisMonth: retiredMonth,
    },
    burn: {
      degraded7,
      degraded30,
      ewmaWeeklyBurn: Number(ewma.toFixed(3)),
      // Out of every domain that was sending at some point in the 30 days: the ones still active plus the ones that
      // burned (a burned domain is no longer active, so dividing by today's active count alone overstates the rate).
      burnRatePerMonth: active.length + degraded30 ? pct(degraded30 / (active.length + degraded30)) : "0.0%",
      predicted30: { total: Math.round(predicted.total), atRisk: predicted.atRisk, background: Math.round(predicted.background) },
      weekly,
      dilution: dilution === null ? null : Number(dilution.toFixed(1)),
      dilutionRegime: dilutionRegime(dilution),
    },
    shelf: {
      warmShelf: aging.length + warming.length,
      // How long the spares last at the current burn. With nothing burning there is no rate to divide by, so no runway.
      runwayWeeks: ewma > 0 ? Number(shelf.runwayWeeks.toFixed(1)) : null,
      reorderNeeded: shelf.reorder,
      domainsToBuy: shelf.domainsToBuy,
      reorderBecause: shelf.reorderBecause,
      targets: { spareDomainsMin: targets.spareDomainsMin, spareMultiplier: targets.spareMultiplier, maxBuyPerBatch: targets.maxBuyPerBatch, leadTimeWeeks: LEAD_TIME_WEEKS, agingDays: AGING_DAYS, warmupDays: WARMUP_DAYS_TO_ACTIVE },
      pipeline,
      warming: warmingRows,
    },
    capacity: { total: capacity, committed, internal, sentToday, headroom: pct(headroom), roomFor500PerDay: roomFor500, domainDailyCap: DOMAIN_DAILY_CAP },
    paused: paused.map((d) => ({ id: d.id, domain: d.name, since: d.pausedAt, reason: d.pauseReason })),
    authentication: {
      unverified: domains.filter((d) => d.status !== "RETIRED" && (!d.spfOk || !d.dkimOk || !d.dmarcOk)).map((d) => ({ domain: d.name, spf: !!d.spfOk, dkim: !!d.dkimOk, dmarc: !!d.dmarcOk })),
    },
    economics: await costStack(now),
    cost: { monthlyRevenue: formatUsd(revenue) },
    atRisk: risks
      .filter((r) => r.band === "AT_RISK" || r.band === "WATCH")
      .sort((a, b) => (b.risk ?? 0) - (a.risk ?? 0))
      // The band the score falls in. It is a score, not a forecast, so no "burns within a week" claim is made.
      .map((r) => ({ domain: r.name, sends7: r.sends7, bounce7: pct(r.br7), trend: `${r.trend >= 0 ? "+" : ""}${pct(r.trend)}`, risk: Number((r.risk ?? 0).toFixed(2)), band: r.band === "AT_RISK" ? ("at risk" as const) : ("watch" as const) })),
    footprint: { registrar: concentration("registrar"), nameserverSet: concentration("nameserverSet"), ipPool: concentration("ipPoolId") },
    reorders: reorders.map((r) => ({
      id: r.id,
      status: r.status,
      domainsToBuy: r.domainsToBuy,
      // A request raised while nothing was burning has no real runway (it was raised for the spare minimum or demand).
      runwayWeeks: Number(r.ewmaBurn) > 0 ? Number(r.runwayWeeks) : null,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
      note: r.note,
      // Neutral names to buy, varied over TLDs, never one already in the pool.
      suggestions: r.status === "PENDING" || r.status === "APPROVED" ? planBatch(Math.max(3, Math.min(r.domainsToBuy, 10)), r.createdAt.getTime(), domains.map((d) => d.name)).map((p) => p.domain) : [],
    })),
    unmatched: await unmatchedTrend(now),
  };
}

/** The unmatched inbound queue: open now, and its size day by day. A growing queue means thread matching broke. */
async function unmatchedTrend(now: Date) {
  const [open, rows] = await Promise.all([
    prisma.inboundMessage.count({ where: { kind: "unmatched", handledAt: null } }),
    prisma.poolMetricsDaily.findMany({ where: { day: { gte: dateOnly(dayKeyOf(new Date(now.getTime() - 30 * DAY))) } }, orderBy: { day: "asc" }, select: { day: true, unmatchedOpen: true } }),
  ]);
  return { open, daily: rows.filter((r) => r.unmatchedOpen !== null).map((r) => ({ day: dayKeyOf(r.day), open: r.unmatchedOpen as number })) };
}

const CONSOLE_FRESH_MS = 30 * 60_000;
/** Bumped when the console's shape changes, so a copy cached before a deploy is recomputed, not served. */
export const CONSOLE_VERSION = 7;

/** Every 15 minutes: computes the console and stores it on today's metrics row. */
export async function cacheConsole(now = new Date()) {
  const day = dateOnly(dayKeyOf(now));
  if (!(await prisma.poolMetricsDaily.findUnique({ where: { day }, select: { day: true } }))) await snapshotPoolMetrics(now);
  const view = await consoleView(now);
  await prisma.poolMetricsDaily.update({ where: { day }, data: { console: JSON.parse(JSON.stringify(view)) as Prisma.InputJsonValue, consoleAt: now } });
  return view;
}

/** After an operator acts (restock, resume, unmatched), the next page load recomputes. */
export async function invalidateConsole() {
  await prisma.poolMetricsDaily.updateMany({ where: { consoleAt: { not: null } }, data: { consoleAt: null } });
}

/** What /admin/pool shows: the cached aggregates when recent, computed (and cached) only when they are not. */
export async function cachedConsole(opts: { fresh?: boolean } = {}) {
  if (!opts.fresh) {
    const row = await prisma.poolMetricsDaily.findFirst({ where: { consoleAt: { gte: new Date(Date.now() - CONSOLE_FRESH_MS) } }, orderBy: { consoleAt: "desc" }, select: { console: true, consoleAt: true } });
    if (row?.console && (row.console as { version?: number }).version === CONSOLE_VERSION) return { ...(row.console as Record<string, unknown>), cachedAt: row.consoleAt };
  }
  const now = new Date();
  return { ...(JSON.parse(JSON.stringify(await cacheConsole(now))) as Record<string, unknown>), cachedAt: now };
}
