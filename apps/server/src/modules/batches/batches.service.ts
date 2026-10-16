import { prisma } from "../../lib/prisma.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { dayKeyOf } from "../../lib/time.js";
import { approveBatch, batchStats, excludeLeads, pendingReviewBatches, verifyApproveToken, weekLabel } from "../../domain/batches.js";
import type { WeeklyBatch } from "@prisma/client";

async function withStats(orgId: string, b: WeeklyBatch) {
  return { ...b, weekStart: dayKeyOf(b.weekStart), label: weekLabel(b), stats: await batchStats(orgId, b.id) };
}

export async function list(orgId: string) {
  const rows = await prisma.weeklyBatch.findMany({ where: { organizationId: orgId }, orderBy: { weekStart: "desc" }, take: 26 });
  return Promise.all(rows.map((b) => withStats(orgId, b)));
}

export async function pending(orgId: string) {
  const rows = await pendingReviewBatches(orgId);
  return Promise.all(rows.map((b) => withStats(orgId, b)));
}

export async function get(orgId: string, id: string) {
  const b = await prisma.weeklyBatch.findFirst({ where: { id, organizationId: orgId } });
  if (!b) throw notFound("Week");
  return withStats(orgId, b);
}

export async function approve(orgId: string, id: string, excludeContactIds: string[]) {
  await get(orgId, id);
  const r = await approveBatch(orgId, id, excludeContactIds);
  if (!r.ok) throw unprocessable(r.error);
  return { ...r, perDay: Math.max(1, Math.ceil(r.approved / 5)) };
}

export async function exclude(orgId: string, id: string, contactIds: string[]) {
  await get(orgId, id);
  return { excluded: await excludeLeads(orgId, id, contactIds) };
}

export async function approveViaLink(batchId: string, token: string) {
  if (!verifyApproveToken(batchId, token)) return { tone: "bad" as const, title: "Invalid link", message: "This approval link is invalid or was changed." };
  const batch = await prisma.weeklyBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { tone: "bad" as const, title: "Not found", message: "That week's list can't be found anymore." };
  const r = await approveBatch(batch.organizationId, batchId);
  if (!r.ok) return { tone: "warn" as const, title: "Already handled", message: r.error };
  return {
    tone: "good" as const,
    title: "Week approved",
    message: `Week of ${weekLabel(batch)} approved: ${r.approved} leads locked in${r.excluded ? ` (${r.excluded} excluded)` : ""}. Sending starts at about ${Math.max(1, Math.ceil(r.approved / 5))} a day.`,
  };
}
