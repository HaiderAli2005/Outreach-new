import type { Campaign, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { getSettings } from "../../domain/settings.js";
import { assertFunded } from "../../domain/entitlements.js";

const ACTIVE_PIPELINE = ["BLOCKLISTED", "BOUNCED", "UNSUBSCRIBED", "NO_RESPONSE"];

interface CampaignCounts {
  leadCount: number;
  verifiedCount: number;
  tierACount: number;
  contactedCount: number;
  replyCount: number;
}

async function countsFor(orgId: string, ids: string[]): Promise<Map<string, CampaignCounts>> {
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRaw<{ id: string; lead: bigint; verified: bigint; tier_a: bigint; contacted: bigint; replied: bigint }[]>`
    SELECT c."campaignId" AS id,
           COUNT(*) AS lead,
           COUNT(*) FILTER (WHERE c."emailStatus" = 'verified' OR c."verifyResult" IN ('ok','catch_all')) AS verified,
           COUNT(*) FILTER (WHERE c.tier = 'A') AS tier_a,
           COUNT(*) FILTER (WHERE c."firstContactedAt" IS NOT NULL) AS contacted,
           COUNT(*) FILTER (WHERE c."repliedAt" IS NOT NULL) AS replied
    FROM "Contact" c
    WHERE c."organizationId" = ${orgId} AND c."campaignId" = ANY(${ids}) AND c.status::text <> ALL(${ACTIVE_PIPELINE})
    GROUP BY c."campaignId"`;
  return new Map(
    rows.map((r) => [
      r.id,
      { leadCount: Number(r.lead), verifiedCount: Number(r.verified), tierACount: Number(r.tier_a), contactedCount: Number(r.contacted), replyCount: Number(r.replied) },
    ]),
  );
}

const empty: CampaignCounts = { leadCount: 0, verifiedCount: 0, tierACount: 0, contactedCount: 0, replyCount: 0 };

function withRates(c: Campaign, counts: CampaignCounts, weightSum: number) {
  const running = c.status === "ACTIVE" && !c.saturatedAt;
  const weight = (counts.replyCount + 1) / (counts.contactedCount + 50);
  return {
    ...c,
    ...counts,
    replyRate: counts.contactedCount ? Math.round((1000 * counts.replyCount) / counts.contactedCount) / 10 : null,
    dailyShare: running && weightSum ? Math.round((100 * weight) / weightSum) : 0,
  };
}

export async function list(orgId: string) {
  const campaigns = await prisma.campaign.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" } });
  const counts = await countsFor(orgId, campaigns.map((c) => c.id));
  const weightSum = campaigns
    .filter((c) => c.status === "ACTIVE" && !c.saturatedAt)
    .reduce((s, c) => {
      const k = counts.get(c.id) ?? empty;
      return s + (k.replyCount + 1) / (k.contactedCount + 50);
    }, 0);
  return campaigns.map((c) => withRates(c, counts.get(c.id) ?? empty, weightSum));
}

async function load(orgId: string, id: string) {
  const c = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
  if (!c) throw notFound("Campaign");
  return c;
}

export async function get(orgId: string, id: string) {
  const c = await load(orgId, id);
  const counts = (await countsFor(orgId, [id])).get(id) ?? empty;
  const tierB = await prisma.contact.count({ where: { organizationId: orgId, campaignId: id, tier: "B" } });
  return { ...withRates(c, counts, 0), tierBCount: tierB };
}

export interface CampaignInput {
  name: string;
  niche?: string | null;
  marketBrief?: string | null;
  language?: string;
  apolloFilters?: Record<string, unknown>;
}

export async function create(orgId: string, input: CampaignInput) {
  const settings = await getSettings(orgId);
  return prisma.campaign.create({
    data: {
      organizationId: orgId,
      name: input.name,
      niche: input.niche ?? null,
      marketBrief: input.marketBrief ?? null,
      language: input.language ?? settings.language,
      apolloFilters: (input.apolloFilters ?? {}) as Prisma.InputJsonValue,
      status: "DRAFT",
    },
  });
}

export async function update(orgId: string, id: string, input: Partial<CampaignInput>) {
  const c = await load(orgId, id);
  if (c.status === "ACTIVE") throw unprocessable("Pause the campaign before changing its targeting");
  if (c.status === "ARCHIVED") throw unprocessable("Archived campaigns can't be edited");
  return prisma.campaign.update({
    where: { id: c.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.niche !== undefined ? { niche: input.niche } : {}),
      ...(input.marketBrief !== undefined ? { marketBrief: input.marketBrief } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      // Hand-edited targeting replaces the per-audience searches from setup.
      ...(input.apolloFilters !== undefined ? { apolloFilters: input.apolloFilters as Prisma.InputJsonValue, sourcePage: 1, saturatedAt: null, audiences: [], audienceCursor: 0 } : {}),
    },
  });
}

export async function setStatus(orgId: string, id: string, want: "ACTIVE" | "PAUSED" | "ARCHIVED") {
  const c = await load(orgId, id);
  if (c.status === want) return c;
  if (c.status === "ARCHIVED") throw unprocessable("Archived campaigns can't be restarted");
  if (want === "ACTIVE") await assertFunded(orgId);
  return prisma.campaign.update({ where: { id: c.id }, data: { status: want } });
}

export async function dossier(orgId: string, id: string) {
  return load(orgId, id);
}
