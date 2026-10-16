import type { OrgSettings } from "@prisma/client";
import { prisma, type Db } from "../lib/prisma.js";

export async function getSettings(orgId: string, db: Db = prisma): Promise<OrgSettings> {
  const existing = await db.orgSettings.findUnique({ where: { organizationId: orgId } });
  if (existing) return existing;
  return db.orgSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId }, update: {} });
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
