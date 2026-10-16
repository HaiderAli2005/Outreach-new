import { prisma } from "../lib/prisma.js";
import { runReplyIntelligence } from "../domain/replyIntelligence.js";
import { returnNudge } from "../domain/sequence.js";
import { getSettings } from "../domain/settings.js";
import { forEachOrg, payingOrgs } from "./runner.js";

export async function classifySweep(orgId: string, limit = 10): Promise<number> {
  const pending = await prisma.message.findMany({
    where: {
      organizationId: orgId,
      direction: "INBOUND",
      intent: null,
      classifyAttempts: { lt: 3 },
      createdAt: { gte: new Date(Date.now() - 14 * 86_400_000) },
      OR: [{ classifyStartedAt: null }, { classifyStartedAt: { lt: new Date(Date.now() - 3 * 60_000) } }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, contactId: true, createdAt: true },
    take: 200,
  });
  const newestPerContact = new Map<string, string>();
  const superseded: string[] = [];
  for (const m of pending) {
    if (newestPerContact.has(m.contactId)) superseded.push(m.id);
    else newestPerContact.set(m.contactId, m.id);
  }
  if (superseded.length) await prisma.message.updateMany({ where: { id: { in: superseded } }, data: { intent: "superseded" } });
  let n = 0;
  for (const id of [...newestPerContact.values()].slice(0, limit)) {
    if (await runReplyIntelligence(orgId, id)) n++;
  }
  return n;
}

/**
 * People who said "not now" or were away, whose date has come: a short check-in is DRAFTED and flagged for the
 * customer. It is never sent on its own.
 */
export async function followUpSweep(orgId: string): Promise<{ due: number; drafted: number }> {
  const due = await prisma.contact.findMany({
    where: { organizationId: orgId, replyClass: { in: ["away", "not_now"] }, replyUrgent: false, followUpAt: { lte: new Date() }, status: "REPLIED" },
    select: { id: true, campaignId: true },
  });
  if (!due.length) return { due: 0, drafted: 0 };
  const settings = await getSettings(orgId);
  let drafted = 0;
  for (const c of due) {
    const campaign = c.campaignId ? await prisma.campaign.findUnique({ where: { id: c.campaignId }, select: { language: true } }) : null;
    const draft = settings.draftReplies ? returnNudge(campaign?.language ?? settings.language) : null;
    await prisma.contact.update({ where: { id: c.id }, data: { replyUrgent: true, followUpAt: null, ...(draft ? { aiDraft: draft, aiDraftAt: new Date() } : {}) } });
    if (draft) drafted++;
  }
  return { due: due.length, drafted };
}

export function runReplySyncJob() {
  return forEachOrg("reply-sync", payingOrgs, async (orgId) => ({ classified: await classifySweep(orgId), followUps: await followUpSweep(orgId) }));
}
