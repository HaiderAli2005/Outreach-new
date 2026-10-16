import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

describe("campaigns", () => {
  beforeEach(resetDb);

  it("lists campaigns with live counts and reply rates", async () => {
    const t = await createTenant();
    const c = await makeCampaign(t.orgId, { name: "UK agencies" });
    await makeContact(t.orgId, { campaignId: c.id, firstContactedAt: new Date(), repliedAt: new Date() });
    await makeContact(t.orgId, { campaignId: c.id, firstContactedAt: new Date() });
    await makeContact(t.orgId, { campaignId: c.id, status: "BOUNCED", firstContactedAt: new Date() });
    const res = await api().get("/api/v1/campaigns").set(t.auth);
    expect(res.body.data[0]).toMatchObject({ name: "UK agencies", leadCount: 2, contactedCount: 2, replyCount: 1, replyRate: 50 });
  });

  it("has no campaign limit: any number can run, paid per email", async () => {
    const t = await createTenant();
    await makeCampaign(t.orgId, { status: "ACTIVE" });
    await makeCampaign(t.orgId, { status: "ACTIVE" });
    const third = await api().post("/api/v1/campaigns").set(t.auth).send({ name: "Third" });
    expect(third.status).toBe(201);
    await api().patch(`/api/v1/campaigns/${third.body.data.id}/status`).set(t.auth).send({ status: "ACTIVE" }).expect(200);
  });

  it("only edits targeting while a campaign is not running", async () => {
    const t = await createTenant();
    const c = await makeCampaign(t.orgId, { status: "ACTIVE" });
    await api().patch(`/api/v1/campaigns/${c.id}`).set(t.auth).send({ name: "New name" }).expect(422);
    await api().patch(`/api/v1/campaigns/${c.id}/status`).set(t.auth).send({ status: "PAUSED" }).expect(200);
    const res = await api().patch(`/api/v1/campaigns/${c.id}`).set(t.auth).send({ apolloFilters: { person_titles: ["CEO"], organization_num_employees_ranges: ["11,50"] } });
    expect(res.status).toBe(200);
    await api().patch(`/api/v1/campaigns/${c.id}`).set(t.auth).send({ apolloFilters: { organization_num_employees_ranges: ["lots"] } }).expect(400);
  });

  it("exports the campaign dossier", async () => {
    const t = await createTenant();
    const c = await makeCampaign(t.orgId, { name: "Dossier" });
    await makeContact(t.orgId, { campaignId: c.id, fullName: "Pat Doe" });
    const res = await api().get(`/api/v1/campaigns/${c.id}/export`).set(t.auth);
    expect(res.text).toContain("CAMPAIGN");
    expect(res.text).toContain("Pat Doe");
  });

  it("needs credits to resume a campaign", async () => {
    const t = await createTenant({ subscribed: false });
    const c = await makeCampaign(t.orgId, { status: "PAUSED" });
    await api().patch(`/api/v1/campaigns/${c.id}/status`).set(t.auth).send({ status: "ACTIVE" }).expect(402);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PAUSED");
  });
});
