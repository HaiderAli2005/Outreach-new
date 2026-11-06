import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, makePoolMailbox, resetDb, sendable, transport } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setVerifierFactory } from "../src/integrations/verifier.js";
import { runPipeline, sendFirstTouch } from "../src/domain/sending/pipeline.js";
import { applyLateOutcome } from "../src/domain/sending/events.js";
import { pollMailboxes } from "../src/domain/sending/jobs.js";
import { recomputeCustomerHealth } from "../src/domain/sending/health.js";
import { unsubscribeUrl } from "../src/domain/sending/unsubscribe.js";
import { pushQueue } from "../src/jobs/send.js";
import { advanceWarmup, capForWarmupDay, evaluateDomainHealth, evaluateMailboxHealth, stepBack } from "../src/domain/pool/lifecycle.js";
import { checkReorderTrigger, ewmaSeries, predictedBurn, riskScore, shelfRunway } from "../src/domain/pool/metrics.js";
import { LEAD_TIME_WEEKS } from "../src/config/plans.js";
import { balanceOf, holdsOf } from "../src/domain/credits/index.js";

type SendStatus = "SENT" | "HARD_BOUNCE" | "SOFT_BOUNCE" | "COMPLAINT";

/** `n` real first touches for one customer from one mailbox, the first `bad` of them hard bounces. */
async function history(orgId: string, mailboxId: string, domainId: string, n: number, bad: number, badStatus: SendStatus = "HARD_BOUNCE") {
  const c = await makeContact(orgId, { status: "CONTACTED" });
  const t0 = Date.now() - n * 60_000;
  await prisma.send.createMany({
    data: Array.from({ length: n }, (_, i) => ({ organizationId: orgId, contactId: c.id, mailboxId, domainId, isFirstTouch: true, step: 1, status: i < bad ? badStatus : "SENT", sentAt: new Date(t0 + i * 60_000) })),
  });
}

const replyDelivery = () => {
  const sent: string[] = [];
  return { sent, deliverFn: async (ctx: { prospectId: string }) => void sent.push(ctx.prospectId) };
};

