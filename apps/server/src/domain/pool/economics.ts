import { prisma } from "../../lib/prisma.js";
import { aiCallUsd } from "../../config/internalCosts.js";
import { PRICE_PER_EMAIL, DOLLAR } from "../money.js";
import { costPrices } from "../costPrices.js";
import { DELIVERED_OR_BOUNCED } from "./lifecycle.js";

/**
 * What one email really costs us, from what was used in the last 30 days at the prices in CostSettings:
 * infrastructure, AI (from recorded tokens), data, verification and card fees, against the price charged.
 * Per domain, infrastructure is spread over that domain's own sending pace, so a warming domain shows its true cost.
 */

const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const PACE_DAYS = 7;
const PRICE_USD = Number(PRICE_PER_EMAIL) / Number(DOLLAR);
const PAID = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"] as const;

const round = (n: number, places = 5) => Number(n.toFixed(places));
const per = (total: number, emails: number) => (emails ? round(total / emails) : null);

type Line = { key: "infrastructure" | "ai" | "data" | "verification" | "fees"; label: string; month: number; perEmail: number | null };

export async function costStack(now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const paceSince = new Date(now.getTime() - PACE_DAYS * DAY);
  const prices = await costPrices();
  const [domains, emails, ai, aiCallsCounted, usage, payments, revenueAgg, paced] = await Promise.all([
    prisma.sendingDomain.findMany({ where: { status: { not: "RETIRED" } }, select: { id: true, name: true, status: true, mailboxes: { select: { status: true, warmupDay: true } } } }),
    prisma.send.count({ where: { sentAt: { gte: since }, status: { in: [...DELIVERED_OR_BOUNCED] } } }),
    prisma.aiUsage.groupBy({ by: ["purpose", "model"], where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true } }),
    prisma.aiUsage.count({ where: { createdAt: { gte: since }, purpose: { not: "fact-check" } } }),
    prisma.usageCounter.aggregate({ where: { day: { gte: since } }, _sum: { peopleEnriched: true, searches: true, emailsVerified: true, aiCalls: true } }),
    prisma.payment.aggregate({ where: { createdAt: { gte: since }, status: { in: [...PAID] } }, _sum: { amountCents: true }, _count: { _all: true } }),
    prisma.creditLedger.aggregate({ where: { kind: "CHARGE", sendId: { not: null }, createdAt: { gte: since }, organization: { kind: "CUSTOMER" } }, _sum: { amount: true } }),
    prisma.send.groupBy({ by: ["domainId"], where: { sentAt: { gte: paceSince }, status: { in: [...DELIVERED_OR_BOUNCED] }, domainId: { not: null } }, _count: { _all: true } }),
  ]);

  // Infrastructure, per domain and in total, at the unit prices: mailboxes billed each month, the registration spread over 12.
  const domainMonthUsd = (d: (typeof domains)[number]) => {
    const live = d.mailboxes.filter((m) => m.status === "ACTIVE" || m.status === "WARMING").length;
    const quiet = d.mailboxes.filter((m) => m.status === "REPLIES_ONLY").length;
    return live * prices.mailboxMonthUsd + quiet * prices.repliesOnlyMailboxMonthUsd + prices.domainYearUsd / 12;
  };
  const infraMonth = domains.reduce((a, d) => a + domainMonthUsd(d), 0);

  // AI from the tokens each call really used.
  const byPurpose = new Map<string, { calls: number; usd: number; inputTokens: number; outputTokens: number }>();
  for (const g of ai) {
    const t = { inputTokens: g._sum.inputTokens ?? 0, cachedInputTokens: g._sum.cachedInputTokens ?? 0, outputTokens: g._sum.outputTokens ?? 0 };
    const p = byPurpose.get(g.purpose) ?? { calls: 0, usd: 0, inputTokens: 0, outputTokens: 0 };
    p.calls += g._count._all;
    p.usd += aiCallUsd(g.model, t, prices.aiPrices);
    p.inputTokens += t.inputTokens;
    p.outputTokens += t.outputTokens;
    byPurpose.set(g.purpose, p);
  }
  const aiMonth = [...byPurpose.values()].reduce((a, p) => a + p.usd, 0);
  // Calls counted before token recording existed (or by a path that does not record) have no price.
  const unmeasuredAiCalls = Math.max(0, (usage._sum.aiCalls ?? 0) - aiCallsCounted);

  const dataMonth = (usage._sum.peopleEnriched ?? 0) * prices.apolloPerEnrichUsd + (usage._sum.searches ?? 0) * prices.apolloPerSearchUsd;
  const verifyMonth = (usage._sum.emailsVerified ?? 0) * prices.verifyPerEmailUsd;
  const feesMonth = ((payments._sum.amountCents ?? 0) / 100) * (prices.paymentFeePercent / 100) + payments._count._all * prices.paymentFeeFixedUsd;

  const lines: Line[] = [
    { key: "infrastructure", label: "Infrastructure (mailboxes and domains)", month: round(infraMonth, 2), perEmail: per(infraMonth, emails) },
    { key: "ai", label: "AI (writing, fact checks, replies)", month: round(aiMonth, 2), perEmail: per(aiMonth, emails) },
    { key: "data", label: "Data (Apollo)", month: round(dataMonth, 2), perEmail: per(dataMonth, emails) },
    { key: "verification", label: "Verification (MillionVerifier)", month: round(verifyMonth, 2), perEmail: per(verifyMonth, emails) },
    { key: "fees", label: "Card fees (Stripe)", month: round(feesMonth, 2), perEmail: per(feesMonth, emails) },
  ];
  const costMonth = infraMonth + aiMonth + dataMonth + verifyMonth + feesMonth;
  const costPerEmail = per(costMonth, emails);
  const variablePerEmail = emails ? (aiMonth + dataMonth + verifyMonth + feesMonth) / emails : 0;
  const revenueMonth = -Number(revenueAgg._sum.amount ?? 0n) / Number(DOLLAR);

  const pace = new Map(paced.map((p) => [p.domainId, p._count._all / PACE_DAYS]));
  const perDomain = domains
    .filter((d) => d.mailboxes.length)
    .map((d) => {
      const month = domainMonthUsd(d);
      const perDay = round(pace.get(d.id) ?? 0, 1);
      const infraPerEmail = perDay ? round(month / 30 / perDay) : null;
      const total = infraPerEmail === null ? null : round(infraPerEmail + variablePerEmail);
      const days = d.mailboxes.filter((m) => m.status === "ACTIVE" || m.status === "WARMING").map((m) => m.warmupDay);
      return {
        id: d.id,
        domain: d.name,
        status: d.status,
        warmupDay: days.length ? Math.min(...days) : null,
        mailboxes: d.mailboxes.filter((m) => m.status !== "RETIRED").length,
        perDay,
        monthlyInfra: round(month, 2),
        infraPerEmail,
        costPerEmail: total,
        marginPerEmail: total === null ? null : round(PRICE_USD - total),
      };
    })
    .sort((a, b) => (b.costPerEmail ?? Infinity) - (a.costPerEmail ?? Infinity));

  return {
    windowDays: WINDOW_DAYS,
    paceDays: PACE_DAYS,
    price: PRICE_USD,
    emails,
    lines,
    total: { month: round(costMonth, 2), perEmail: costPerEmail },
    margin: {
      perEmail: costPerEmail === null ? null : round(PRICE_USD - costPerEmail),
      perEmailPct: costPerEmail === null ? null : round(((PRICE_USD - costPerEmail) / PRICE_USD) * 100, 1),
      revenueMonth: round(revenueMonth, 2),
      month: round(revenueMonth - costMonth, 2),
      monthPct: revenueMonth > 0 ? round(((revenueMonth - costMonth) / revenueMonth) * 100, 1) : null,
    },
    ai: {
      byPurpose: [...byPurpose.entries()].map(([purpose, p]) => ({ purpose, calls: p.calls, usd: round(p.usd, 2), perCall: round(p.usd / p.calls), avgInputTokens: Math.round(p.inputTokens / p.calls), avgOutputTokens: Math.round(p.outputTokens / p.calls) })).sort((a, b) => b.usd - a.usd),
      unmeasuredCalls: unmeasuredAiCalls,
    },
    usage: { peopleEnriched: usage._sum.peopleEnriched ?? 0, searches: usage._sum.searches ?? 0, emailsVerified: usage._sum.emailsVerified ?? 0, payments: payments._count._all },
    perDomain,
    pricesUpdatedAt: prices.updatedAt,
  };
}
