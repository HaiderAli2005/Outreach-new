import { beforeEach, describe, expect, it } from "vitest";
import { createTenant, makeCampaign, makeContact, resetDb, sendable } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { unsupportedClaims } from "../src/domain/emailRules.js";
import { rewriteAfterBlock, MAX_REWRITES_AFTER_BLOCK } from "../src/domain/sending/pipeline.js";
import { restoreBlockedForRewrite } from "../src/jobs/send.js";

describe("the fact check before sending", () => {
  beforeEach(resetDb);

  it("accepts a compound whose parts are on record, and the customer's own approved words", () => {
    const corpus = { prospect: "Divine Cashmere\napparel", customer: "Rankhouse\nAI SEO agent for websites" };
    expect(unsupportedClaims("Our tool is fast. We run an AI-driven review of every page.", corpus)).toEqual([]);
    expect(unsupportedClaims("We worked with Harrods on this.", corpus)).toEqual(["Harrods"]);
    const withSequence = { ...corpus, customer: `${corpus.customer}\nOur Pagekeeper runs every week.` };
    expect(unsupportedClaims("Each week our Pagekeeper checks it.", withSequence)).toEqual([]);
  });

  it("sends a blocked first email back to be written again, at most twice, then sets the person aside", async () => {
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const c = await makeContact(t.orgId, sendable(campaign.id));
    const block = () => prisma.send.create({ data: { organizationId: t.orgId, contactId: c.id, isFirstTouch: true, step: 1, status: "REJECTED", rejectCode: "CONTENT_BLOCKED", rejectReason: "Content blocked: unsupported claim (AI-driven).", resolvedAt: new Date() } });
    for (let i = 0; i < MAX_REWRITES_AFTER_BLOCK; i++) {
      await block();
      expect(await rewriteAfterBlock(c.id)).toBe(true);
      expect(await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "NEW", personalizationStatus: "retry_1", personalization: null });
    }
    await block();
    await block();
    expect(await rewriteAfterBlock(c.id)).toBe(false);
  });

  it("restores people dropped by a block before rewrites existed, if they were never emailed", async () => {
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const dropped = await makeContact(t.orgId, sendable(campaign.id, { status: "REJECTED" }));
    const emailed = await makeContact(t.orgId, sendable(campaign.id, { status: "REJECTED", firstContactedAt: new Date() }));
    for (const c of [dropped, emailed]) await prisma.send.create({ data: { organizationId: t.orgId, contactId: c.id, isFirstTouch: true, step: 1, status: "REJECTED", rejectCode: "CONTENT_BLOCKED", rejectReason: "x", resolvedAt: new Date() } });
    expect(await restoreBlockedForRewrite(t.orgId)).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: dropped.id } })).status).toBe("NEW");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: emailed.id } })).status).toBe("REJECTED");
  });
});