describe("shared pool sending", () => {
  beforeEach(resetDb);

  it("pins a person to one mailbox for good, enforced by the database", async () => {
    const t = await createTenant();
    const a = await makePoolMailbox();
    const b = await makePoolMailbox();
    const c = await makeContact(t.orgId);
    await prisma.contact.update({ where: { id: c.id }, data: { assignedMailboxId: a.id } });
    await expect(prisma.contact.update({ where: { id: c.id }, data: { assignedMailboxId: b.id } })).rejects.toThrow(/permanent/);
    await expect(prisma.contact.update({ where: { id: c.id }, data: { assignedMailboxId: null } })).rejects.toThrow();
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).assignedMailboxId).toBe(a.id);
  });

  it("picks a mailbox in the customer's region first, then the least loaded", async () => {
    const t = await createTenant();
    await prisma.organization.update({ where: { id: t.orgId }, data: { region: "uk" } });
    const global = await makePoolMailbox({ region: "global", cap: 30 });
    const uk = await makePoolMailbox({ region: "uk", cap: 30 });
    await makePoolMailbox({ region: "us", cap: 30 });
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id));
    const r = await sendFirstTouch(t.orgId, p.id, campaign.id);
    expect(r).toMatchObject({ ok: true, mailboxId: uk.id });
    void global;
  });

  it("takes no new people on a REPLIES_ONLY mailbox but still answers the people pinned to it", async () => {
    const t = await createTenant();
    const m = await makePoolMailbox({ status: "REPLIES_ONLY" });
    const campaign = await makeCampaign(t.orgId);
    const pinned = await makeContact(t.orgId, sendable(campaign.id, { assignedMailboxId: m.id }));
    expect(await sendFirstTouch(t.orgId, pinned.id, campaign.id)).toMatchObject({ ok: false, code: "MAILBOX_REPLIES_ONLY" });
    const fresh = await makeContact(t.orgId, sendable(campaign.id));
    expect(await sendFirstTouch(t.orgId, fresh.id, campaign.id)).toMatchObject({ ok: false, code: "NO_CAPACITY", wait: true });
    const talking = await makeContact(t.orgId, sendable(campaign.id, { status: "REPLIED", assignedMailboxId: m.id }));
    const d = replyDelivery();
    expect(await runPipeline({ customerId: t.orgId, campaignId: campaign.id, prospectId: talking.id, isFirstTouch: false, step: 0, deliverFn: d.deliverFn })).toMatchObject({ ok: true, mailboxId: m.id });
    expect(d.sent).toEqual([talking.id]);
  });

  it("keeps replies going from a mailbox on a DEGRADED domain", async () => {
    const t = await createTenant();
    const m = await makePoolMailbox({ status: "REPLIES_ONLY", domainStatus: "DEGRADED" });
    const campaign = await makeCampaign(t.orgId);
    const talking = await makeContact(t.orgId, sendable(campaign.id, { status: "REPLIED", assignedMailboxId: m.id }));
    const d = replyDelivery();
    expect((await runPipeline({ customerId: t.orgId, campaignId: campaign.id, prospectId: talking.id, isFirstTouch: false, step: 0, deliverFn: d.deliverFn })).ok).toBe(true);
    expect(d.sent).toHaveLength(1);
  });

  it("verifies before the first email and never sends to catch-all servers", async () => {
    const t = await createTenant();
    await makePoolMailbox();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id, { verifyResult: null, verifiedAt: null }));
    // No verifier: nothing goes out unverified, and the person waits.
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: false, code: "VERIFIER_UNAVAILABLE", wait: true });
    setVerifierFactory(async () => async () => ({ configured: true, ok: false, bad: false, transient: false, result: "catch_all", quality: "risky" }));
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: false, code: "CATCH_ALL" });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("REJECTED");
    expect(transport.sent).toHaveLength(0);
    // The hold and the mailbox slot went back.
    expect(await holdsOf(t.orgId)).toBe(0n);
    const stale = await makeContact(t.orgId, sendable(campaign.id, { verifiedAt: new Date(Date.now() - 8 * 86_400_000) }));
    await sendFirstTouch(t.orgId, stale.id, campaign.id);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: stale.id } })).verifyResult).toBe("catch_all");
  });

  it("refuses content without a subject or with link shorteners", async () => {
    const t = await createTenant();
    await makePoolMailbox();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id, { personalization: "See https://bit.ly/x" }));
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: false, code: "CONTENT_BLOCKED" });
    expect(await prisma.send.count({ where: { contactId: p.id, status: "REJECTED", rejectCode: "CONTENT_BLOCKED" } })).toBe(1);
  });

  it("has no per-customer cap: one customer may use every free slot in the pool", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, dailyBudgetDecicents: 12000n } });
    await makePoolMailbox({ cap: 20 });
    const campaign = await makeCampaign(t.orgId);
    for (let i = 0; i < 6; i++) await makeContact(t.orgId, sendable(campaign.id));
    expect(await pushQueue(t.orgId, { ignoreWindow: true })).toMatchObject({ pushed: 6 });
  });

  it("pauses new emails the moment bounces pass 4%, lets replies continue, and unpauses on re-verify", async () => {
    const t = await createTenant();
    const m = await makePoolMailbox();
    await history(t.orgId, m.id, m.sendingDomainId!, 100, 3);
    expect((await recomputeCustomerHealth(t.orgId)).status).toBe("WARNING");
    // Banner data: the customer sees their own bounce rate.
    const panel = await api().get("/api/v1/billing/credits").set(t.auth);
    expect(panel.body.data.health).toMatchObject({ status: "WARNING", label: "Watch", bounceRate: "3.0%" });
    // Two more bounces on recent sends: 5 of the last 100 is over 4%, so the pause lands on that event.
    const recent = await prisma.send.findMany({ where: { organizationId: t.orgId, status: "SENT" }, orderBy: { sentAt: "desc" }, take: 2 });
    await prisma.send.update({ where: { id: recent[1].id }, data: { status: "HARD_BOUNCE" } });
    await applyLateOutcome(recent[0], "HARD_BOUNCE", { code: "5.1.1", reason: "user unknown", parse: "dsn" });
    expect((await prisma.customerHealth.findUniqueOrThrow({ where: { organizationId: t.orgId } })).status).toBe("PAUSED");

    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id));
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: false, code: "CUSTOMER_PAUSED", wait: true });
    const talking = await makeContact(t.orgId, sendable(campaign.id, { status: "REPLIED", assignedMailboxId: m.id }));
    expect((await runPipeline({ customerId: t.orgId, campaignId: campaign.id, prospectId: talking.id, isFirstTouch: false, step: 0, deliverFn: replyDelivery().deliverFn })).ok).toBe(true);

    const re = await api().post("/api/v1/billing/reverify").set(t.auth).expect(200);
    expect(re.body.data.requeued).toBeGreaterThanOrEqual(1);
    const h = await prisma.customerHealth.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(h).toMatchObject({ status: "OK", unpausedById: t.userId });
    expect(h.unpauseReason).toMatch(/re-verified/);
  });

  it("does not count soft bounces against health", async () => {
    const t = await createTenant();
    const m = await makePoolMailbox();
    await history(t.orgId, m.id, m.sendingDomainId!, 100, 30, "SOFT_BOUNCE");
    expect((await recomputeCustomerHealth(t.orgId)).status).toBe("OK");
    const c = await makeContact(t.orgId);
    const s = await prisma.send.create({ data: { organizationId: t.orgId, contactId: c.id, mailboxId: m.id, isFirstTouch: true, step: 1, status: "SENT", sentAt: new Date() } });
    await applyLateOutcome(s, "SOFT_BOUNCE", { code: "4.2.2", reason: "mailbox full", parse: "dsn" });
    expect(await prisma.send.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: "SOFT_BOUNCE", retryCount: 0 });
    expect((await prisma.send.findUniqueOrThrow({ where: { id: s.id } })).nextRetryAt).not.toBeNull();
    expect((await recomputeCustomerHealth(t.orgId)).status).toBe("OK");
  });

  it("lets an operator lift a pause, with who and why on record", async () => {
    const t = await createTenant();
    await prisma.customerHealth.create({ data: { organizationId: t.orgId, status: "PAUSED", pausedAt: new Date() } });
    const admin = await createTenant();
    await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformAdmin: true } });
    await api().post(`/api/v1/admin/organizations/${t.orgId}/unpause`).set(admin.auth).send({ reason: "" }).expect(400);
    await api().post(`/api/v1/admin/organizations/${t.orgId}/unpause`).set(admin.auth).send({ reason: "list cleaned by hand" }).expect(200);
    expect(await prisma.customerHealth.findUniqueOrThrow({ where: { organizationId: t.orgId } })).toMatchObject({ status: "OK", unpausedById: admin.userId, unpauseReason: "list cleaned by hand" });
    expect(await prisma.systemLog.count({ where: { organizationId: t.orgId, message: { contains: "An operator" } } })).toBe(1);
  });

  it("unsubscribes from the link in the email at once, stops the sequence and returns the held money", async () => {
    const t = await createTenant();
    const m = await makePoolMailbox();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id));
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    expect(await holdsOf(t.orgId)).toBe(120n);
    const url = unsubscribeUrl(p.id, m.address.split("@")[1]);
    expect(url.startsWith(`https://${m.address.split("@")[1]}/u/`)).toBe(true);
    const path = new URL(url).pathname;
    // No login and no confirmation step: opening the link is enough.
    const page = await api().get(path).expect(200);
    expect(page.text).toContain("unsubscribed");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("UNSUBSCRIBED");
    expect(await holdsOf(t.orgId)).toBe(0n);
    expect(await prisma.globalSuppression.count()).toBe(1);
    await api().post(path).expect(200);
    await api().post(path.replace(/.$/, (ch) => (ch === "a" ? "b" : "a"))).expect(404);
  });

  it("charges on acceptance, and a human reply read over IMAP stops the sequence and frees the hold", async () => {
    const t = await createTenant();
    const m = await makePoolMailbox();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id));
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    expect(await prisma.creditLedger.count({ where: { organizationId: t.orgId, kind: "CHARGE" } })).toBe(1);
    const send = await prisma.send.findFirstOrThrow({ where: { contactId: p.id, step: 1 } });
    expect(send.status).toBe("SENT");
    const before = await balanceOf(t.orgId);
    transport.deliver(m.address, [`From: Lead <${p.email}>`, `To: ${m.address}`, `Subject: Re: ${send.subject}`, `Message-ID: <r1@company.com>`, `In-Reply-To: ${send.messageId}`, `Date: ${new Date().toUTCString()}`, "", "Sounds good, tell me more."].join("\n"));
    await pollMailboxes();
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("REPLIED");
    expect(await holdsOf(t.orgId)).toBe(0n);
    expect(await balanceOf(t.orgId)).toBe(before);
  });
});

