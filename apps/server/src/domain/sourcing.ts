import { approval } from "./approval.js";
import { randomUUID } from "node:crypto";
import type { Campaign, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { extractDomain, isFreeMailDomain } from "../lib/normalize.js";
import { apolloFor, type ApolloPerson } from "../integrations/apollo.js";
import { findEmail } from "../integrations/finders.js";
import { tzFromLocation } from "./sending/schedule.js";
import { partitionCandidates } from "./dedup.js";
import { scoreContact, SEND_FLOOR } from "./scoring.js";
import { addUsage } from "./usage.js";
import { brandProfileOf, getSettings } from "./settings.js";
import { refreshSourcedCount } from "./batches.js";
import { availableOf, customerOf, SEQUENCE_HOLD } from "./credits/index.js";
import { logSystem } from "./systemLog.js";

export interface SourcingResult {
  searched: number;
  enriched: number;
  inserted: number;
  duplicates: number;
  blocked: number;
  capped: number;
  noEmail: number;
  /** Skipped before paying for an email: junior titles and other people below the send floor. */
  lowFit: number;
  saturated: boolean;
  /** The balance can't pay for more people than are already waiting: finding pauses, sending carries on. */
  outOfCredits: boolean;
  /** The audience searched this round, when the campaign has per-audience targeting. */
  audience: string | null;
}

/** One audience from setup, searched on its own with its own page cursor. */
export interface AudienceTarget {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  page: number;
  saturatedAt: string | null;
}

/** An audience that ran out of new people rests this long before it is searched again from page 1. */
const AUDIENCE_REST_MS = 30 * 86_400_000;
const ENRICH_CHUNK = 10;

function orgDomain(p: ApolloPerson): string | null {
  return extractDomain(p.organization?.primary_domain ?? p.organization?.website_url ?? null);
}

export async function searchPreview(orgId: string, filters: Record<string, unknown>, page = 1, perPage = 25) {
  const apollo = await apolloFor(orgId);
  if (!apollo) return null;
  const r = await apollo.searchPeople(filters, page, perPage);
  await addUsage(orgId, "searches");
  return r;
}

export function audiencesOf(campaign: Pick<Campaign, "audiences">): AudienceTarget[] {
  return Array.isArray(campaign.audiences) ? (campaign.audiences as unknown as AudienceTarget[]).filter((a) => a && typeof a === "object" && a.filters) : [];
}

const resting = (a: AudienceTarget, now = Date.now()) => !!a.saturatedAt && now - Date.parse(a.saturatedAt) < AUDIENCE_REST_MS;

/** Which filters and page to search this round: the next audience in turn, or the campaign's own filters. */
function pickTarget(campaign: Campaign): { filters: Record<string, unknown>; page: number; index: number; list: AudienceTarget[] } | null {
  const list = audiencesOf(campaign);
  if (!list.length) return { filters: (campaign.apolloFilters ?? {}) as Record<string, unknown>, page: campaign.sourcePage, index: -1, list };
  const open = list.map((a, i) => ({ a, i })).filter(({ a }) => !resting(a));
  if (!open.length) return null;
  const from = campaign.audienceCursor % list.length;
  const pick = open.find(({ i }) => i >= from) ?? open[0];
  return { filters: pick.a.filters, page: Math.max(1, pick.a.page || 1), index: pick.i, list };
}

const empty = (): SourcingResult => ({
  searched: 0, enriched: 0, inserted: 0, duplicates: 0, blocked: 0, capped: 0, noEmail: 0, lowFit: 0,
  saturated: false, outOfCredits: false, audience: null,
});

/**
 * One round of lead finding for a campaign: search one page, skip people we can't or shouldn't email, then reveal
 * emails in small chunks. Finding people is free for the customer; it never runs ahead of what their balance can
 * send, so nobody is found who couldn't be emailed.
 */
export async function sourceForCampaign(orgId: string, campaign: Campaign, opts: { maxEnrich: number; batchId: string | null }): Promise<SourcingResult> {
  const result = empty();
  const apollo = await apolloFor(orgId);
  if (!apollo || opts.maxEnrich <= 0) return result;
  const target = pickTarget(campaign);
  if (!target) {
    // Every audience is resting: the campaign as a whole has run out of new people for now.
    await prisma.campaign.update({ where: { id: campaign.id }, data: { saturatedAt: new Date() } });
    return { ...result, saturated: true };
  }
  if (target.index >= 0) result.audience = target.list[target.index].name;
  const settings = await getSettings(orgId);
  const audience = brandProfileOf(settings).audience;
  const perPage = 25;
  const { people } = await apollo.searchPeople(target.filters, target.page, perPage);
  await addUsage(orgId, "searches");
  result.searched = people.length;
  if (people.length < perPage) result.saturated = true;

  const apolloIds = people.map((p) => p.id).filter((x): x is string => !!x);
  const known = new Set(
    (await prisma.contact.findMany({ where: { organizationId: orgId, apolloId: { in: apolloIds } }, select: { apolloId: true } })).map((c) => c.apolloId),
  );
  const domains = [...new Set(people.map(orgDomain).filter((d): d is string => !!d && !isFreeMailDomain(d)))];
  const blockedDomains = new Set(
    (await prisma.blocklistEntry.findMany({ where: { organizationId: orgId, entryType: "DOMAIN", value: { in: domains } }, select: { value: true } })).map((b) => b.value),
  );
  const candidates = people.filter((p) => p.id && !known.has(p.id));
  result.duplicates += people.length - candidates.length;
  const unblocked = candidates.filter((p) => !blockedDomains.has(orgDomain(p) ?? ""));
  result.blocked += candidates.length - unblocked.length;
  // Score from what the search already shows, so nobody we would never email costs an Apollo credit.
  const fit = (p: ApolloPerson) =>
    scoreContact(
      { title: p.title, seniority: p.seniority, emailStatus: p.email_status, employees: p.organization?.estimated_num_employees, industry: p.organization?.industry, website: p.organization?.website_url, linkedinUrl: p.linkedin_url },
      audience,
    );
  const worth = unblocked.filter((p) => fit(p).fitScore >= SEND_FLOOR);
  result.lowFit = unblocked.length - worth.length;

  // Never find more people than the balance can start sequences for, counting those already waiting.
  const affordable = Number((await availableOf(await customerOf(orgId))) / SEQUENCE_HOLD);
  const waiting = await prisma.contact.count({ where: { organizationId: orgId, status: { in: ["NEW", "PERSONALIZED", "QUEUED"] }, fitScore: { gte: SEND_FLOOR } } });
  const room = Math.max(0, affordable - waiting);
  if (room <= 0) result.outOfCredits = true;
  const toEnrich = worth.slice(0, Math.min(opts.maxEnrich, room));

  for (let i = 0; i < toEnrich.length; i += ENRICH_CHUNK) {
    await enrichAndStore(orgId, campaign, toEnrich.slice(i, i + ENRICH_CHUNK), opts.batchId, settings.perCompanyContactCap, audience, result, target.index >= 0 ? (target.list[target.index].id ?? null) : null, settings.autoApproveBatches);
  }

  if (target.index >= 0) {
    const list = target.list.map((a, i) =>
      i === target.index ? { ...a, page: result.saturated ? 1 : target.page + 1, saturatedAt: result.saturated ? new Date().toISOString() : null } : a,
    );
    const allResting = list.every((a) => resting(a));
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { audiences: list as unknown as Prisma.InputJsonValue, audienceCursor: target.index + 1, saturatedAt: allResting ? new Date() : null },
    });
  } else {
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: result.saturated ? { sourcePage: 1, saturatedAt: new Date() } : { sourcePage: { increment: 1 } },
    });
  }
  if (opts.batchId && result.inserted) await refreshSourcedCount(orgId, opts.batchId);
  return result;
}

