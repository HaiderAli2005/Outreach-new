import type { CostSettings, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { DEFAULT_COST_PRICES, type CostPrices, type TokenPrice } from "../config/internalCosts.js";

const toPrices = (r: CostSettings): CostPrices => ({
  aiPrices: r.aiPrices as unknown as Record<string, TokenPrice>,
  apolloPerEnrichUsd: Number(r.apolloPerEnrichUsd),
  apolloPerSearchUsd: Number(r.apolloPerSearchUsd),
  verifyPerEmailUsd: Number(r.verifyPerEmailUsd),
  paymentFeePercent: Number(r.paymentFeePercent),
  paymentFeeFixedUsd: Number(r.paymentFeeFixedUsd),
  mailboxMonthUsd: Number(r.mailboxMonthUsd),
  repliesOnlyMailboxMonthUsd: Number(r.repliesOnlyMailboxMonthUsd),
  domainYearUsd: Number(r.domainYearUsd),
});

const seed = () => ({ id: "default", ...DEFAULT_COST_PRICES, aiPrices: DEFAULT_COST_PRICES.aiPrices as unknown as Prisma.InputJsonValue });

/** The unit prices in force: the saved row, created from the defaults on first read. */
export async function costPrices(): Promise<CostPrices & { updatedAt: Date }> {
  const row = await prisma.costSettings.upsert({ where: { id: "default" }, create: seed(), update: {} });
  return { ...toPrices(row), updatedAt: row.updatedAt };
}

export async function updateCostPrices(patch: Partial<CostPrices>, userId: string): Promise<CostPrices & { updatedAt: Date }> {
  const { aiPrices, ...units } = patch;
  const data = { ...units, ...(aiPrices ? { aiPrices: aiPrices as unknown as Prisma.InputJsonValue } : {}), updatedById: userId };
  const row = await prisma.costSettings.upsert({ where: { id: "default" }, create: { ...seed(), ...data }, update: data });
  return { ...toPrices(row), updatedAt: row.updatedAt };
}
