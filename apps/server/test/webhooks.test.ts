import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { recordMessage } from "../src/domain/messages.js";

async function setup() {
  const t = await createTenant();
  const campaign = await makeCampaign(t.orgId);
  const contact = await makeContact(t.orgId, { email: "ann@acme.com", emailNormalized: "ann@acme.com", companyDomain: "acme.com", status: "CONTACTED", campaignId: campaign.id, firstContactedAt: new Date() });
  await recordMessage(prisma, { organizationId: t.orgId, contactId: contact.id, direction: "OUTBOUND", via: "sequence", body: "Our first email" });
  return { t, campaign, contact };
}

describe("calendly webhook", () => {
  beforeEach(resetDb);

  it("stops automation when a meeting is booked", async () => {
    const { t, contact } = await setup();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: t.orgId } });
    const res = await api().post(`/api/v1/webhooks/calendly/${org.webhookToken}?token=test-webhook-secret`).send({ event: "invitee.created", payload: { email: "ann@acme.com" } });
    expect(res.body.data.status).toBe("booked");
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.meetingBookedAt).not.toBeNull();
    expect(after.autoReplyStatus).toBe("MANUAL");
  });
});

describe("per-organization webhook urls", () => {
  beforeEach(resetDb);

  it("rejects unknown organization tokens and the old sending-provider routes are gone", async () => {
    await api().post("/api/v1/webhooks/calendly/not-a-real-token-value").send({}).expect(401);
    await api().post("/api/v1/webhooks/apollo/not-a-real-token-value").send({}).expect(401);
    const gone = await api().post("/api/v1/webhooks/sending-provider?token=test-webhook-secret").send({});
    expect(gone.status).toBeGreaterThanOrEqual(400);
  });
});
