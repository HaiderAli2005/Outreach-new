import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

/** The Leads page shows the whole funnel: found in the audience list, looked up, with a working email, waiting. */
describe("audience list view", () => {
  beforeEach(resetDb);

  it("counts the funnel and lists the people, waiting ones and searchable", async () => {
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { audiences: [{ id: "a1", name: "Agency owners" }] } });
    for (let i = 0; i < 5; i++) await prisma.prospect.create({ data: { organizationId: t.orgId, campaignId: campaign.id, audienceId: "a1", apolloId: `w${i}`, fullName: `Wait ${i}`, company: i === 0 ? "Northwind" : "Acme", fitScore: 80 + i } });
    for (let i = 0; i < 3; i++) await prisma.prospect.create({ data: { organizationId: t.orgId, campaignId: campaign.id, apolloId: `p${i}`, fullName: `Pulled ${i}`, status: "PULLED" } });
    await makeContact(t.orgId, { campaignId: campaign.id, source: "apollo" });
    await makeContact(t.orgId, { campaignId: campaign.id, source: "apollo", email: "b@x.com", emailNormalized: "b@x.com" });
    const r = (await api().get("/api/v1/sourcing/audience").set(t.auth).expect(200)).body.data;
    expect(r.counts).toEqual({ found: 8, lookedUp: 3, withEmail: 2, noEmail: 1, waiting: 5 });
    expect(r.rows[0]).toMatchObject({ status: "WAITING", fitScore: 84, audience: "Agency owners" });
    const q = (await api().get("/api/v1/sourcing/audience?q=north&status=WAITING").set(t.auth).expect(200)).body.data;
    expect(q.rows.map((x: { fullName: string }) => x.fullName)).toEqual(["Wait 0"]);
    await api().get("/api/v1/sourcing/audience?status=NOPE").set(t.auth).expect(400);
  });
});
