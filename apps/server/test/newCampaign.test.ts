import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setApolloFactory } from "../src/integrations/apollo.js";
import { settleFirstRuns } from "../src/modules/onboarding/firstRun.js";

const group = (id: string, name: string) => ({
  id, priority: 1, name, description: `${name} buyers`, why: "", goals: [], pains: [], objections: [], titles: ["Head of Operations"],
  includeSimilarTitles: true, seniorities: [], sizes: ["11,50"], regions: ["United Kingdom"], keywords: ["marketing agency"], keywordSuggestions: [],
  revenueRange: { min: null, max: null }, technologies: [], signals: { hiringForTitles: [], headcountGrowthPctMin: null, recentlyFunded: false },
  lookalikeDomains: [], excludeDomains: [], on: true,
});

async function launched() {
  const t = await createTenant();
  await prisma.onboarding.create({
    data: { organizationId: t.orgId, domain: "northwind.io", brand: "Northwind", icp: {}, launchedAt: new Date(), analyzedAt: new Date(), groups: [group("g1", "Agency ops")] },
  });
  const campaign = await makeCampaign(t.orgId);
  await prisma.campaign.update({ where: { id: campaign.id }, data: { audiences: [{ id: "g1", name: "Agency ops", filters: {}, page: 4, saturatedAt: null }] } });
  return { ...t, campaignId: campaign.id };
}

const owners = {
  name: "Engineering offices · owners",
  description: "Engineering consultancies and architecture offices in Saudi Arabia",
  why: "They win work through referrals and want a steadier pipeline",
  titles: [],
  includeSimilarTitles: false,
  seniorities: ["owner", "founder", "c_suite", "partner"],
  keywords: ["engineering consultancy", "engineering consulting", "architectural design", "architecture", "structural engineering", "building design", "project supervision", "mep design", "villa design"],
  sizes: ["1,10", "11,50", "51,200"],
  regions: ["Saudi Arabia"],
};