describe("pool lifecycle", () => {
  beforeEach(resetDb);

  it("ramps warmup 5/10/20/30, holds over 3% and steps back over 5%", async () => {
    expect([1, 7, 8, 14, 15, 21, 22, 28].map(capForWarmupDay)).toEqual([5, 5, 10, 10, 20, 20, 30, 30]);
    expect([3, 10, 17, 25].map(stepBack)).toEqual([1, 1, 8, 15]);
    const t = await createTenant();
    const fine = await makePoolMailbox({ status: "WARMING" });
    const held = await makePoolMailbox({ status: "WARMING" });
    const bad = await makePoolMailbox({ status: "WARMING" });
    for (const m of [fine, held, bad]) await prisma.mailbox.update({ where: { id: m.id }, data: { warmupDay: 17 } });
    await history(t.orgId, fine.id, fine.sendingDomainId!, 50, 0);
    await history(t.orgId, held.id, held.sendingDomainId!, 50, 2); // 4%
    await history(t.orgId, bad.id, bad.sendingDomainId!, 50, 3); // 6%
    const r = await advanceWarmup();
    expect(r).toMatchObject({ warmupAdvanced: 1, warmupHeld: 1, warmupSteppedBack: 1 });
    const day = async (id: string) => (await prisma.mailbox.findUniqueOrThrow({ where: { id } })).warmupDay;
    expect([await day(fine.id), await day(held.id), await day(bad.id)]).toEqual([18, 17, 8]);
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: bad.id } })).sendCapToday).toBe(10);
    // Once a day only.
    expect((await advanceWarmup()).warmupAdvanced).toBe(0);
  });

  it("moves a mailbox to REPLIES_ONLY over 5% of its last 50, and activates a warmed one under 2%", async () => {
    const t = await createTenant();
    const sick = await makePoolMailbox();
    const warmed = await makePoolMailbox({ status: "WARMING" });
    await prisma.mailbox.update({ where: { id: warmed.id }, data: { warmupDay: 29 } });
    await history(t.orgId, sick.id, sick.sendingDomainId!, 50, 3);
    await history(t.orgId, warmed.id, warmed.sendingDomainId!, 50, 0);
    expect(await evaluateMailboxHealth()).toMatchObject({ mailboxesRepliesOnly: 1, mailboxesActivated: 1 });
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: sick.id } })).status).toBe("REPLIES_ONLY");
    expect(await prisma.mailbox.findUniqueOrThrow({ where: { id: warmed.id } })).toMatchObject({ status: "ACTIVE", sendCapToday: 30 });
  });

  it("degrades a domain over 5% of its last 200 sends and turns its mailboxes to replies only", async () => {
    const t = await createTenant();
    const a = await makePoolMailbox();
    const b = await makePoolMailbox({ domainId: a.sendingDomainId! });
    await history(t.orgId, a.id, a.sendingDomainId!, 200, 11);
    expect((await evaluateDomainHealth()).domainsDegraded).toBe(1);
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: a.sendingDomainId! } })).status).toBe("DEGRADED");
    expect((await prisma.mailbox.findMany({ where: { id: { in: [a.id, b.id] } } })).map((m) => m.status)).toEqual(["REPLIES_ONLY", "REPLIES_ONLY"]);
  });

  it("works out EWMA burn, risk, predicted burn and runway exactly as the hand calculation", () => {
    // Weeks 1-4: running mean. Week 5 on: 0.3 x week + 0.7 x previous.
    const s = ewmaSeries([2, 4, 0, 2, 6, 1]);
    expect(s.slice(0, 4)).toEqual([2, 3, 2, 2]);
    expect(s[4]).toBeCloseTo(0.3 * 6 + 0.7 * 2, 10); // 3.2
    expect(s[5]).toBeCloseTo(0.3 * 1 + 0.7 * 3.2, 10); // 2.54
    // risk = 0.5 clamp(br7/0.05) + 0.3 clamp((br7-br30)/0.02) + 0.2 clamp(cr7/0.003)
    const r = riskScore({ sends7: 100, bad7: 3, complaints7: 0, sends30: 400, bad30: 6 });
    expect(r.risk).toBeCloseTo(0.5 * 0.6 + 0.3 * 0.75 + 0, 10); // 0.525, WATCH
    expect(r.band).toBe("WATCH");
    expect(riskScore({ sends7: 50, bad7: 5, complaints7: 1, sends30: 199, bad30: 5 }).band).toBe("INSUFFICIENT_DATA");
    // 2 at risk of 20 active, EWMA 1.5: 2 + 1.5 x 4.3 x 18/20 = 7.805
    expect(predictedBurn(2, 20, 1.5).total).toBeCloseTo(7.805, 10);
    // 6 warm on the shelf at EWMA 1.5 is 4 weeks: under the 7-week lead time (14 aging + 29 warmup days), buy ceil(3 x 1.5) = 5.
    expect(LEAD_TIME_WEEKS).toBe(7);
    expect(shelfRunway(6, 1.5)).toMatchObject({ runwayWeeks: 4, reorder: true, domainsToBuy: 5, reorderBecause: { burnReplacement: 5, driver: "burnReplacement" } });
    expect(shelfRunway(5, 0)).toMatchObject({ runwayWeeks: 50, reorder: false, domainsToBuy: 0 });
  });

  it("reminds an operator to restock, with names to buy, and never buys by itself", async () => {
    await prisma.sendingDomain.create({ data: { organizationId: null, name: "old-neutral.com", status: "DEGRADED", priceCents: 1200, region: "global", createdAt: new Date(Date.now() - 60 * 86_400_000), degradedAt: new Date(Date.now() - 3 * 86_400_000) } });
    await checkReorderTrigger();
    const pending = await prisma.poolReorder.findMany();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("PENDING");
    const admin = await createTenant();
    await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformAdmin: true } });
    const view = await api().get("/api/v1/admin/pool").set(admin.auth).expect(200);
    const reminder = view.body.data.reorders.find((r: { status: string }) => r.status === "PENDING");
    expect(reminder.suggestions.length).toBeGreaterThanOrEqual(3);
    expect(reminder.suggestions).not.toContain("old-neutral.com");
    await api().post(`/api/v1/admin/pool/reorders/${pending[0].id}`).set(admin.auth).send({ approve: false, note: "not yet" }).expect(200);
    expect((await prisma.poolReorder.findUniqueOrThrow({ where: { id: pending[0].id } })).status).toBe("DISMISSED");
  });
});