/** Reveal emails for one chunk and store the people worth keeping. Returns how many sendable people were kept. */
async function enrichAndStore(
  orgId: string,
  campaign: Campaign,
  chunk: ApolloPerson[],
  batchId: string | null,
  perCompanyCap: number,
  audience: ReturnType<typeof brandProfileOf>["audience"],
  result: SourcingResult,
  audienceId: string | null = null,
  autoApprove = false,
): Promise<number> {
  const apollo = await apolloFor(orgId);
  if (!apollo) return 0;
  const enriched = await apollo.bulkEnrich(chunk.map((p) => ({ id: p.id })));
  result.enriched += enriched.length;
  await addUsage(orgId, "peopleEnriched", enriched.length);

  const withEmail = enriched.filter((p) => p.email && p.email_status !== "unavailable");
  const source = new Map<ApolloPerson, string>(withEmail.map((p) => [p, "apollo"]));
  // The waterfall: whoever Apollo had no address for goes to the next finder, stopping at the first verified hit.
  // Nobody is charged for a search; a person we don't find costs nothing.
  for (const p of enriched.filter((x) => !withEmail.includes(x))) {
    const domain = orgDomain(p);
    const fullName = p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ");
    if (!domain || !fullName) continue;
    const hit = await findEmail({ fullName, firstName: p.first_name, lastName: p.last_name, domain });
    if (hit) {
      const found = { ...p, email: hit.email, email_status: hit.status ?? "verified" };
      withEmail.push(found);
      source.set(found, hit.source);
    }
  }
  result.noEmail += enriched.length - withEmail.length + Math.max(0, chunk.length - enriched.length);
  const { fresh, duplicates, blocked, capped } = await partitionCandidates(
    orgId,
    withEmail.map((p) => ({ email: p.email!, companyDomain: orgDomain(p), person: p })),
    { perCompanyCap },
  );
  result.duplicates += duplicates.length;
  result.blocked += blocked.length;
  result.capped += capped.length;

  let kept = 0;
  for (const c of fresh) {
    const p = c.person;
    const org = p.organization;
    const domain = orgDomain(p);
    if (domain) {
      await prisma.company.upsert({
        where: { organizationId_domain: { organizationId: orgId, domain } },
        create: {
          organizationId: orgId,
          domain,
          name: org?.name ?? null,
          website: org?.website_url ?? null,
          industry: org?.industry ?? null,
          employees: org?.estimated_num_employees ?? null,
          description: org?.short_description ?? null,
          linkedinUrl: org?.linkedin_url ?? null,
          city: org?.city ?? null,
          country: org?.country ?? null,
        },
        update: {},
      });
    }
    const { fitScore, tier } = scoreContact(
      { title: p.title, seniority: p.seniority, emailStatus: p.email_status, employees: org?.estimated_num_employees, industry: org?.industry, website: org?.website_url, linkedinUrl: p.linkedin_url },
      audience,
    );
    const sendable = fitScore >= SEND_FLOOR;
    try {
      await prisma.contact.create({
        data: {
          organizationId: orgId,
          email: c._email,
          emailNormalized: c._normalized,
          domain: c._normalized.split("@")[1] ?? null,
          companyDomain: domain,
          firstName: p.first_name ?? null,
          lastName: p.last_name ?? null,
          fullName: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || null),
          title: p.title ?? null,
          headline: p.headline ?? null,
          seniority: p.seniority ?? null,
          company: org?.name ?? p.organization_name ?? null,
          website: org?.website_url ?? null,
          linkedinUrl: p.linkedin_url ?? null,
          photoUrl: p.photo_url ?? null,
          city: p.city ?? null,
          country: p.country ?? null,
          location: [p.city, p.country].filter(Boolean).join(", ") || null,
          industry: org?.industry ?? null,
          apolloId: p.id ?? null,
          emailStatus: p.email_status ?? null,
          campaignId: campaign.id,
          audienceId,
          batchId,
          ...(autoApprove ? approval("auto") : {}),
          source: "apollo",
          emailSource: source.get(p) ?? "apollo",
          timezone: tzFromLocation(p.country, p.state, p.city),
          fitScore,
          tier,
          raw: { apollo: { id: p.id, org: org?.id ?? null } } as Prisma.InputJsonValue,
        },
      });
      result.inserted++;
      if (sendable) kept++;
    } catch {
      result.duplicates++;
    }
  }
  return kept;
}
