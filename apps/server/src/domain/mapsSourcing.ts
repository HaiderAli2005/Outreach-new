import type { Campaign, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { extractDomain, isFreeMailDomain } from "../lib/normalize.js";
import { apolloFor, type ApolloPerson } from "../integrations/apollo.js";
import { placesFor, type Place } from "../integrations/places.js";
import { readSiteEmails } from "../integrations/site.js";
import { scoreContact, SEND_FLOOR } from "./scoring.js";
import { addUsage } from "./usage.js";
import { brandProfileOf, getSettings } from "./settings.js";
import { logSystem } from "./systemLog.js";

/**
 * Google Maps as a lead source. Maps finds businesses (a clinic, a law firm); the people come after:
 *   1. Text Search "<keyword> in <city>" for each keyword and city of the campaign, a few searches a round.
 *   2. Each business with a website on its own domain is looked at once (MapsPlace).
 *   3. Apollo's free people search at that domain, with the campaign's titles or seniorities: named people join the
 *      audience list like anyone else, and their email is looked up when their turn comes.
 *   4. With nobody named, the address the business publishes on its own site joins instead, unless the campaign
 *      is "named people only".
 * Every address is verified before it is emailed, like every other.
 */

export type LeadSource = "apollo" | "maps" | "both";

export interface MapsPlan {
  queries: string[];
  regionCode: string | null;
}

/** The cursor through a campaign's Maps searches, kept on the campaign's audience entry. */
export interface MapsCursor extends MapsPlan {
  at: number;
  token: string | null;
  doneAt: string | null;
}

/** Big cities searched when a campaign names a whole country: Maps returns at most 60 places a search. */
const COUNTRY_CITIES: Record<string, { code: string; cities: string[] }> = {
  "saudi arabia": {
    code: "SA",
    cities: ["Riyadh", "Jeddah", "Makkah", "Madinah", "Dammam", "Khobar", "Dhahran", "Al Ahsa", "Jubail", "Taif", "Tabuk", "Buraidah", "Unaizah", "Hail", "Abha", "Khamis Mushait", "Najran", "Jazan", "Yanbu", "Al Kharj"],
  },
  ksa: { code: "SA", cities: [] },
  "united arab emirates": { code: "AE", cities: ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Al Ain", "Ras Al Khaimah"] },
  uae: { code: "AE", cities: [] },
  qatar: { code: "QA", cities: ["Doha", "Al Rayyan", "Al Wakrah"] },
  kuwait: { code: "KW", cities: ["Kuwait City", "Hawalli", "Salmiya", "Farwaniya"] },
  bahrain: { code: "BH", cities: ["Manama", "Muharraq", "Riffa"] },
  oman: { code: "OM", cities: ["Muscat", "Salalah", "Sohar", "Nizwa"] },
  pakistan: { code: "PK", cities: ["Karachi", "Lahore", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar"] },
};
COUNTRY_CITIES.ksa.cities = COUNTRY_CITIES["saudi arabia"].cities;
COUNTRY_CITIES.uae.cities = COUNTRY_CITIES["united arab emirates"].cities;

const MAX_QUERIES = 600;

/** "dental clinic in Riyadh", for every keyword and city: whole countries become their big cities. */
export function mapsPlan(keywords: string[], regions: string[], cities: string[] = []): MapsPlan {
  let code: string | null = null;
  const places: string[] = [];
  for (const r of regions) {
    const known = COUNTRY_CITIES[r.trim().toLowerCase()];
    if (known) {
      code ??= known.code;
      places.push(...(cities.length ? [] : known.cities.map((c) => `${c}, ${r.trim()}`)));
    } else if (!cities.length) places.push(r.trim());
  }
  for (const c of cities) places.push(regions.length === 1 ? `${c.trim()}, ${regions[0].trim()}` : c.trim());
  const where = [...new Set(places.filter(Boolean))];
  const queries: string[] = [];
  // City by city, so the first rounds already spread across the country instead of exhausting one keyword.
  for (const w of where) for (const k of keywords) queries.push(`${k} in ${w}`);
  return { queries: queries.slice(0, MAX_QUERIES), regionCode: code };
}

/** Sites that are not the business's own domain: a profile page there says nothing about who works at it. */
const NOT_OWN_SITE = /(^|\.)(facebook|instagram|linktr|wa|whatsapp|twitter|x|tiktok|youtube|snapchat|linkedin|google|business\.site|sites\.google|wixsite|blogspot|wordpress|squarespace|weebly|godaddysites|taplink|bio|beacons|salla|zid|shopify|myshopify|calendly|booking|vezeeta|okadoc|tabib|cura)\.[a-z.]+$/i;

export function ownDomain(website: string | null): string | null {
  const d = extractDomain(website);
  if (!d || isFreeMailDomain(d) || NOT_OWN_SITE.test(d)) return null;
  return d;
}

/** Waiting people from Maps under this, and the campaign's Maps searches run before the next round. */
const MAPS_LOW_WATER = 60;

interface AudienceEntry {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  page: number;
  saturatedAt: string | null;
  source?: LeadSource;
  namedOnly?: boolean;
  maps?: MapsCursor;
}

export interface MapsResult {
  searches: number;
  places: number;
  people: number;
  siteEmails: number;
  skipped: number;
}

/** People search at one business's domain, with the campaign's titles or seniorities but none of its company filters. */
function atDomain(filters: Record<string, unknown>, domain: string): Record<string, unknown> {
  const { q_organization_keyword_tags: _k, person_locations: _l, organization_num_employees_ranges: _s, revenue_range: _r, q_organization_job_titles: _j, ...people } = filters;
  void _k, _l, _s, _r, _j;
  return { ...people, q_organization_domains_list: [domain] };
}

/**
 * One round of Maps searching for a campaign's Maps audiences, while their waiting list is short. At most
 * MAPS_SEARCHES_PER_RUN billed searches per audience per round.
 */
export async function growFromMaps(orgId: string, campaignId: string, opts: { searches?: number } = {}): Promise<MapsResult> {
  const out: MapsResult = { searches: 0, places: 0, people: 0, siteEmails: 0, skipped: 0 };
  const places = await placesFor(orgId);
  if (!places) return out;
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.status !== "ACTIVE") return out;
  const list = (Array.isArray(campaign.audiences) ? campaign.audiences : []) as unknown as AudienceEntry[];
  const apollo = await apolloFor(orgId);
  const audience = brandProfileOf(await getSettings(orgId)).audience;
  const budget = opts.searches ?? env.MAPS_SEARCHES_PER_RUN;
  let changed = false;

  for (const a of list) {
    if (!a.maps || (a.source !== "maps" && a.source !== "both") || a.maps.doneAt || !a.maps.queries.length) continue;
    const waiting = await prisma.prospect.count({ where: { organizationId: orgId, campaignId, audienceId: a.id, status: "WAITING", source: { in: ["maps", "maps-site"] } } });
    if (waiting >= MAPS_LOW_WATER) continue;
    for (let n = 0; n < budget && !a.maps.doneAt; n++) {
      const query = a.maps.queries[a.maps.at];
      let page: { places: Place[]; next: string | null };
      try {
        page = await places.searchText(query, { regionCode: a.maps.regionCode, pageToken: a.maps.token });
      } catch (err) {
        await logSystem(orgId, "WARN", "maps", `Google Maps search failed: ${(err as Error).message}`.slice(0, 300));
        break;
      }
      out.searches++;
      changed = true;
      await addUsage(orgId, "searches");
      if (page.next) a.maps.token = page.next;
      else {
        a.maps.token = null;
        a.maps.at++;
        if (a.maps.at >= a.maps.queries.length) a.maps.doneAt = new Date().toISOString();
      }
      for (const p of page.places) {
        out.places++;
        const r = await lookAtPlace(orgId, campaign, a, p, query, apollo, audience);
        out.people += r.people;
        out.siteEmails += r.siteEmail ? 1 : 0;
        out.skipped += r.skipped ? 1 : 0;
      }
    }
  }
  if (changed) await prisma.campaign.update({ where: { id: campaign.id }, data: { audiences: list as unknown as Prisma.InputJsonValue } });
  return out;
}

async function lookAtPlace(
  orgId: string,
  campaign: Campaign,
  a: AudienceEntry,
  p: Place,
  query: string,
  apollo: Awaited<ReturnType<typeof apolloFor>>,
  audience: ReturnType<typeof brandProfileOf>["audience"],
): Promise<{ people: number; siteEmail: boolean; skipped: boolean }> {
  const seen = await prisma.mapsPlace.findUnique({ where: { organizationId_placeId: { organizationId: orgId, placeId: p.id } }, select: { id: true } });
  if (seen) return { people: 0, siteEmail: false, skipped: true };
  const domain = ownDomain(p.website);
  const record = (status: string, people = 0) =>
    prisma.mapsPlace
      .create({ data: { organizationId: orgId, campaignId: campaign.id, audienceId: a.id, placeId: p.id, domain, name: p.name, address: p.address, city: p.city, status, people, query } })
      .catch(() => undefined);
  if (!domain) {
    await record("no-site");
    return { people: 0, siteEmail: false, skipped: true };
  }
  // One business, one look: a domain already in a list, already contacted, already seen on Maps or blocked is skipped.
  const [listed, contacted, mapped, blocked] = await Promise.all([
    prisma.prospect.count({ where: { organizationId: orgId, companyDomain: domain } }),
    prisma.contact.count({ where: { organizationId: orgId, companyDomain: domain } }),
    prisma.mapsPlace.count({ where: { organizationId: orgId, domain } }),
    prisma.blocklistEntry.count({ where: { organizationId: orgId, entryType: "DOMAIN", value: domain } }),
  ]);
  if (listed || contacted || mapped || blocked) {
    await record("skipped");
    return { people: 0, siteEmail: false, skipped: true };
  }

  let people: ApolloPerson[] = [];
  if (apollo) {
    try {
      people = (await apollo.searchPeople(atDomain(a.filters, domain), 1, 10)).people;
      await addUsage(orgId, "searches");
    } catch {
      people = [];
    }
  }
  const rows: Prisma.ProspectCreateManyInput[] = [];
  for (const person of people) {
    if (!person.id) continue;
    const { fitScore } = scoreContact(
      { title: person.title, seniority: person.seniority, emailStatus: person.email_status, employees: person.organization?.estimated_num_employees, industry: person.organization?.industry, website: p.website, linkedinUrl: person.linkedin_url },
      audience,
    );
    if (fitScore < SEND_FLOOR) continue;
    rows.push({
      organizationId: orgId,
      campaignId: campaign.id,
      audienceId: a.id,
      apolloId: person.id,
      fullName: person.name ?? ([person.first_name, person.last_name].filter(Boolean).join(" ") || null),
      title: person.title ?? null,
      seniority: person.seniority ?? null,
      company: p.name ?? person.organization?.name ?? null,
      companyDomain: domain,
      country: person.country ?? person.organization?.country ?? null,
      employees: person.organization?.estimated_num_employees ?? null,
      fitScore,
      source: "maps",
      placeId: p.id,
      city: p.city,
    });
  }
  if (rows.length) {
    const n = (await prisma.prospect.createMany({ data: rows, skipDuplicates: true })).count;
    await record("matched", n);
    return { people: n, siteEmail: false, skipped: false };
  }

  if (a.namedOnly) {
    await record("nobody");
    return { people: 0, siteEmail: false, skipped: false };
  }
  const emails = await readSiteEmails(domain).catch(() => [] as string[]);
  // The best published address: one that reaches whoever runs the place, before bookings and noreply.
  const rank = (e: string) => {
    const local = e.split("@")[0];
    if (/^(no-?reply|donotreply|mailer|bounce)/.test(local)) return 9;
    if (/^(ceo|owner|founder|director|management|admin|manager|gm)/.test(local)) return 0;
    if (/^(info|contact|hello|enquir|inquir|office)/.test(local)) return 1;
    if (/^(reception|booking|appointments?|care|support)/.test(local)) return 2;
    return 3;
  };
  const email = emails.filter((e) => rank(e) < 9).sort((x, y) => rank(x) - rank(y))[0];
  if (!email) {
    await record("nobody");
    return { people: 0, siteEmail: false, skipped: false };
  }
  const { fitScore } = scoreContact({ title: null, seniority: null, website: p.website }, audience);
  await prisma.prospect
    .create({
      data: {
        organizationId: orgId,
        campaignId: campaign.id,
        audienceId: a.id,
        apolloId: `maps:${p.id}`,
        fullName: null,
        company: p.name,
        companyDomain: domain,
        country: null,
        fitScore: Math.max(SEND_FLOOR, fitScore),
        source: "maps-site",
        email,
        placeId: p.id,
        city: p.city,
      },
    })
    .catch(() => undefined);
  await record("site-email", 1);
  return { people: 0, siteEmail: true, skipped: false };
}

/** Google's terms: place content other than the id is not kept for good. Clears names and addresses after 30 days. */
export async function forgetOldPlaceDetails(): Promise<number> {
  const r = await prisma.mapsPlace.updateMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 86_400_000) }, OR: [{ name: { not: null } }, { address: { not: null } }] }, data: { name: null, address: null } });
  return r.count;
}
