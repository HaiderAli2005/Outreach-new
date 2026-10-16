import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, makePoolMailbox, resetDb, sendable, transport, GOOD_FIRST_TOUCH } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setVerifierFactory } from "../src/integrations/verifier.js";
import { pushQueue, verifyNew } from "../src/jobs/send.js";
import { retireNonResponders, reconcile } from "../src/jobs/blocklist.js";
import { followUpSweep } from "../src/jobs/replySync.js";
import { recordMessage } from "../src/domain/messages.js";

describe("job trigger endpoint", () => {
  beforeEach(resetDb);

  it("requires the jobs secret and runs a named job under a lock", async () => {
    await api().post("/api/v1/jobs/send/run").expect(401);
    await api().post("/api/v1/jobs/unknown/run").set("X-Jobs-Secret", "test-jobs-secret").expect(404);
    const res = await api().post("/api/v1/jobs/blocklist/run").set("X-Jobs-Secret", "test-jobs-secret");
    expect(res.status).toBe(200);
    expect(res.body.data.ran).toBe(true);
    const list = await api().get("/api/v1/jobs").set("X-Jobs-Secret", "test-jobs-secret");
    expect(list.body.data.map((j: { name: string }) => j.name)).toContain("first-touches");
    expect(list.body.data.map((j: { name: string }) => j.name)).not.toContain("auto-reply-dispatch");
  });
});

describe("send job", () => {
  beforeEach(resetDb);

  it("starts today's new people through the pool, pins each one and holds their sequence", async () => {
    const t = await createTenant();
    // 8 emails a day carry 2 new people a day: each person takes a 4-email sequence.
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, dailyBudgetDecicents: 320n } });
    await makePoolMailbox();
    const campaign = await makeCampaign(t.orgId);
    for (let i = 0; i < 3; i++) await makeContact(t.orgId, sendable(campaign.id, { personalization: GOOD_FIRST_TOUCH.replace("reports", ["reports", "briefs", "decks"][i]), messageSubject: ["Research content volume", "Client reporting systems", "Podcast research flow"][i] }));
    await makeContact(t.orgId, { campaignId: campaign.id, status: "NEW" });
    const r = await pushQueue(t.orgId, { ignoreWindow: true });
    expect(r.pushed).toBe(2);
    // Sent by us, plain text, with the unsubscribe link on the sending domain.
    expect(transport.sent).toHaveLength(2);
    const first = transport.sent[0].message;
    expect(first.text).toMatch(/steady stream/);
    // The first email has no link in it at all; unsubscribing works from the List-Unsubscribe header or a reply.
    expect(first.text).not.toMatch(/https?:\/\//);
    expect(first).not.toHaveProperty("html");
    const domain = first.from.address.split("@")[1];
    expect(first.headers["List-Unsubscribe"]).toContain(`https://${domain}/u/`);
    const contacted = await prisma.contact.findMany({ where: { organizationId: t.orgId, status: "CONTACTED" } });
    expect(contacted).toHaveLength(2);
    expect(contacted.every((c) => !!c.assignedMailboxId)).toBe(true);
    expect(await prisma.send.count({ where: { organizationId: t.orgId, status: "SENT", isFirstTouch: true } })).toBe(2);
    // Each sequence held 160 and its first email was charged 40 on acceptance.
    const held = await prisma.creditReservation.aggregate({ where: { organizationId: t.orgId, status: "OPEN" }, _sum: { remaining: true } });
    expect(held._sum.remaining).toBe(240n);
    expect((await pushQueue(t.orgId, { ignoreWindow: true })).reason).toBe("daily-cap-reached");
  });

  it("holds leads from unapproved weeks and from companies already in conversation", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, dailyBudgetDecicents: 2000n } });
    const campaign = await makeCampaign(t.orgId);
    const review = await prisma.weeklyBatch.create({ data: { organizationId: t.orgId, weekStart: new Date("2030-01-07"), status: "REVIEW" } });
    await makeContact(t.orgId, { campaignId: campaign.id, status: "PERSONALIZED", batchId: review.id, personalization: "x" });
    await makeContact(t.orgId, { email: "a@talking.com", emailNormalized: "a@talking.com", companyDomain: "talking.com", status: "REPLIED" });
    await makeContact(t.orgId, { email: "b@talking.com", emailNormalized: "b@talking.com", companyDomain: "talking.com", campaignId: campaign.id, status: "PERSONALIZED", personalization: "x" });
    const r = await pushQueue(t.orgId, { ignoreWindow: true });
    expect(r.pushed).toBe(0);
    expect(transport.sent).toHaveLength(0);
  });

  it("starts a third of the daily volume as new people, whatever is queued", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, dailyBudgetDecicents: 480n } });
    await makePoolMailbox();
    const campaign = await makeCampaign(t.orgId);
    for (let i = 0; i < 6; i++) await makeContact(t.orgId, sendable(campaign.id));
    expect((await pushQueue(t.orgId, { ignoreWindow: true })).pushed).toBe(3);
  });

  it("stops for the day when the balance can't cover another sequence", async () => {
    // $2.20: $2 is the reply reserve, so cold email can spend $0.20.
    const t = await createTenant({ balance: 2_200n });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, dailyBudgetDecicents: 2400n } });
    await makePoolMailbox();
    const campaign = await makeCampaign(t.orgId);
    for (let i = 0; i < 3; i++) await makeContact(t.orgId, sendable(campaign.id));
    const r = await pushQueue(t.orgId, { ignoreWindow: true });
    // $0.20 above the reserve holds one full sequence and then $0.04 for one more first email; then cold email pauses.
    expect(r).toMatchObject({ pushed: 2, reason: "cold_email_paused" });
    // The person who didn't go waits in the queue; nothing about them is rejected.
    expect(await prisma.contact.count({ where: { organizationId: t.orgId, status: "PERSONALIZED" } })).toBe(1);
  });

  it("verifies new leads and drops invalid ones", async () => {
    const t = await createTenant();
    setVerifierFactory(async () => async (email: string) =>
      email.startsWith("bad") ? { configured: true, ok: false, bad: true, transient: false, result: "invalid", quality: "bad" } : { configured: true, ok: true, bad: false, transient: false, result: "ok", quality: "good" },
    );
    const good = await makeContact(t.orgId, { email: "good@x.com", emailNormalized: "good@x.com" });
    const bad = await makeContact(t.orgId, { email: "bad@gmail.com", emailNormalized: "bad@gmail.com", companyDomain: null, domain: "gmail.com" });
    const r = await verifyNew(t.orgId);
    expect(r).toEqual({ good: 1, dropped: 1 });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: good.id } })).verifyResult).toBe("ok");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe("BOUNCED");
    expect(await prisma.blocklistEntry.count({ where: { entryType: "DOMAIN", value: "gmail.com" } })).toBe(0);
  });
});

