import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { notFound } from "../../lib/errors.js";
import { getSettings } from "../../domain/settings.js";
import { addDays, dateKeyInTz, dayKeyOf, tzMidnightUtc } from "../../lib/time.js";
import { groupsOf } from "../onboarding/onboarding.service.js";
import { audiences } from "./performance.js";

/**
 * One campaign's workspace: who it targets and why (its brief), the leads it found, how far they have got, and a dated
 * story of what happened. A campaign is one audience; "own" is the people the customer uploaded themselves.
 * Every number and event is read from the people and the sends; nothing here is generated.
 */

const SENDABLE = ["ok", "catch_all"];
const BAD = ["invalid", "disposable"];
const SIZE_BANDS: [string, number, number][] = [
  ["1–10", 1, 10],
  ["11–50", 11, 50],
  ["51–200", 51, 200],
  ["201–1,000", 201, 1000],
  ["1,000+", 1001, Number.MAX_SAFE_INTEGER],
];
const OUTREACH = Prisma.sql`s.status IN ('SENT','DELIVERED','HARD_BOUNCE','SOFT_BOUNCE','COMPLAINT') AND s.step >= 1`;

export type CampaignEvent = { at: string; kind: "launch" | "found" | "approved" | "sent" | "reply"; text: string };

export async function campaignNav(orgId: string) {
  const [onboarding, own, campaign, s] = await Promise.all([
    prisma.onboarding.findUnique({ where: { organizationId: orgId }, select: { groups: true, launchedAt: true } }),
    prisma.contact.count({ where: { organizationId: orgId, audienceId: null } }),
    prisma.campaign.findFirst({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" }, select: { status: true } }),
    getSettings(orgId),
  ]);
  if (!onboarding?.launchedAt) return [];
  const paused = !s.autopilotEnabled || campaign?.status !== "ACTIVE";
  const list = groupsOf(onboarding).map((g) => ({ id: g.id, name: g.name, state: !g.on ? ("off" as const) : paused ? ("paused" as const) : ("on" as const) }));
  if (own) list.push({ id: "own", name: "Your own contacts", state: paused ? "paused" : "on" });
  return list;
}

export async function campaignWorkspace(orgId: string, id: string) {
  const [s, onboarding] = await Promise.all([getSettings(orgId), prisma.onboarding.findUnique({ where: { organizationId: orgId }, select: { groups: true, launchedAt: true } })]);
  const own = id === "own";
  const group = own ? null : (groupsOf(onboarding ?? { groups: [] }).find((g) => g.id === id) ?? null);
  if (!own && !group) throw notFound("Campaign");

  const tz = s.timezone;
  const dayKey = dateKeyInTz(tz);
  const to = tzMidnightUtc(addDays(dayKey, 1), tz);
  const from30 = tzMidnightUtc(addDays(dayKey, -29), tz);
  const where: Prisma.ContactWhereInput = { organizationId: orgId, audienceId: own ? null : id, status: { not: "REJECTED" } };
  const aud = own ? Prisma.sql`c."audienceId" IS NULL` : Prisma.sql`c."audienceId" = ${id}`;

  const [found, canEmail, noAddress, emailed, replied, hot, steps, byCountry, people, companies, rowState] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.count({ where: { ...where, OR: [{ verifyResult: { in: SENDABLE } }, { verifyResult: null, emailStatus: "verified" }] } }),
    prisma.contact.count({ where: { ...where, OR: [{ verifyResult: { in: BAD } }, { email: "" }] } }),
    prisma.contact.count({ where: { ...where, firstContactedAt: { not: null } } }),
    prisma.contact.count({ where: { ...where, repliedAt: { not: null } } }),
    prisma.contact.count({ where: { ...where, OR: [{ customerIntent: "INTERESTED" }, { customerIntent: null, intent: "INTERESTED" }, { temperature: "hot" }] } }),
    prisma.$queryRaw<{ step: number; n: bigint }[]>`
      SELECT s.step, COUNT(*) AS n FROM sends s JOIN "Contact" c ON c.id = s.prospect_id
      WHERE s.customer_id = ${orgId} AND ${aud} AND ${OUTREACH} GROUP BY 1 ORDER BY 1`,
    prisma.contact.groupBy({ by: ["country"], where, _count: { _all: true }, orderBy: { _count: { country: "desc" } }, take: 6 }),
    prisma.contact.findMany({
      where,
      orderBy: [{ repliedAt: { sort: "desc", nulls: "last" } }, { firstContactedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 60,
      select: { id: true, fullName: true, title: true, company: true, companyDomain: true, country: true, status: true, verifyResult: true, emailStatus: true, repliedAt: true, firstContactedAt: true },
    }),
    prisma.$queryRaw<{ domain: string; name: string | null; people: bigint; country: string | null; employees: number | null; description: string | null }[]>`
      SELECT c."companyDomain" AS domain, MAX(COALESCE(co.name, c.company)) AS name, COUNT(*) AS people,
             MAX(COALESCE(co.country, c.country)) AS country, MAX(co.employees) AS employees, MAX(co.description) AS description
      FROM "Contact" c LEFT JOIN "Company" co ON co."organizationId" = c."organizationId" AND co.domain = c."companyDomain"
      WHERE c."organizationId" = ${orgId} AND ${aud} AND c.status <> 'REJECTED' AND c."companyDomain" IS NOT NULL
      GROUP BY 1 ORDER BY people DESC, name ASC LIMIT 60`,
    audiences(orgId, from30, to, 30).then((rows) => rows.find((r) => (own ? r.id === "" : r.id === id)) ?? null),
  ]);

  // Company sizes from the companies we know, banded; people whose company size is unknown are counted as such.
  const sizeRows = await prisma.$queryRaw<{ employees: number | null; n: bigint }[]>`
    SELECT co.employees, COUNT(*) AS n FROM "Contact" c
    LEFT JOIN "Company" co ON co."organizationId" = c."organizationId" AND co.domain = c."companyDomain"
    WHERE c."organizationId" = ${orgId} AND ${aud} AND c.status <> 'REJECTED' GROUP BY 1`;
  const bySize = SIZE_BANDS.map(([label, lo, hi]) => [label, sizeRows.filter((r) => r.employees !== null && r.employees >= lo && r.employees <= hi).reduce((a, r) => a + Number(r.n), 0)] as [string, number]).filter(([, n]) => n > 0);
  const unknownSize = sizeRows.filter((r) => r.employees === null).reduce((a, r) => a + Number(r.n), 0);
  if (unknownSize) bySize.push(["Unknown", unknownSize]);

  return {
    id,
    name: own ? "Your own contacts" : group!.name,
    description: own ? "People you uploaded yourself." : group!.description,
    on: own ? true : group!.on,
    state: rowState?.state ?? (own || group!.on ? "finding" : "off"),
    launchedAt: onboarding?.launchedAt ?? null,
    brief: group
      ? {
          why: group.why,
          goals: group.goals,
          pains: group.pains,
          objections: group.objections,
          titles: group.titles,
          includeSimilarTitles: group.includeSimilarTitles,
          seniorities: group.seniorities,
          sizes: group.sizes,
          regions: group.regions,
          keywords: group.keywords,
          technologies: group.technologies,
          lookalikeDomains: group.lookalikeDomains,
          excludeDomains: group.excludeDomains,
        }
      : null,
    offer: { valueProp: s.valueProp, company: s.senderCompany, proof: ((s.proofPoints as { claim?: string; source?: string }[] | null) ?? []).filter((p) => p?.claim).map((p) => ({ claim: String(p.claim), source: p.source ? String(p.source) : null })) },
    progress: {
      found,
      canEmail,
      noAddress,
      checking: Math.max(0, found - canEmail - noAddress),
      emailed,
      replied,
      hot,
      steps: [1, 2, 3, 4].map((step) => ({ step, sent: Number(steps.find((r) => r.step === step)?.n ?? 0) })),
    },
    breakdown: {
      countries: byCountry.map((r) => [r.country ?? "Unknown", r._count._all] as [string, number]),
      sizes: bySize,
    },
    people: people.map((p) => ({
      ...p,
      email: SENDABLE.includes(p.verifyResult ?? "") || (!p.verifyResult && p.emailStatus === "verified") ? "ok" : BAD.includes(p.verifyResult ?? "") ? "bad" : "checking",
    })),
    companies: companies.map((c) => ({ domain: c.domain, name: c.name ?? c.domain, people: Number(c.people), country: c.country, employees: c.employees, description: c.description })),
    timeline: await timeline(orgId, tz, aud, from30, to, onboarding?.launchedAt ?? null),
  };
}

/** What happened, day by day over the last 30 days, newest first. Each line is a count or a name from the records. */
async function timeline(orgId: string, tz: string, aud: Prisma.Sql, from: Date, to: Date, launchedAt: Date | null): Promise<CampaignEvent[]> {
  const day = (col: Prisma.Sql) => Prisma.sql`(${col} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date`;
  const [found, approved, sent, replies] = await Promise.all([
    prisma.$queryRaw<{ d: Date; n: bigint }[]>`SELECT ${day(Prisma.sql`c."createdAt"`)} AS d, COUNT(*) AS n FROM "Contact" c WHERE c."organizationId" = ${orgId} AND ${aud} AND c."createdAt" >= ${from} AND c."createdAt" < ${to} GROUP BY 1`,
    prisma.$queryRaw<{ d: Date; n: bigint }[]>`SELECT ${day(Prisma.sql`c."approvedAt"`)} AS d, COUNT(*) AS n FROM "Contact" c WHERE c."organizationId" = ${orgId} AND ${aud} AND c."approvedAt" >= ${from} AND c."approvedAt" < ${to} GROUP BY 1`,
    prisma.$queryRaw<{ d: Date; first: bigint; follow: bigint }[]>`
      SELECT ${day(Prisma.sql`s.sent_at`)} AS d, COUNT(*) FILTER (WHERE s.step = 1) AS first, COUNT(*) FILTER (WHERE s.step >= 2) AS follow
      FROM sends s JOIN "Contact" c ON c.id = s.prospect_id
      WHERE s.customer_id = ${orgId} AND ${aud} AND ${OUTREACH} AND s.sent_at >= ${from} AND s.sent_at < ${to} GROUP BY 1`,
    prisma.$queryRaw<{ at: Date; name: string | null; company: string | null }[]>`
      SELECT c."repliedAt" AS at, c."fullName" AS name, c.company FROM "Contact" c
      WHERE c."organizationId" = ${orgId} AND ${aud} AND c."repliedAt" >= ${from} AND c."repliedAt" < ${to} ORDER BY c."repliedAt" DESC LIMIT 20`,
  ]);
  const noon = (d: Date) => `${dayKeyOf(new Date(d))}T12:00:00.000Z`;
  const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  const out: CampaignEvent[] = [];
  for (const r of found) out.push({ at: noon(r.d), kind: "found", text: `Found ${plural(Number(r.n), "new person", "new people")} who match` });
  for (const r of approved) out.push({ at: noon(r.d), kind: "approved", text: `${plural(Number(r.n), "person was", "people were")} approved to be emailed` });
  for (const r of sent) {
    const parts = [Number(r.first) ? plural(Number(r.first), "first email", "first emails") : "", Number(r.follow) ? plural(Number(r.follow), "follow-up", "follow-ups") : ""].filter(Boolean);
    if (parts.length) out.push({ at: noon(r.d), kind: "sent", text: `Sent ${parts.join(" and ")}` });
  }
  for (const r of replies) out.push({ at: new Date(r.at).toISOString(), kind: "reply", text: `${r.name ?? "Someone"}${r.company ? ` at ${r.company}` : ""} replied` });
  if (launchedAt && launchedAt >= from) out.push({ at: launchedAt.toISOString(), kind: "launch", text: "Campaign launched" });
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
}
