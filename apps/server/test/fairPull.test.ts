import { beforeEach, describe, expect, it } from "vitest";
import { createTenant, makeCampaign, makePoolMailbox, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setApolloFactory, type ApolloPerson } from "../src/integrations/apollo.js";
import { sourceForCampaign } from "../src/domain/sourcing.js";

const person = (id: string): ApolloPerson => ({ id, first_name: "Sam", last_name: id, name: `Sam ${id}`, title: "CEO", email: `${id}@${id}.com`, email_status: "verified", organization: { name: id, primary_domain: `${id}.com`, estimated_num_employees: 40 } });

describe("pulling people across campaigns", () => {
  beforeEach(resetDb);

  it("gives every campaign that is on its share of the round, and none to a campaign switched off", async () => {
    await makePoolMailbox();
    const t = await createTenant({ balance: BigInt(10_000) });
    const campaign = await makeCampaign(t.orgId);
    const entry = (id: string) => ({ id, name: id, filters: {}, page: 2, saturatedAt: null });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { audiences: [entry("setup"), entry("eng"), entry("freight")] } });
    const add = (audienceId: string, n: number, fitScore: number) =>
      prisma.prospect.createMany({ data: Array.from({ length: n }, (_, i) => ({ organizationId: t.orgId, campaignId: campaign.id, audienceId, apolloId: `${audienceId}${i}`, fitScore })) });
    // The setup audience was searched first and fits best; an audience switched off still has people waiting.
    await add("setup", 50, 90);
    await add("eng", 20, 70);
    await add("freight", 2, 60);
    await add("off", 50, 100);
    setApolloFactory(async () => ({ searchPeople: async () => ({ people: [], totalEntries: 0 }), bulkEnrich: async (ids: { id?: string }[]) => ids.map((x) => person(x.id!)) }));

    const fresh = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    await sourceForCampaign(t.orgId, fresh, { maxEnrich: 12, batchId: null });
    const pulled = await prisma.prospect.groupBy({ by: ["audienceId"], where: { organizationId: t.orgId, status: "PULLED" }, _count: { _all: true } });
    const by = Object.fromEntries(pulled.map((p) => [p.audienceId, p._count._all]));
    // 12 turns: 4 each; freight only has 2, so its other 2 go to the best fit of the rest.
    expect(by.off).toBeUndefined();
    expect(by.freight).toBe(2);
    expect(by.setup + by.eng).toBe(10);
    expect(by.eng).toBeGreaterThanOrEqual(4);
  });
});

describe("a search the lead search refuses", () => {
  beforeEach(resetDb);

  it("rests that one campaign, says which, and the others carry on", async () => {
    const t = await createTenant({ balance: BigInt(10_000) });
    const campaign = await makeCampaign(t.orgId);
    const entry = (id: string) => ({ id, name: id, filters: { q_organization_keyword_tags: [id] }, page: 1, saturatedAt: null });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "ACTIVE", audiences: [entry("broken"), entry("fine")] } });
    const { HttpError } = await import("../src/integrations/http.js");
    setApolloFactory(async () => ({
      searchPeople: async (f: Record<string, unknown>) => {
        if ((f.q_organization_keyword_tags as string[])[0] === "broken") throw new HttpError(422, "HTTP 422", "");
        return { people: [person("p1"), person("p2")], totalEntries: 2 };
      },
      bulkEnrich: async () => [],
    }));
    const { growList } = await import("../src/domain/sourcing.js");
    const r = await growList(t.orgId, campaign.id, { pages: 3 });
    expect(r.added).toBe(2);
    const log = await prisma.systemLog.findFirstOrThrow({ where: { organizationId: t.orgId, source: "sourcing" } });
    expect(log.message).toMatch(/refused the search for "broken"/);
  });
});
