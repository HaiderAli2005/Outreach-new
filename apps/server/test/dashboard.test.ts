import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeCapacity, makeContact, resetDb, sendable } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

/** The cockpit after launch: an honest state while the first people wait for approval, and what was sent, delivered, answered and spent. */

const DAY = 86_400_000;

async function launched(opts: { approved?: boolean } = {}) {
  const t = await createTenant({ approved: opts.approved ?? false });
  await makeCapacity(500);
  await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true } });
  const campaign = await makeCampaign(t.orgId);
  await prisma.onboarding.create({
    data: {
      organizationId: t.orgId,
      domain: "northwind.io",
      brand: "Northwind",
      icp: {},
      launchedAt: new Date(),
      firstRunStartedAt: new Date(),
      firstRunFinishedAt: new Date(),
      firstRunResult: { ok: true, reason: null, message: null, found: 0, verified: 0, written: 0 },
      groups: [
        { id: "g1", name: "Founders", on: true },
        { id: "g2", name: "Heads of marketing", on: false },
      ],
    },
  });
  return { t, campaign };
}

const cockpit = async (auth: Record<string, string>) => (await api().get("/api/v1/dashboard/cockpit").set(auth).expect(200)).body.data;

describe("cockpit before the first emails", () => {
  beforeEach(resetDb);

  it("never says Sending while the first people wait for approval, and points at the approval", async () => {
    const { t, campaign } = await launched();
    let c = await cockpit(t.auth);
    expect(c.engine.state).toBe("preparing");
    // The search finished and nobody is written or being written: a dead end, said plainly, not "a few minutes".
    expect(c.needsYou.firstBatch).toMatchObject({ ready: 0, needed: 20, finding: false });
    expect(c.needsYou.firstBatch.problem).toMatch(/nobody it found fits/);

    await makeContact(t.orgId, { ...sendable(campaign.id), audienceId: "g1", personalizationStatus: "done", approvedAt: null, approvalSource: null });
    await makeContact(t.orgId, { ...sendable(campaign.id), audienceId: "g1", personalizationStatus: "done", approvedAt: null, approvalSource: null });
    c = await cockpit(t.auth);
    expect(c.engine.state).toBe("approval");
    expect(c.needsYou.firstBatch).toMatchObject({ ready: 2, needed: 20 });
    expect(c.progress.written).toBe(2);

    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { firstBatchApprovedAt: new Date() } });
    c = await cockpit(t.auth);
    expect(c.needsYou.firstBatch).toBeNull();
    expect(c.engine.state).not.toBe("approval");
    // Found people after the first batch still wait for a person.
    expect(c.needsYou.awaitingApproval).toBe(2);
  });

  it("doesn't ask for approval at 1 of 20 while the first search is still writing; asks once it's done", async () => {
    const { t, campaign } = await launched();
    await prisma.onboarding.update({ where: { organizationId: t.orgId }, data: { firstRunFinishedAt: null } });
    await makeContact(t.orgId, { ...sendable(campaign.id), audienceId: "g1", personalizationStatus: "done", approvedAt: null, approvalSource: null });
    let c = await cockpit(t.auth);
    expect(c.needsYou.firstBatch).toMatchObject({ ready: 1, needed: 20, finding: true });
    expect(c.engine.state).toBe("preparing");

    await prisma.onboarding.update({ where: { organizationId: t.orgId }, data: { firstRunFinishedAt: new Date() } });
    c = await cockpit(t.auth);
    expect(c.needsYou.firstBatch).toMatchObject({ ready: 1, finding: false });
    expect(c.engine.state).toBe("approval");
  });

  it("says why the first search stopped", async () => {
    const { t } = await launched();
    await prisma.onboarding.update({ where: { organizationId: t.orgId }, data: { firstRunResult: { ok: false, reason: "nobody-found", message: "No one matched your audiences.", found: 0, verified: 0, written: 0 } } });
    expect((await cockpit(t.auth)).needsYou.firstBatch.problem).toBe("No one matched your audiences.");
  });
});

