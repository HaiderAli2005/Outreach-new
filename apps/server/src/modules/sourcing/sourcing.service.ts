import { prisma } from "../../lib/prisma.js";
import { notConfigured, notFound, unprocessable } from "../../lib/errors.js";
import { assertFunded, canStartSequence } from "../../domain/entitlements.js";
import { insufficientCredits } from "../../lib/errors.js";
import { getSettings } from "../../domain/settings.js";
import { creditPacing } from "../../domain/usage.js";
import { searchPreview, sourceForCampaign } from "../../domain/sourcing.js";
import { resolveImportBatch } from "../../domain/batches.js";

export async function search(orgId: string, body: { campaignId?: string; filters?: Record<string, unknown>; page: number }) {
  let filters = body.filters ?? {};
  if (body.campaignId) {
    const c = await prisma.campaign.findFirst({ where: { id: body.campaignId, organizationId: orgId } });
    if (!c) throw notFound("Campaign");
    filters = (c.apolloFilters ?? {}) as Record<string, unknown>;
  }
  const r = await searchPreview(orgId, filters, body.page, 25);
  if (!r) throw notConfigured("Apollo");
  return {
    totalEntries: r.totalEntries,
    people: r.people.map((p) => ({
      id: p.id,
      name: p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" "),
      title: p.title,
      company: p.organization?.name ?? p.organization_name,
      location: [p.city, p.country].filter(Boolean).join(", "),
    })),
  };
}

export async function importNow(orgId: string, campaignId: string, maxEnrich: number) {
  await assertFunded(orgId);
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, organizationId: orgId } });
  if (!campaign) throw notFound("Campaign");
  if (campaign.status !== "ACTIVE") throw unprocessable("Resume the campaign before sourcing into it");
  const s = await getSettings(orgId);
  const pacing = await creditPacing(orgId, s);
  if (!(await canStartSequence(orgId))) throw insufficientCredits("Your balance can't pay for more emails. Add credits to find and write to more people.");
  const paced = pacing.unlimited ? maxEnrich : Math.min(maxEnrich, pacing.allowanceToday ?? 0);
  if (paced <= 0) throw unprocessable("Today's lead credit allowance is used up");
  const batch = await resolveImportBatch(orgId);
  return sourceForCampaign(orgId, campaign, { maxEnrich: paced, batchId: batch?.id ?? null });
}

export async function usage(orgId: string) {
  const s = await getSettings(orgId);
  const days = await prisma.usageCounter.findMany({ where: { organizationId: orgId }, orderBy: { day: "desc" }, take: 31 });
  return { pacing: await creditPacing(orgId, s), days };
}

/**
 * The audience list as a funnel, with one page of the people in it: everyone the free search saved, how many have
 * had their email looked up, how many of those have one that works (they are the Leads), and how many still wait.
 */
export async function audience(orgId: string, opts: { page: number; status?: "WAITING" | "PULLED"; q?: string }) {
  const pageSize = 50;
  const where = {
    organizationId: orgId,
    ...(opts.status ? { status: opts.status } : { status: { not: "SKIPPED" as const } }),
    ...(opts.q ? { OR: [{ fullName: { contains: opts.q, mode: "insensitive" as const } }, { company: { contains: opts.q, mode: "insensitive" as const } }, { title: { contains: opts.q, mode: "insensitive" as const } }] } : {}),
  };
  const [found, lookedUp, waiting, withEmail, total, rows, campaigns] = await Promise.all([
    prisma.prospect.count({ where: { organizationId: orgId, status: { not: "SKIPPED" } } }),
    prisma.prospect.count({ where: { organizationId: orgId, status: "PULLED" } }),
    prisma.prospect.count({ where: { organizationId: orgId, status: "WAITING" } }),
    prisma.contact.count({ where: { organizationId: orgId, source: { in: ["apollo", "maps"] }, status: { not: "REJECTED" } } }),
    prisma.prospect.count({ where }),
    prisma.prospect.findMany({
      where,
      orderBy: [{ status: "asc" }, { fitScore: "desc" }, { createdAt: "asc" }],
      skip: (opts.page - 1) * pageSize,
      take: pageSize,
      select: { id: true, fullName: true, title: true, company: true, companyDomain: true, country: true, employees: true, fitScore: true, status: true, audienceId: true, campaignId: true, source: true, city: true },
    }),
    prisma.campaign.findMany({ where: { organizationId: orgId }, select: { id: true, audiences: true } }),
  ]);
  const names = new Map<string, string>();
  for (const c of campaigns) for (const a of (Array.isArray(c.audiences) ? c.audiences : []) as { id?: string; name?: string }[]) if (a?.id && a.name) names.set(a.id, a.name);
  return {
    counts: { found, lookedUp, withEmail, noEmail: Math.max(0, lookedUp - withEmail), waiting },
    total,
    page: opts.page,
    pageSize,
    rows: rows.map((r) => ({ ...r, audience: r.audienceId ? (names.get(r.audienceId) ?? null) : null })),
  };
}