describe("blocklist job", () => {
  beforeEach(resetDb);

  it("retires non-responders only once their last email actually went out", async () => {
    const t = await createTenant();
    const old = new Date(Date.now() - 20 * 86_400_000);
    const sent = await makeContact(t.orgId, { status: "CONTACTED", firstContactedAt: old, lastContactedAt: old });
    const queued = await makeContact(t.orgId, { status: "CONTACTED", firstContactedAt: old, lastContactedAt: old });
    for (const step of [1, 2, 3, 4]) await prisma.send.create({ data: { organizationId: t.orgId, contactId: sent.id, step, isFirstTouch: step === 1, status: "SENT", sentAt: old } });
    await prisma.send.create({ data: { organizationId: t.orgId, contactId: queued.id, step: 1, isFirstTouch: true, status: "SENT", sentAt: old } });
    const r = await retireNonResponders(t.orgId);
    expect(r).toMatchObject({ retired: 1, skippedUnsent: 1 });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("CONTACTED");
    expect(await prisma.blocklistEntry.count({ where: { entryType: "DOMAIN" } })).toBe(0);
  });

  it("reconciles contacts that match a hard rule but never lets a pacing rule override a reply", async () => {
    const t = await createTenant();
    const a = await makeContact(t.orgId, { email: "a@x.com", emailNormalized: "a@x.com" });
    const replied = await makeContact(t.orgId, { email: "b@x.com", emailNormalized: "b@x.com", status: "REPLIED", repliedAt: new Date() });
    await prisma.blocklistEntry.createMany({
      data: [
        { organizationId: t.orgId, entryType: "EMAIL", value: "a@x.com", reason: "UNSUBSCRIBED" },
        { organizationId: t.orgId, entryType: "EMAIL", value: "b@x.com", reason: "NO_RESPONSE" },
      ],
    });
    expect(await reconcile(t.orgId)).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: replied.id } })).status).toBe("REPLIED");
  });
});

describe("follow-up sweep", () => {
  beforeEach(resetDb);

  it("flags due away and not-now leads", async () => {
    const t = await createTenant();
    const c = await makeContact(t.orgId, { status: "REPLIED", replyClass: "away", followUpAt: new Date(Date.now() - 1000) });
    await recordMessage(prisma, { organizationId: t.orgId, contactId: c.id, direction: "INBOUND", body: "Out of office" });
    const r = await followUpSweep(t.orgId);
    expect(r.due).toBe(1);
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.replyUrgent).toBe(true);
    expect(after.followUpAt).toBeNull();
  });
});