describe("performance", () => {
  beforeEach(resetDb);

  it("counts sent, first emails and follow-ups, delivered, bounced, hot leads and spend, against the period before", async () => {
    const { t, campaign } = await launched({ approved: true });
    const a = await makeContact(t.orgId, { ...sendable(campaign.id), status: "REPLIED", audienceId: "g1", repliedAt: new Date(), intent: "INTERESTED" });
    const b = await makeContact(t.orgId, { ...sendable(campaign.id), status: "CONTACTED", audienceId: "g1" });
    const old = await makeContact(t.orgId, { ...sendable(campaign.id), status: "CONTACTED", audienceId: "g1" });
    const send = (contactId: string, at: Date, status: "DELIVERED" | "HARD_BOUNCE" | "REJECTED", first = true) =>
      prisma.send.create({ data: { organizationId: t.orgId, campaignId: campaign.id, contactId, isFirstTouch: first, step: first ? 1 : 2, status, priceCharged: status === "REJECTED" ? 0n : 40n, sentAt: at } });
    await send(a.id, new Date(Date.now() - DAY), "DELIVERED");
    await send(a.id, new Date(), "DELIVERED", false);
    await send(b.id, new Date(), "HARD_BOUNCE");
    await send(b.id, new Date(), "REJECTED");
    await send(old.id, new Date(Date.now() - 10 * DAY), "DELIVERED");
    // An answer to someone who replied: paid for, but not outreach.
    await prisma.send.create({ data: { organizationId: t.orgId, campaignId: campaign.id, contactId: a.id, isFirstTouch: false, step: 0, status: "DELIVERED", priceCharged: 40n } });

    const p = (await api().get("/api/v1/dashboard/performance?days=7").set(t.auth).expect(200)).body.data;
    expect(p.days).toBe(7);
    expect(p.series).toHaveLength(7);
    expect(p.totals).toMatchObject({ sent: 3, firstEmails: 2, followUps: 1, delivered: 2, bounced: 1, replies: 1, hot: 1, spentDecicents: 160, spent: "$0.16", pricePerEmail: "$0.04" });
    expect(p.previous).toMatchObject({ sent: 1, spentDecicents: 40 });
    expect(p.series.reduce((n: number, d: { sent: number }) => n + d.sent, 0)).toBe(3);

    const founders = p.audiences.find((x: { id: string }) => x.id === "g1");
    expect(founders).toMatchObject({ name: "Founders", sent: 3, replies: 1, hot: 1, replyRate: 50, spent: "$0.16", costPerLead: "$0.16" });
    expect(p.audiences.find((x: { id: string }) => x.id === "g2")).toMatchObject({ state: "off", sent: 0, costPerLead: null });

    const month = (await api().get("/api/v1/dashboard/performance?days=30").set(t.auth).expect(200)).body.data;
    expect(month.series).toHaveLength(30);
    expect(month.totals.sent).toBe(4);
  });

  it("shows today, all time, and one campaign at a time", async () => {
    const { t, campaign } = await launched({ approved: true });
    const a = await makeContact(t.orgId, { ...sendable(campaign.id), status: "CONTACTED", audienceId: "g1" });
    const b = await makeContact(t.orgId, { ...sendable(campaign.id), status: "CONTACTED", audienceId: "g2" });
    const send = (contactId: string, at: Date) => prisma.send.create({ data: { organizationId: t.orgId, campaignId: campaign.id, contactId, isFirstTouch: true, step: 1, status: "DELIVERED", priceCharged: 40n, sentAt: at } });
    await send(a.id, new Date());
    await send(b.id, new Date());
    await send(a.id, new Date(Date.now() - 40 * DAY));

    const get = async (q: string) => (await api().get(`/api/v1/dashboard/performance?${q}`).set(t.auth).expect(200)).body.data;
    const today = await get("period=today");
    expect(today).toMatchObject({ period: "today", days: 1 });
    expect(today.series).toHaveLength(1);
    expect(today.totals.sent).toBe(2);
    // All time runs from the first email ever sent and has nothing before it to compare with.
    const all = await get("period=all");
    expect(all.days).toBeGreaterThanOrEqual(40);
    expect(all.totals.sent).toBe(3);
    expect(all.previous.sent).toBe(0);
    // One audience at a time; the campaign list itself is never narrowed, so the picker always shows every choice.
    const one = await get("period=all&campaign=g1");
    expect(one.totals.sent).toBe(2);
    expect(one.campaign).toBe("g1");
    expect(one.audiences.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(["g1", "g2"]));
  });

  it("is per workspace", async () => {
    const { t, campaign } = await launched({ approved: true });
    const other = await createTenant();
    const a = await makeContact(t.orgId, { ...sendable(campaign.id), status: "CONTACTED" });
    await prisma.send.create({ data: { organizationId: t.orgId, contactId: a.id, isFirstTouch: true, status: "DELIVERED", priceCharged: 40n } });
    const p = (await api().get("/api/v1/dashboard/performance").set(other.auth).expect(200)).body.data;
    expect(p.totals.sent).toBe(0);
    expect(p.audiences).toEqual([]);
  });
});

