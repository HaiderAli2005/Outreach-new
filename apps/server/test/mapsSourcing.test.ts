import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makePoolMailbox, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setApolloFactory, type ApolloPerson } from "../src/integrations/apollo.js";
import { setPlacesFactory, type Place } from "../src/integrations/places.js";
import { setSiteEmailReader } from "../src/integrations/site.js";
import { forgetOldPlaceDetails, growFromMaps, mapsPlan, ownDomain } from "../src/domain/mapsSourcing.js";
import { sourceForCampaign } from "../src/domain/sourcing.js";

const place = (id: string, name: string, website: string | null): Place => ({ id, name, address: `${name}, Riyadh`, website, city: "Riyadh", types: ["dentist"] });
const dentist: ApolloPerson = { id: "ap-omar", first_name: "Omar", last_name: "Saleh", name: "Omar Saleh", title: "Clinic Manager", seniority: "manager", email: "omar@smile.sa", email_status: "verified", organization: { name: "Smile Dental", primary_domain: "smile.sa", estimated_num_employees: 25 } };

function fakes() {
  const calls = { searches: [] as string[], apollo: [] as Record<string, unknown>[], sites: [] as string[] };
  setPlacesFactory(async () => ({
    searchText: async (q: string) => {
      calls.searches.push(q);
      return { places: [place("p1", "Smile Dental", "https://www.smile.sa/ar"), place("p2", "Care Clinic", "https://care.sa"), place("p3", "Insta Teeth", "https://instagram.com/instateeth"), place("p4", "No Web", null)], next: null };
    },
  }));
  setApolloFactory(async () => ({
    searchPeople: async (f: Record<string, unknown>) => {
      calls.apollo.push(f);
      return { people: (f.q_organization_domains_list as string[])?.[0] === "smile.sa" ? [dentist] : [], totalEntries: 0 };
    },
    bulkEnrich: async () => [dentist],
  }));
  setSiteEmailReader(async (d) => (calls.sites.push(d), d === "care.sa" ? ["noreply@care.sa", "reception@care.sa", "info@care.sa"] : []));
  return calls;
}

async function workspace(namedOnly = false) {
  await makePoolMailbox();
  const t = await createTenant({ balance: BigInt(10_000) });
  await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, autopilotEnabled: true } });
  const campaign = await makeCampaign(t.orgId);
  const plan = mapsPlan(["dental clinic", "dentistry"], ["Saudi Arabia"], ["Riyadh", "Jeddah"]);
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { audiences: [{ id: "c1", name: "Clinics", filters: { person_seniorities: ["owner", "manager"], q_organization_keyword_tags: ["dental clinic"], person_locations: ["Saudi Arabia"] }, page: 1, saturatedAt: null, source: "maps", namedOnly, maps: { ...plan, at: 0, token: null, doneAt: null } }] },
  });
  return { t, campaign: await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } }) };
}