describe("New campaign", () => {
  beforeEach(resetDb);

  it("adds an audience that is searched on its own, with exact titles, owners only and more than five keywords", async () => {
    const t = await launched();
    const made = (await api().post("/api/v1/setup/targeting/audiences").set(t.auth).send(owners).expect(200)).body.data;
    expect(made.name).toBe(owners.name);

    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: t.campaignId } });
    const list = c.audiences as { id: string; name: string; page: number; filters: Record<string, unknown> }[];
    expect(list.map((a) => a.name)).toEqual(["Agency ops", owners.name]);
    expect(list[0].page).toBe(4);
    const f = list[1].filters;
    expect(f.person_titles).toEqual([]);
    expect(f.person_seniorities).toEqual(owners.seniorities);
    expect(f.include_similar_titles).toBe(false);
    expect(f.q_organization_keyword_tags).toHaveLength(9);
    expect(f.person_locations).toEqual(["Saudi Arabia"]);
    expect(f.organization_num_employees_ranges).toEqual(["1,10", "11,50", "51,200"]);

    const view = (await api().get("/api/v1/setup/targeting").set(t.auth).expect(200)).body.data;
    expect(view.groups.map((g: { name: string }) => g.name)).toContain(owners.name);
    // Its keywords can be edited later without hitting the five-keyword limit of setup's audiences.
    const edits = view.groups.map((g: { id: string; on: boolean; titles: string[]; keywords: string[]; sizes: string[]; regions: string[] }) => ({ id: g.id, on: g.on, titles: g.titles, keywords: g.keywords, sizes: g.sizes, regions: g.regions }));
    await api().put("/api/v1/setup/targeting").set(t.auth).send({ groups: edits, dropQueued: false }).expect(200);
  });

  it("asks for what it needs and refuses a second campaign with the same name", async () => {
    const t = await launched();
    await api().post("/api/v1/setup/targeting/audiences").set(t.auth).send({ ...owners, seniorities: [], titles: [] }).expect(400);
    await api().post("/api/v1/setup/targeting/audiences").set(t.auth).send({ ...owners, regions: [] }).expect(400);
    await api().post("/api/v1/setup/targeting/audiences").set(t.auth).send({ ...owners, keywords: [] }).expect(400);
    await api().post("/api/v1/setup/targeting/audiences").set(t.auth).send(owners).expect(200);
    await api().post("/api/v1/setup/targeting/audiences").set(t.auth).send({ ...owners, name: owners.name.toUpperCase() }).expect(400);
  });

  it("previews how many people a campaign finds, with a few of them, before it is saved", async () => {
    const t = await launched();
    const seen: Record<string, unknown>[] = [];
    setApolloFactory(async () => ({
      searchPeople: async (f: Record<string, unknown>) => (seen.push(f), { people: [{ id: "p1", first_name: "Omar", last_name: "Saleh", title: "Founder", organization: { name: "Najd Engineering" } }], totalEntries: 1849 }),
      bulkEnrich: async () => [],
    }));
    const incomplete = (await api().post("/api/v1/setup/targeting/audiences/preview").set(t.auth).send({ ...owners, keywords: [] }).expect(200)).body.data;
    expect(incomplete).toMatchObject({ ready: false, reason: "incomplete" });
    const view = (await api().post("/api/v1/setup/targeting/audiences/preview").set(t.auth).send({ ...owners, name: "" }).expect(200)).body.data;
    expect(view).toMatchObject({ ready: true, count: 1849, people: [{ firstName: "Omar", lastInitial: "S", title: "Founder", company: "Najd Engineering" }] });
    expect(seen[0]).toMatchObject({ person_seniorities: owners.seniorities, include_similar_titles: false, person_locations: ["Saudi Arabia"] });
    // The same search again is answered from the cache.
    await api().post("/api/v1/setup/targeting/audiences/preview").set(t.auth).send(owners).expect(200);
    expect(seen).toHaveLength(1);
    expect(await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } }).then((o) => (o.groups as unknown[]).length)).toBe(1);
  });

  it("imports many campaigns from one file, checking every row first and creating none if one is wrong", async () => {
    const t = await launched();
    const managers = { ...owners, name: "Engineering offices · managers", seniorities: ["vp", "head", "director", "manager", "senior"], titles: ["marketing manager"] };
    const bad = { ...owners, name: "Freight · owners", regions: [] };
    const checked = (await api().post("/api/v1/setup/targeting/audiences/import").set(t.auth).send({ rows: [owners, managers, bad], check: true }).expect(200)).body.data;
    expect(checked.ok).toBe(false);
    expect(checked.rows.map((r: { error: string | null }) => r.error)).toEqual([null, null, "Add at least one location."]);
    const tried = (await api().post("/api/v1/setup/targeting/audiences/import").set(t.auth).send({ rows: [owners, managers, bad] }).expect(200)).body.data;
    expect(tried.created).toEqual([]);
    expect((await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } })).groups as unknown[]).toHaveLength(1);

    // The same name twice in one file is caught too.
    const twice = (await api().post("/api/v1/setup/targeting/audiences/import").set(t.auth).send({ rows: [owners, owners], check: true }).expect(200)).body.data;
    expect(twice.rows[1].error).toMatch(/already have a campaign/);

    const done = (await api().post("/api/v1/setup/targeting/audiences/import").set(t.auth).send({ rows: [owners, managers] }).expect(200)).body.data;
    expect(done.ok).toBe(true);
    expect(done.created.map((c: { name: string }) => c.name)).toEqual([owners.name, managers.name]);
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: t.campaignId } });
    expect((c.audiences as { name: string }[]).map((a) => a.name)).toEqual(["Agency ops", owners.name, managers.name]);
  });

  it("searches for a new campaign straight away, and says its people are lined up", async () => {
    const t = await launched();
    await prisma.campaign.update({ where: { id: t.campaignId }, data: { status: "ACTIVE" } });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { launchMode: "AUTO", autopilotEnabled: true } });
    setApolloFactory(async () => ({
      searchPeople: async (_f: Record<string, unknown>, page: number) => ({
        people: page === 1 ? [1, 2, 3].map((i) => ({ id: `ap${i}`, first_name: "Omar", last_name: `S${i}`, title: "Founder", seniority: "founder", organization: { name: `Najd ${i}`, primary_domain: `najd${i}.sa` } })) : [],
        totalEntries: 3,
      }),
      bulkEnrich: async () => [],
    }));
    const made = (await api().post("/api/v1/setup/targeting/audiences").set(t.auth).send(owners).expect(200)).body.data;
    await settleFirstRuns();
    expect(await prisma.prospect.count({ where: { organizationId: t.orgId, audienceId: made.id, status: "WAITING" } })).toBe(3);
    const perf = (await api().get("/api/v1/dashboard/performance?period=7d").set(t.auth).expect(200)).body.data;
    expect(perf.audiences.find((a: { id: string }) => a.id === made.id)).toMatchObject({ state: "lined-up", inLine: 3 });
  });

  it("every campaign in an import gets its own first search straight away", async () => {
    const t = await launched();
    await prisma.campaign.update({ where: { id: t.campaignId }, data: { status: "ACTIVE" } });
    const asked: string[] = [];
    setApolloFactory(async () => ({
      searchPeople: async (f: Record<string, unknown>, page: number) => {
        const tag = (f.q_organization_keyword_tags as string[])[0];
        asked.push(tag);
        return { people: page === 1 ? [1, 2].map((i) => ({ id: `${tag}-${i}`, first_name: "Omar", title: "Founder", seniority: "founder", organization: { name: `${tag} ${i}`, primary_domain: `${tag.replace(/\W/g, "")}${i}.sa` } })) : [], totalEntries: 2 };
      },
      bulkEnrich: async () => [],
    }));
    const rows = ["audit", "freight forwarding", "interior design", "law firm", "dental clinic", "architecture"].map((k, i) => ({ ...owners, name: `Campaign ${i}`, keywords: [k] }));
    const done = (await api().post("/api/v1/setup/targeting/audiences/import").set(t.auth).send({ rows }).expect(200)).body.data;
    await settleFirstRuns();
    for (const c of done.created as { id: string }[]) expect(await prisma.prospect.count({ where: { organizationId: t.orgId, audienceId: c.id } })).toBe(2);
    // The existing audience gets no list search from the import: only the new ones fill.
    expect(await prisma.prospect.count({ where: { organizationId: t.orgId, audienceId: "g1" } })).toBe(0);
  });
});