describe("campaign workspace", () => {
  beforeEach(resetDb);

  it("lists campaigns for the sidebar and opens one with its brief, leads, progress and dated story", async () => {
    const { t, campaign } = await launched({ approved: true });
    await prisma.company.create({ data: { organizationId: t.orgId, domain: "acme.io", name: "Acme", employees: 30, country: "Sweden" } });
    const a = await makeContact(t.orgId, { ...sendable(campaign.id), status: "REPLIED", audienceId: "g1", companyDomain: "acme.io", country: "Sweden", verifyResult: "ok", repliedAt: new Date(), firstContactedAt: new Date(), intent: "INTERESTED", fullName: "Ada Lind" });
    await makeContact(t.orgId, { ...sendable(campaign.id), status: "CONTACTED", audienceId: "g1", companyDomain: "acme.io", verifyResult: "invalid" });
    await makeContact(t.orgId, { ...sendable(campaign.id), audienceId: "g2" });
    await prisma.send.create({ data: { organizationId: t.orgId, campaignId: campaign.id, contactId: a.id, isFirstTouch: true, step: 1, status: "DELIVERED", priceCharged: 40n, sentAt: new Date() } });

    const nav = (await api().get("/api/v1/dashboard/campaigns").set(t.auth).expect(200)).body.data;
    expect(nav).toEqual([expect.objectContaining({ id: "g1", name: "Founders", state: "on" }), expect.objectContaining({ id: "g2", state: "off" })]);

    const w = (await api().get("/api/v1/dashboard/campaigns/g1").set(t.auth).expect(200)).body.data;
    expect(w).toMatchObject({ id: "g1", name: "Founders", on: true });
    expect(w.progress).toMatchObject({ found: 2, canEmail: 1, noAddress: 1, checking: 0, emailed: 1, replied: 1, hot: 1 });
    expect(w.progress.steps[0]).toEqual({ step: 1, sent: 1 });
    expect(w.breakdown.sizes).toEqual([["11–50", 2]]);
    expect(w.companies[0]).toMatchObject({ domain: "acme.io", name: "Acme", people: 2, employees: 30 });
    expect(w.people.find((p: { id: string }) => p.id === a.id)).toMatchObject({ email: "ok" });
    expect(w.timeline.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["found", "sent", "reply", "launch"]));
    expect(w.timeline.find((e: { kind: string }) => e.kind === "reply").text).toMatch(/^Ada Lind at .+ replied$/);

    await api().get("/api/v1/dashboard/campaigns/nope").set(t.auth).expect(404);
  });
});

describe("when sending pauses", () => {
  it("names the first sending day the balance no longer covers, skipping days that don't send", async () => {
    const { runsOutOn } = await import("../src/modules/dashboard/dashboard.service.js");
    const monday = new Date("2026-11-02T10:00:00Z");
    const weekdays = [1, 2, 3, 4, 5];
    expect(runsOutOn(0, "UTC", weekdays, monday)).toBe("today");
    expect(runsOutOn(1, "UTC", weekdays, monday)).toBe("tomorrow");
    expect(runsOutOn(3, "UTC", weekdays, monday)).toBe("Thursday");
    // Friday covered, the weekend doesn't send: it pauses on Monday the 9th.
    expect(runsOutOn(5, "UTC", weekdays, monday)).toBe("Mon, Nov 9");
    expect(runsOutOn(null, "UTC", weekdays, monday)).toBeNull();
  });
});
