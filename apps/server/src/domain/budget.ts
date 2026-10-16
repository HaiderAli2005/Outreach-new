import { prisma } from "../lib/prisma.js";
import { dateKeyInTz, tzMidnightUtc } from "../lib/time.js";
import { getSettings } from "./settings.js";
import { PRICE_PER_EMAIL, type DeciCents } from "./money.js";
import { BUDGET_MAX_DECICENTS, VOLUME_MAX } from "../config/plans.js";
import type { OrgSettings } from "@prisma/client";

/**
 * The daily budget: the one number the customer moves to speed up, slow down or stop, the same on setup, the
 * dashboard and Credits. 0 means paused; null means no cap (admin only). Emails a day are never stored: they are the
 * budget divided by the price of an email, exactly. "Today" is the workspace's own day.
 */
export function emailsPerDay(s: Pick<OrgSettings, "dailyBudgetDecicents">): number {
  const b = s.dailyBudgetDecicents;
  if (b === null || b === undefined) return VOLUME_MAX;
  return b <= 0n ? 0 : Number(b / PRICE_PER_EMAIL);
}

export async function spentToday(orgId: string, now = new Date()): Promise<DeciCents> {
  const s = await getSettings(orgId);
  const since = tzMidnightUtc(dateKeyInTz(s.timezone, now), s.timezone);
  const agg = await prisma.send.aggregate({ where: { organizationId: orgId, sentAt: { gte: since } }, _sum: { priceCharged: true } });
  return agg._sum.priceCharged ?? 0n;
}

export async function budgetView(orgId: string) {
  const s = await getSettings(orgId);
  const spent = await spentToday(orgId);
  const budget = s.dailyBudgetDecicents;
  return {
    budget: budget === null ? null : budget.toString(),
    spentToday: spent.toString(),
    state: budget === null ? "uncapped" : budget <= 0n ? "paused" : spent >= budget ? "reached" : "running",
  } as const;
}

/**
 * The dashboard's budget card: today's spend against the budget, what it sent and who it reached, the balance and
 * how long it lasts. The nudge to raise the budget appears only when today's budget is actually used up AND people
 * were left waiting, and it uses the customer's own measured reply rate, labelled an estimate, never a range.
 */
export async function budgetCard(orgId: string, now = new Date()) {
  const s = await getSettings(orgId);
  const since = tzMidnightUtc(dateKeyInTz(s.timezone, now), s.timezone);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const [spent, sentToday, peopleToday, lastCharged, waiting, firstTouches30, replies30] = await Promise.all([
    spentToday(orgId, now),
    prisma.send.count({ where: { organizationId: orgId, sentAt: { gte: since }, step: { gte: 1 }, status: { not: "REJECTED" } } }),
    prisma.send.count({ where: { organizationId: orgId, sentAt: { gte: since }, isFirstTouch: true, status: { not: "REJECTED" } } }),
    prisma.send.findFirst({ where: { organizationId: orgId, sentAt: { gte: since }, priceCharged: { gt: 0n } }, orderBy: { sentAt: "desc" }, select: { sentAt: true } }),
    prisma.contact.count({ where: { organizationId: orgId, status: { in: ["PERSONALIZED", "QUEUED"] }, sequenceStoppedAt: null, firstContactedAt: null, campaign: { status: "ACTIVE" } } }),
    prisma.send.count({ where: { organizationId: orgId, sentAt: { gte: monthAgo }, isFirstTouch: true, status: { not: "REJECTED" } } }),
    prisma.contact.count({ where: { organizationId: orgId, repliedAt: { gte: monthAgo } } }),
  ]);
  const budget = s.dailyBudgetDecicents;
  const reached = budget !== null && budget > 0n && spent + PRICE_PER_EMAIL > budget;
  // Measured, not assumed: only once there are enough first emails to mean something.
  const replyRate = firstTouches30 >= 50 ? replies30 / firstTouches30 : null;
  let nudge = null;
  if (reached && waiting > 0 && budget !== null) {
    const room = BUDGET_MAX_DECICENTS - budget;
    // Enough to start today's waiting people, in whole dollars, never more than doubling the budget.
    const want = BigInt(waiting) * PRICE_PER_EMAIL;
    let raise = want < budget ? want : budget;
    if (raise > room) raise = room;
    raise = ((raise + 999n) / 1000n) * 1000n;
    if (raise > room) raise = room - (room % 1000n);
    if (raise > 0n) {
      const morePeoplePerMonth = Math.floor(Number(raise / PRICE_PER_EMAIL) / 4) * 22;
      nudge = {
        hitAt: lastCharged?.sentAt ?? null,
        sentToday,
        waiting,
        raiseBy: raise.toString(),
        raiseTo: (budget + raise).toString(),
        replyRate,
        morePeoplePerMonth,
        moreRepliesPerMonth: replyRate === null ? null : Math.round(morePeoplePerMonth * replyRate),
      };
    }
  }
  return {
    budget: budget === null ? null : budget.toString(),
    spentToday: spent.toString(),
    emailsPerDay: emailsPerDay(s),
    sentToday,
    peopleToday,
    state: budget === null ? "uncapped" : budget <= 0n ? "paused" : reached ? "reached" : "running",
    nudge,
  };
}
