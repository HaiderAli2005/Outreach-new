import { prisma } from "../lib/prisma.js";
import { dateKeyInTz, dayOfWeekInTz, nextMondayOf, dayKeyOf } from "../lib/time.js";
import { apolloFor } from "../integrations/apollo.js";
import { getSettings } from "../domain/settings.js";
import { creditPacing } from "../domain/usage.js";
import { sourceForCampaign } from "../domain/sourcing.js";
import { closePastBatches, getOrCreateBatch, handoffToReview, weekLabel } from "../domain/batches.js";
import { postToSlack } from "../integrations/slack.js";
import { forEachOrg, autopilotOrgs } from "./runner.js";
import { logSystem } from "../domain/systemLog.js";
import { canStartSequence } from "../domain/entitlements.js";

const MAX_ROUNDS = 8;

export async function sourceForOrg(orgId: string, opts: { force?: boolean } = {}) {
  const s = await getSettings(orgId);
  if (s.leadSourcing === "OFF") return { skipped: "sourcing-off" };
  if (!(await apolloFor(orgId))) return { skipped: "apollo-not-configured" };
  const dayKey = dateKeyInTz(s.timezone);
  await closePastBatches(orgId, dayKey);
  let batchId: string | null = null;
  let target = s.dailySourceTarget;
  if (s.weeklyBatchMode) {
    if (!opts.force && dayOfWeekInTz(s.timezone) !== 0) return { skipped: "not-sourcing-day" };
    const batch = await getOrCreateBatch(orgId, nextMondayOf(dayKey), s.dailySourceTarget * 5);
    if (!["SOURCING", "REVIEW"].includes(batch.status)) return { skipped: "batch-locked" };
    batchId = batch.id;
    const sourced = await prisma.contact.count({ where: { organizationId: orgId, batchId: batch.id, status: { not: "REJECTED" } } });
    target = Math.max(0, batch.targetClean - sourced);
  } else {
    const since = new Date(Date.now() - 86_400_000);
    target = Math.max(0, s.dailySourceTarget - (await prisma.contact.count({ where: { organizationId: orgId, source: "apollo", createdAt: { gte: since } } })));
  }
  const campaigns = await prisma.campaign.findMany({ where: { organizationId: orgId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  if (!campaigns.length) return { skipped: "no-active-campaign" };
  const totals = { inserted: 0, enriched: 0, rounds: 0, outOfCredits: false };
  // Finding is free, but there's no point finding people the balance can't email.
  if (!(await canStartSequence(orgId))) {
    totals.outOfCredits = true;
    await noteOutOfCredits(orgId, dayKey);
  }
  for (let round = 0; round < MAX_ROUNDS && totals.inserted < target && !totals.outOfCredits; round++) {
    const pacing = await creditPacing(orgId, s);
    const allowance = pacing.unlimited ? 50 : Math.min(50, pacing.allowanceToday ?? 0);
    if (allowance <= 0) break;
    const live = campaigns.filter((c) => !c.saturatedAt || c.saturatedAt < new Date(Date.now() - 30 * 86_400_000));
    if (!live.length) break;
    const campaign = live[round % live.length];
    const fresh = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    const r = await sourceForCampaign(orgId, fresh, { maxEnrich: Math.min(allowance, Math.max(10, target - totals.inserted)), batchId });
    totals.inserted += r.inserted;
    totals.enriched += r.enriched;
    totals.rounds++;
    // With per-audience targeting one audience can run dry while others still have people, so read it back.
    if (r.saturated) campaign.saturatedAt = (await prisma.campaign.findUnique({ where: { id: campaign.id }, select: { saturatedAt: true } }))?.saturatedAt ?? null;
    if (r.outOfCredits) {
      totals.outOfCredits = true;
      await noteOutOfCredits(orgId, dayKey);
      break;
    }
  }
  if (batchId && (totals.inserted >= target || opts.force || totals.rounds > 0)) {
    const batch = await prisma.weeklyBatch.findUniqueOrThrow({ where: { id: batchId } });
    if (batch.status === "SOURCING") {
      await handoffToReview(orgId, batchId);
      void postToSlack(orgId, `:clipboard: Next week's leads (week of ${weekLabel(batch)}) are ready for review in Aperture.`);
    }
  }
  return { ...totals, target, batchWeek: batchId ? dayKeyOf((await prisma.weeklyBatch.findUniqueOrThrow({ where: { id: batchId } })).weekStart) : null };
}

/** Tells the customer once a day that finding has paused. Sending to people already found carries on. */
async function noteOutOfCredits(orgId: string, dayKey: string): Promise<void> {
  const since = new Date(`${dayKey}T00:00:00Z`);
  const already = await prisma.systemLog.count({ where: { organizationId: orgId, source: "credits", createdAt: { gte: since }, message: { startsWith: "Out of credits" } } });
  if (already) return;
  await logSystem(orgId, "WARN", "credits", "Finding new people is paused until you add credits.");
  void postToSlack(orgId, ":warning: Aperture is out of credits. New emails and finding new people are paused until you add credits.");
}

export function runSourcingJob() {
  return forEachOrg("sourcing", autopilotOrgs, (orgId) => sourceForOrg(orgId));
}
