import { prisma } from "../lib/prisma.js";
import { dateOnly, dayKeyOf } from "../lib/time.js";

type Meter = "peopleEnriched" | "searches" | "emailsVerified" | "aiCalls";

export async function addUsage(orgId: string, meter: Meter, amount = 1): Promise<void> {
  if (!amount) return;
  const day = dateOnly(dayKeyOf(new Date()));
  await prisma.usageCounter.upsert({
    where: { organizationId_day: { organizationId: orgId, day } },
    create: { organizationId: orgId, day, [meter]: amount },
    update: { [meter]: { increment: amount } },
  });
}

export const WORKING_DAYS_PER_MONTH = 22;

export function cycleStart(resetDay: number, now = new Date()): Date {
  const d = Math.min(28, Math.max(1, resetDay));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d));
  if (start > now) start.setUTCMonth(start.getUTCMonth() - 1);
  return start;
}

export async function creditsSpent(orgId: string, from: Date): Promise<number> {
  const agg = await prisma.usageCounter.aggregate({ where: { organizationId: orgId, day: { gte: from } }, _sum: { peopleEnriched: true } });
  return agg._sum.peopleEnriched ?? 0;
}

export async function creditPacing(orgId: string, s: { monthlyCreditCap: number; dailyCreditCap: number; apolloCycleResetDay: number }) {
  const start = cycleStart(s.apolloCycleResetDay);
  const spentCycle = await creditsSpent(orgId, start);
  const today = await prisma.usageCounter.findUnique({ where: { organizationId_day: { organizationId: orgId, day: dateOnly(dayKeyOf(new Date())) } } });
  const spentToday = today?.peopleEnriched ?? 0;
  if (!s.monthlyCreditCap) return { unlimited: true, spentCycle, spentToday, remainingCycle: null as number | null, allowanceToday: s.dailyCreditCap || null };
  const remainingCycle = Math.max(0, s.monthlyCreditCap - spentCycle);
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const daysLeft = Math.max(1, Math.ceil((next.getTime() - Date.now()) / 86_400_000));
  let allowance = Math.floor(remainingCycle / daysLeft);
  if (s.dailyCreditCap) allowance = Math.min(allowance, s.dailyCreditCap);
  return { unlimited: false, spentCycle, spentToday, remainingCycle, allowanceToday: Math.max(0, allowance - spentToday) };
}
