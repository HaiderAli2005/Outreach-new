import type { WeeklyBatch } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { dateKeyInTz, dateOnly, dayKeyOf, dayOfWeekInTz, mondayOf, nextMondayOf } from "../lib/time.js";
import { hmac, safeEqual } from "../lib/crypto.js";
import { env } from "../config/env.js";
import { SEND_FLOOR } from "./scoring.js";
import { autoApproves, getSettings, weeksApprovable } from "./settings.js";
import { approval } from "./approval.js";
import { reviewsWeekly } from "./supply.js";

export interface BatchStats {
  total: number;
  excluded: number;
  sendable: number;
  /** Of the sendable, those whose emails are already written. The rest are still being checked and written. */
  written: number;
  belowFloor: number;
  tierA: number;
  tierB: number;
  avgFit: number | null;
  pushed: number;
  byCampaign: { campaignId: string | null; name: string | null; count: number }[];
}

const PENDING_STATUSES = ["NEW", "PERSONALIZED", "QUEUED"] as const;

export async function batchStats(orgId: string, batchId: string): Promise<BatchStats> {
  const base = { organizationId: orgId, batchId };
  const [total, excluded, sendable, written, belowFloor, tierA, tierB, pushed, avg, byCampaign] = await Promise.all([
    prisma.contact.count({ where: base }),
    prisma.contact.count({ where: { ...base, status: "REJECTED" } }),
    prisma.contact.count({ where: { ...base, status: { in: [...PENDING_STATUSES] }, fitScore: { gte: SEND_FLOOR } } }),
    prisma.contact.count({ where: { ...base, status: { in: ["PERSONALIZED", "QUEUED"] }, fitScore: { gte: SEND_FLOOR } } }),
    prisma.contact.count({ where: { ...base, status: { in: [...PENDING_STATUSES] }, fitScore: { lt: SEND_FLOOR } } }),
    prisma.contact.count({ where: { ...base, tier: "A" } }),
    prisma.contact.count({ where: { ...base, tier: "B" } }),
    prisma.contact.count({ where: { ...base, status: { in: ["CONTACTED", "REPLIED"] } } }),
    prisma.contact.aggregate({ where: base, _avg: { fitScore: true } }),
    prisma.contact.groupBy({ by: ["campaignId"], where: { ...base, status: { not: "REJECTED" } }, _count: { _all: true } }),
  ]);
  const campaigns = await prisma.campaign.findMany({
    where: { organizationId: orgId, id: { in: byCampaign.map((b) => b.campaignId).filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  });
  return {
    total,
    excluded,
    sendable,
    written,
    belowFloor,
    tierA,
    tierB,
    pushed,
    avgFit: avg._avg.fitScore != null ? Math.round(avg._avg.fitScore * 10) / 10 : null,
    byCampaign: byCampaign
      .map((b) => ({ campaignId: b.campaignId, name: campaigns.find((c) => c.id === b.campaignId)?.name ?? null, count: b._count._all }))
      .sort((a, b) => b.count - a.count),
  };
}

export async function getOrCreateBatch(orgId: string, weekStart: string, targetClean: number): Promise<WeeklyBatch> {
  return prisma.weeklyBatch.upsert({
    where: { organizationId_weekStart: { organizationId: orgId, weekStart: dateOnly(weekStart) } },
    create: { organizationId: orgId, weekStart: dateOnly(weekStart), targetClean },
    update: {},
  });
}

export async function getBatchByWeek(orgId: string, weekStart: string): Promise<WeeklyBatch | null> {
  return prisma.weeklyBatch.findUnique({ where: { organizationId_weekStart: { organizationId: orgId, weekStart: dateOnly(weekStart) } } });
}

export async function excludeLeads(orgId: string, batchId: string, contactIds: string[]): Promise<number> {
  if (!contactIds.length) return 0;
  const r = await prisma.contact.updateMany({
    where: { organizationId: orgId, batchId, id: { in: contactIds }, status: { in: [...PENDING_STATUSES] } },
    data: { status: "REJECTED" },
  });
  if (r.count) await prisma.weeklyBatch.update({ where: { id: batchId }, data: { excludedCount: { increment: r.count } } });
  return r.count;
}

export type ApproveResult = { ok: true; approved: number; excluded: number } | { ok: false; error: string };

export async function approveBatch(orgId: string, batchId: string, excludeContactIds: string[] = [], source: "review" | "auto" = "review"): Promise<ApproveResult> {
  const batch = await prisma.weeklyBatch.findFirst({ where: { id: batchId, organizationId: orgId } });
  if (!batch) return { ok: false, error: "That week's list can't be found anymore." };
  if (["APPROVED", "SENDING", "DONE"].includes(batch.status)) return { ok: false, error: "This week was already approved, nothing more to do." };
  if (!weeksApprovable(await getSettings(orgId))) return { ok: false, error: "Approve your first people on the Launch page first. Weekly lists open after that." };
  if (excludeContactIds.length) await excludeLeads(orgId, batchId, excludeContactIds);
  const stats = await batchStats(orgId, batchId);
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.weeklyBatch.updateMany({
      where: { id: batchId, organizationId: orgId, status: { in: ["REVIEW", "SOURCING"] } },
      data: { status: "APPROVED", approvedCount: stats.sendable, approvedAt: now },
    });
    if (r.count) await tx.contact.updateMany({ where: { organizationId: orgId, batchId, approvedAt: null, status: { not: "REJECTED" } }, data: approval(source, now) });
    return r;
  });
  if (!updated.count) return { ok: false, error: "This week was already approved, nothing more to do." };
  return { ok: true, approved: stats.sendable, excluded: stats.excluded };
}

