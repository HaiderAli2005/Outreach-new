import type { OrgSettings } from "@prisma/client";
import { prisma, type Db } from "../lib/prisma.js";

export async function getSettings(orgId: string, db: Db = prisma): Promise<OrgSettings> {
  const existing = await db.orgSettings.findUnique({ where: { organizationId: orgId } });
  if (existing) return existing;
  return db.orgSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId }, update: {} });
}

/**
 * Whether people Aperture finds may be approved without a person. Never before the first batch is approved in
 * "approve the first 20" mode: approving them early made the first batch empty, so it could never be approved, and
 * nothing ever sent.
 */
export function autoApproves(s: Pick<OrgSettings, "autoApproveBatches" | "launchMode" | "firstBatchApprovedAt">): boolean {
  return s.autoApproveBatches && !(s.launchMode === "APPROVE_FIRST_BATCH" && !s.firstBatchApprovedAt);
}

/** A weekly list can be approved only once the first batch is, in "approve the first 20" mode (same reason). */
export function weeksApprovable(s: Pick<OrgSettings, "launchMode" | "firstBatchApprovedAt">): boolean {
  return !(s.launchMode === "APPROVE_FIRST_BATCH" && !s.firstBatchApprovedAt);
}

export interface BrandProfile {
  company?: string;
  domain?: string;
  summary?: string;
  valueProp?: string;
  audience?: { industries?: string[]; titles?: string[]; sizes?: string[]; regions?: string[] };
}

export function brandProfileOf(settings: OrgSettings): BrandProfile {
  const raw = settings.brandProfile;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as BrandProfile) : {};
}
