import { beforeEach, describe, expect, it } from "vitest";
import { createTenant, makeCampaign, makeContact, makePoolMailbox, resetDb, fakeAi, transport } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient } from "../src/integrations/ai.js";
import { recordMessage } from "../src/domain/messages.js";
import { runReplyIntelligence } from "../src/domain/replyIntelligence.js";
import { api } from "./helpers.js";

async function thread(orgId: string, reply: string, extra: Record<string, unknown> = {}) {
  const campaign = await makeCampaign(orgId);
  const contact = await makeContact(orgId, { email: "sam@firm.com", emailNormalized: "sam@firm.com", companyDomain: "firm.com", status: "REPLIED", campaignId: campaign.id, assignedMailboxId: (await makePoolMailbox()).id, ...extra });
  await recordMessage(prisma, { organizationId: orgId, contactId: contact.id, direction: "OUTBOUND", via: "sequence", body: "First email", createdAt: new Date(Date.now() - 86_400_000) });
  const msg = await recordMessage(prisma, { organizationId: orgId, contactId: contact.id, direction: "INBOUND", via: "email", body: reply, emailMessageId: "<their-reply@firm.com>" });
  return { contact, msg, campaign };
}

const draft = "Hi Sam,\nFair question. The short version is that it depends on your volume, happy to walk you through it on a quick call.";

describe("reply classification actions", () => {
  beforeEach(resetDb);

  it("flags a hot lead with a draft and never sends while autonomy is off", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "What does it cost for a team of ten?");
    setAiClient(fakeAi({ class: "question", confidence: 0.95, draft, language: "en", sentiment: "neutral" }));
    const r = await runReplyIntelligence(t.orgId, msg.id);
    expect(r?.class).toBe("question");
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after).toMatchObject({ replyClass: "question", replyUrgent: true, intent: "INFO_REQUEST", temperature: "warm", aiDraft: draft });
    expect(transport.sent).toHaveLength(0);
    expect(await runReplyIntelligence(t.orgId, msg.id)).toBeNull();
  });

  it("suppresses the company on an opt-out and switches the agent off for good", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "Please remove me from your list");
    const colleague = await makeContact(t.orgId, { email: "kim@firm.com", emailNormalized: "kim@firm.com", companyDomain: "firm.com" });
    setAiClient(fakeAi({ class: "stop", confidence: 0.99, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after).toMatchObject({ status: "UNSUBSCRIBED", neverAuto: true, replyClass: "stop" });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: colleague.id } })).status).toBe("BLOCKLISTED");
  });

  it("blocks only the person for a bereavement note", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "We are sorry to tell you Sam passed away last month.");
    const colleague = await makeContact(t.orgId, { email: "lee@firm.com", emailNormalized: "lee@firm.com", companyDomain: "firm.com" });
    setAiClient(fakeAi({ class: "deceased", confidence: 0.99, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: colleague.id } })).status).toBe("NEW");
  });

  it("spawns the referred colleague and retires the replier who left", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "I've left the company. Please contact jo.doe@firm.com instead.");
    setAiClient(fakeAi({ class: "referral", confidence: 0.9, language: "en", referral: { emails: ["jo.doe@firm.com"], best_email: "jo.doe@firm.com", name: "Jo Doe", replier_gone: true, same_person: false } }));
    await runReplyIntelligence(t.orgId, msg.id);
    const spawned = await prisma.contact.findUniqueOrThrow({ where: { organizationId_emailNormalized: { organizationId: t.orgId, emailNormalized: "jo.doe@firm.com" } } });
    expect(spawned).toMatchObject({ source: "referral", firstName: "Jo", status: "NEW" });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).status).toBe("BLOCKLISTED");
  });

  it("does not spawn addresses the prospect never wrote", async () => {
    const t = await createTenant();
    const { msg } = await thread(t.orgId, "I've left, talk to my old boss.");
    setAiClient(fakeAi({ class: "referral", confidence: 0.9, language: "en", referral: { emails: ["invented@firm.com"], best_email: "invented@firm.com", replier_gone: true } }));
    await runReplyIntelligence(t.orgId, msg.id);
    expect(await prisma.contact.count({ where: { emailNormalized: "invented@firm.com" } })).toBe(0);
  });

  it("schedules a follow-up for an away reply", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "I'm on leave until the 12th of next month");
    const back = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    setAiClient(fakeAi({ class: "away", confidence: 0.95, return_date: back, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.replyClass).toBe("away");
    expect(after.replyUrgent).toBe(false);
    expect(after.followUpAt?.toISOString().slice(0, 10)).toBe(back);
  });
});

describe("drafts, never sent on their own", () => {
  beforeEach(resetDb);

  it("drafts for INTERESTED and INFO_REQUEST, and only a person pressing Send sends it", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "Interesting. How does onboarding work for a small team?");
    setAiClient(fakeAi({ class: "question", confidence: 0.93, draft, language: "en", sentiment: "neutral" }));
    await runReplyIntelligence(t.orgId, msg.id);
    const view = await api().get(`/api/v1/inbox/${contact.id}`).set(t.auth).expect(200);
    expect(view.body.data.draft.body).toContain("Fair question");
    expect(view.body.data).not.toHaveProperty("autoReply");
    // However long it waits, nothing goes out.
    await prisma.contact.update({ where: { id: contact.id }, data: { aiDraftAt: new Date(Date.now() - 7 * 86_400_000) } });
    expect(transport.sent).toHaveLength(0);
    await api().post(`/api/v1/inbox/${contact.id}/reply`).set(t.auth).send({ body: view.body.data.draft.body }).expect(200);
    const sent = transport.sent.at(-1)!.message;
    expect(sent.text).toContain("Fair question");
    expect(sent.inReplyTo).toBe("<their-reply@firm.com>");
    expect(sent.subject.startsWith("Re:")).toBe(true);
  });

  it("never drafts for UNCLEAR, NOT_INTERESTED or HOSTILE", async () => {
    const t = await createTenant();
    for (const [cls, body, intent] of [["review", "Hmm, maybe", "UNCLEAR"], ["not_interested", "No thanks", "NOT_INTERESTED"], ["frustrated", "Stop spamming me or I report you", "HOSTILE"]] as const) {
      await resetDb();
      const t2 = await createTenant();
      const { contact, msg } = await thread(t2.orgId, body);
      setAiClient(fakeAi({ class: cls, confidence: 0.9, draft, language: "en" }));
      await runReplyIntelligence(t2.orgId, msg.id);
      const after = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
      expect(after.aiDraft).toBeNull();
      expect(after.intent).toBe(intent);
    }
    void t;
  });

  it("lets the customer discard a draft and correct the intent in one click", async () => {
    const t = await createTenant();
    const { contact, msg } = await thread(t.orgId, "Sounds interesting, send me the example");
    setAiClient(fakeAi({ class: "hot", confidence: 0.6, draft, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    await api().post(`/api/v1/inbox/${contact.id}/draft/discard`).set(t.auth).expect(200);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).aiDraft).toBeNull();
    await api().post(`/api/v1/inbox/${contact.id}/intent`).set(t.auth).send({ intent: "NOT_NOW" }).expect(200);
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).toMatchObject({ intent: "INTERESTED", customerIntent: "NOT_NOW" });
    await api().post(`/api/v1/inbox/${contact.id}/intent`).set(t.auth).send({ intent: "MADE_UP" }).expect(422);
  });
});