export async function handoffToReview(orgId: string, batchId: string): Promise<void> {
  await prisma.weeklyBatch.updateMany({ where: { id: batchId, organizationId: orgId, status: "SOURCING" }, data: { status: "REVIEW" } });
  const settings = await getSettings(orgId);
  if (autoApproves(settings)) await approveBatch(orgId, batchId, [], "auto");
}

export function pendingReviewBatches(orgId: string) {
  return prisma.weeklyBatch.findMany({ where: { organizationId: orgId, status: "REVIEW" }, orderBy: { weekStart: "asc" } });
}

export async function activeSendBatch(orgId: string, dayKey: string): Promise<WeeklyBatch | null> {
  return prisma.weeklyBatch.findFirst({
    where: { organizationId: orgId, weekStart: dateOnly(mondayOf(dayKey)), status: { in: ["APPROVED", "SENDING"] } },
  });
}

export async function closePastBatches(orgId: string, dayKey: string): Promise<void> {
  const thisWeek = dateOnly(mondayOf(dayKey));
  await prisma.weeklyBatch.updateMany({ where: { organizationId: orgId, weekStart: { lt: thisWeek }, status: { in: ["APPROVED", "SENDING"] } }, data: { status: "DONE" } });
  await prisma.weeklyBatch.updateMany({ where: { organizationId: orgId, weekStart: { lt: thisWeek }, status: "SOURCING" }, data: { status: "REVIEW" } });
}

export async function resolveImportBatch(orgId: string): Promise<WeeklyBatch | null> {
  const s = await getSettings(orgId);
  if (!reviewsWeekly(s)) return null;
  const dayKey = dateKeyInTz(s.timezone);
  const weekly = Math.max(1, s.dailySourceTarget) * 5;
  const open = (b: WeeklyBatch | null) => (b && ["SOURCING", "REVIEW"].includes(b.status) ? b : null);
  if (dayOfWeekInTz(s.timezone) === 0) return open(await getOrCreateBatch(orgId, nextMondayOf(dayKey), weekly));
  const current = open(await getBatchByWeek(orgId, mondayOf(dayKey)));
  if (current) return current;
  return open(await getOrCreateBatch(orgId, nextMondayOf(dayKey), weekly));
}

export async function refreshSourcedCount(orgId: string, batchId: string): Promise<void> {
  const n = await prisma.contact.count({ where: { organizationId: orgId, batchId, status: { not: "REJECTED" } } });
  await prisma.weeklyBatch.update({ where: { id: batchId }, data: { sourcedClean: n } });
}

export function approveToken(batchId: string): string {
  return hmac(env.APPROVE_LINK_SECRET, `approve:${batchId}`);
}

export function verifyApproveToken(batchId: string, token: string): boolean {
  return !!batchId && !!token && safeEqual(approveToken(batchId), token);
}

export function weekLabel(batch: Pick<WeeklyBatch, "weekStart">): string {
  return new Date(`${dayKeyOf(batch.weekStart)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
