import type { BlockReason, ContactStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { extractDomain, isFreeMailDomain, normalizeEmail } from "../lib/normalize.js";
import { releaseForContact } from "./credits/index.js";

interface InFlight {
  id: string;
}

const inFlightSelect = { id: true } as const;

/**
 * Stops sequences already under way. Follow-ups only go to people still CONTACTED, so the status change made by the
 * caller is what stops them; this gives back whatever was held for the emails that will now never go out.
 */
export async function pauseInFlight(_orgId: string, rows: InFlight[]): Promise<void> {
  for (const r of rows) await releaseForContact(r.id, "Sequence stopped");
}

const HARD_STATUSES: ContactStatus[] = ["BLOCKLISTED", "UNSUBSCRIBED", "BOUNCED"];

async function suppressTarget(orgId: string, normalized: string, contactId: string | null): Promise<number> {
  const where = {
    organizationId: orgId,
    status: { notIn: HARD_STATUSES },
    OR: [{ emailNormalized: normalized }, ...(contactId ? [{ id: contactId }] : [])],
  };
  const targets = await prisma.contact.findMany({ where, select: inFlightSelect });
  if (!targets.length) return 0;
  await prisma.contact.updateMany({ where: { id: { in: targets.map((t) => t.id) } }, data: { status: "BLOCKLISTED" } });
  await pauseInFlight(orgId, targets);
  return targets.length;
}

export interface BlockResult {
  type: "EMAIL" | "DOMAIN" | null;
  value: string | null;
}

export async function blockEmail(
  orgId: string,
  email: string,
  reason: BlockReason,
  contactId: string | null = null,
  opts: { emailOnly?: boolean } = {},
): Promise<BlockResult> {
  const { normalized, domain } = normalizeEmail(email);
  if (!normalized.includes("@")) return { type: null, value: null };
  const dom = (domain ?? extractDomain(email) ?? "").toLowerCase();

  if (dom && !isFreeMailDomain(dom) && !opts.emailOnly) {
    await prisma.blocklistEntry.upsert({
      where: { organizationId_entryType_value: { organizationId: orgId, entryType: "DOMAIN", value: dom } },
      create: { organizationId: orgId, entryType: "DOMAIN", value: dom, reason, contactId },
      update: { reason },
    });
    const siblings = await prisma.contact.findMany({
      where: { organizationId: orgId, OR: [{ companyDomain: dom }, { domain: dom }], status: "CONTACTED" },
      select: inFlightSelect,
    });
    await prisma.contact.updateMany({
      where: { organizationId: orgId, OR: [{ companyDomain: dom }, { domain: dom }], status: { notIn: ["REPLIED", "UNSUBSCRIBED", "BOUNCED"] } },
      data: { status: "BLOCKLISTED" },
    });
    await pauseInFlight(orgId, siblings);
    await suppressTarget(orgId, normalized, contactId);
    return { type: "DOMAIN", value: dom };
  }

  await prisma.blocklistEntry.upsert({
    where: { organizationId_entryType_value: { organizationId: orgId, entryType: "EMAIL", value: normalized } },
    create: { organizationId: orgId, entryType: "EMAIL", value: normalized, reason, contactId },
    update: { reason },
  });
  const mid = await prisma.contact.findMany({
    where: { organizationId: orgId, emailNormalized: normalized, status: "CONTACTED" },
    select: inFlightSelect,
  });
  await prisma.contact.updateMany({
    where: { organizationId: orgId, emailNormalized: normalized, status: { notIn: ["REPLIED", "UNSUBSCRIBED", "BOUNCED"] } },
    data: { status: "BLOCKLISTED" },
  });
  await pauseInFlight(orgId, mid);
  await suppressTarget(orgId, normalized, contactId);
  return { type: "EMAIL", value: normalized };
}

export async function isOptedOut(orgId: string, emailNormalized: string, domain: string | null): Promise<boolean> {
  const n = await prisma.blocklistEntry.count({
    where: {
      organizationId: orgId,
      reason: { in: ["UNSUBSCRIBED", "COMPLAINED"] },
      OR: [{ entryType: "EMAIL", value: emailNormalized }, ...(domain ? [{ entryType: "DOMAIN" as const, value: domain }] : [])],
    },
  });
  return n > 0;
}