describe("Google Maps sourcing", () => {
  beforeEach(async () => {
    await resetDb();
    setPlacesFactory(null);
    setSiteEmailReader(null);
  });

  it("plans one search per keyword and city, and turns a country into its big cities", () => {
    const sa = mapsPlan(["dental clinic"], ["Saudi Arabia"]);
    expect(sa.regionCode).toBe("SA");
    expect(sa.queries).toHaveLength(20);
    expect(sa.queries[0]).toBe("dental clinic in Riyadh, Saudi Arabia");
    expect(sa.queries).toContain("dental clinic in Al Ahsa, Saudi Arabia");
    expect(mapsPlan(["law firm", "lawyers"], ["Saudi Arabia"], ["Riyadh"]).queries).toEqual(["law firm in Riyadh, Saudi Arabia", "lawyers in Riyadh, Saudi Arabia"]);
    expect(ownDomain("https://instagram.com/x")).toBeNull();
    expect(ownDomain("https://www.smile.sa/ar")).toBe("smile.sa");
  });

  it("finds businesses, then named people on Apollo at their domain, else the address their site publishes", async () => {
    const { t, campaign } = await workspace();
    const calls = fakes();
    const r = await growFromMaps(t.orgId, campaign.id, { searches: 2 });
    expect(calls.searches).toEqual(["dental clinic in Riyadh, Saudi Arabia", "dentistry in Riyadh, Saudi Arabia"]);
    expect(r).toMatchObject({ searches: 2, people: 1, siteEmails: 1 });
    // Apollo is asked about people at that one domain, with the campaign's seniorities and none of its company filters.
    expect(calls.apollo[0]).toEqual({ person_seniorities: ["owner", "manager"], q_organization_domains_list: ["smile.sa"] });
    const prospects = await prisma.prospect.findMany({ where: { organizationId: t.orgId }, orderBy: { createdAt: "asc" } });
    expect(prospects.map((p) => [p.source, p.apolloId, p.email, p.companyDomain])).toEqual([
      ["maps", "ap-omar", null, "smile.sa"],
      ["maps-site", "maps:p2", "info@care.sa", "care.sa"],
    ]);
    const places = await prisma.mapsPlace.findMany({ where: { organizationId: t.orgId }, orderBy: { placeId: "asc" } });
    expect(places.map((p) => p.status)).toEqual(["matched", "site-email", "no-site", "no-site"]);
    // The second search returned the same places: each business is looked at once.
    expect(calls.sites).toEqual(["care.sa"]);
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect((after.audiences as { maps: { at: number } }[])[0].maps.at).toBe(2);

    // When their turn comes: Omar's email is looked up; the clinic's published address is stored as it is.
    const pulled = await sourceForCampaign(t.orgId, after, { maxEnrich: 10, batchId: null });
    expect(pulled.inserted).toBe(2);
    const contacts = await prisma.contact.findMany({ where: { organizationId: t.orgId }, orderBy: { email: "asc" } });
    expect(contacts.map((c) => [c.email, c.source, c.emailSource])).toEqual([
      ["info@care.sa", "maps", "website"],
      ["omar@smile.sa", "apollo", "apollo"],
    ]);
  });

  it("a named-people-only campaign never takes a published address", async () => {
    const { t, campaign } = await workspace(true);
    fakes();
    await growFromMaps(t.orgId, campaign.id, { searches: 1 });
    expect(await prisma.prospect.count({ where: { organizationId: t.orgId, source: "maps-site" } })).toBe(0);
    expect((await prisma.mapsPlace.findFirstOrThrow({ where: { placeId: "p2" } })).status).toBe("nobody");
  });

  it("without a Google key nothing is searched, and place names are forgotten after 30 days", async () => {
    const { t, campaign } = await workspace();
    expect(await growFromMaps(t.orgId, campaign.id)).toMatchObject({ searches: 0 });
    fakes();
    await growFromMaps(t.orgId, campaign.id, { searches: 1 });
    await prisma.mapsPlace.updateMany({ data: { createdAt: new Date(Date.now() - 31 * 86_400_000) } });
    expect(await forgetOldPlaceDetails()).toBe(4);
    expect(await prisma.mapsPlace.count({ where: { name: { not: null } } })).toBe(0);
    expect(await prisma.mapsPlace.count()).toBe(4);
  });

  it("a campaign made with Google Maps as its source gets its searches planned", async () => {
    const t = await createTenant();
    await prisma.onboarding.create({ data: { organizationId: t.orgId, domain: "northwind.io", brand: "Northwind", icp: {}, launchedAt: new Date(), analyzedAt: new Date(), groups: [] } });
    const campaign = await makeCampaign(t.orgId);
    await api()
      .post("/api/v1/setup/targeting/audiences")
      .set(t.auth)
      .send({ name: "Clinics", keywords: ["dental clinic"], regions: ["Saudi Arabia"], seniorities: ["owner"], source: "both", mapsCities: ["Riyadh", "Dammam"] })
      .expect(200);
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    const a = (c.audiences as { source: string; namedOnly: boolean; maps: { queries: string[]; regionCode: string } }[])[0];
    expect(a).toMatchObject({ source: "both", namedOnly: false, maps: { regionCode: "SA", queries: ["dental clinic in Riyadh, Saudi Arabia", "dental clinic in Dammam, Saudi Arabia"] } });
  });
});
