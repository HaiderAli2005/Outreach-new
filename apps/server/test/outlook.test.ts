import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, makePoolMailbox, resetDb, sendable, transport } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { sendingOutlook } from "../src/domain/sending/outlook.js";
import { windowState } from "../src/domain/sending/schedule.js";

/** The customer can always see when the next email goes out, or why nothing is going out. */

const H = 3_600_000;

describe("sending outlook", () => {
  beforeEach(resetDb);

  async function workspace() {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true, sendDays: [1, 2, 3, 4, 5, 6, 7], sendingWindowStart: "00:00", sendingWindowEnd: "23:59", prospectTimezone: "UTC" } });
    return { t, campaign: await makeCampaign(t.orgId) };
  }

  it("gives the soonest scheduled email and how many follow in the next 24 hours", async () => {
    const { t, campaign } = await workspace();
    const now = new Date();
    for (const h of [5, 1, 3]) await makeContact(t.orgId, sendable(campaign.id, { nextTouchAt: new Date(now.getTime() + h * H), timezone: "America/New_York" }));
    await makeContact(t.orgId, sendable(campaign.id, { nextTouchAt: new Date(now.getTime() + 40 * H) }));
    const o = await sendingOutlook(t.orgId, now);
    expect(o.next?.getTime()).toBe(now.getTime() + H);
    expect(o.nextProspectTz).toBe("America/New_York");
    expect(o.inDay).toBe(3);
    expect(o.lastInDay?.getTime()).toBe(now.getTime() + 5 * H);
    expect(o.reason).toBeNull();
    // On the cockpit too.
    const c = (await api().get("/api/v1/dashboard/cockpit").set(t.auth).expect(200)).body.data;
    expect(c.outlook).toMatchObject({ inDay: 3, reason: null });
  });

  it("says why nothing is scheduled: autopilot off, approval, nothing ready, outside the window", async () => {
    const { t, campaign } = await workspace();
    expect((await sendingOutlook(t.orgId)).reason).toBe("nothing-ready");
    await makeContact(t.orgId, sendable(campaign.id, { approvedAt: null, approvalSource: null }));
    expect((await sendingOutlook(t.orgId)).reason).toBe("awaiting-approval");
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: false } });
    expect((await sendingOutlook(t.orgId)).reason).toBe("autopilot-off");
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true, sendDays: [1] } });
    await makeContact(t.orgId, sendable(campaign.id));
    const sunday = new Date("2026-10-18T12:00:00Z");
    const o = await sendingOutlook(t.orgId, sunday);
    expect(o.reason).toBe("outside-window");
    expect(o.window).toMatchObject({ open: false, tz: "UTC" });
    expect(o.window.opensAt?.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });

  it("reads the window in the prospect's zone", () => {
    const w = { tz: "America/New_York", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
    // Wednesday 14 Oct 2026, 18:40 in New York: closed until 9am Thursday.
    const evening = windowState(w, new Date("2026-10-14T22:40:00Z"));
    expect(evening).toMatchObject({ open: false, closesAt: null });
    expect(evening.opensAt?.toISOString()).toBe("2026-10-15T13:00:00.000Z");
    const midday = windowState(w, new Date("2026-10-14T16:00:00Z"));
    expect(midday.open).toBe(true);
    expect(midday.closesAt?.toISOString()).toBe("2026-10-14T21:00:00.000Z");
    // Friday evening opens Monday.
    expect(windowState(w, new Date("2026-10-16T23:00:00Z")).opensAt?.toISOString()).toBe("2026-10-19T13:00:00.000Z");
  });

  it("lists leads soonest-scheduled first, with each person's own zone", async () => {
    const { t, campaign } = await workspace();
    const now = Date.now();
    const late = await makeContact(t.orgId, sendable(campaign.id, { nextTouchAt: new Date(now + 9 * H), country: "Germany" }));
    const soon = await makeContact(t.orgId, sendable(campaign.id, { nextTouchAt: new Date(now + H), timezone: "America/Chicago" }));
    const none = await makeContact(t.orgId, sendable(campaign.id));
    const rows = (await api().get("/api/v1/contacts?sort=scheduled").set(t.auth).expect(200)).body.data;
    expect(rows.map((r: { id: string }) => r.id)).toEqual([soon.id, late.id, none.id]);
    expect(rows[0].prospectTz).toBe("America/Chicago");
    expect(rows[1].prospectTz).toBe("Europe/Berlin");
    await api().get("/api/v1/contacts?sort=whatever").set(t.auth).expect(400);
  });
});

describe("admin send now", () => {
  beforeEach(resetDb);

  it("is for platform admins only, ignores the window, and logs who ran it and how many went out", async () => {
    await makePoolMailbox();
    const t = await createTenant();
    // A window that is never open: only the admin path can send.
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true, sendDays: [1], sendingWindowStart: "03:00", sendingWindowEnd: "03:01" } });
    const campaign = await makeCampaign(t.orgId);
    await makeContact(t.orgId, sendable(campaign.id));
    await api().post(`/api/v1/admin/organizations/${t.orgId}/send-now`).set(t.auth).expect(403);
    expect(transport.sent).toHaveLength(0);

    await prisma.user.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    const r = (await api().post(`/api/v1/admin/organizations/${t.orgId}/send-now`).set(t.auth).expect(200)).body.data;
    expect(r.pushed).toBe(1);
    expect(transport.sent).toHaveLength(1);
    const log = await prisma.systemLog.findFirstOrThrow({ where: { organizationId: t.orgId, source: "admin" } });
    expect(log.message).toBe(`Send now by ${t.email}: 1 sent.`);
    expect(log.meta).toMatchObject({ userId: t.userId, pushed: 1 });
  });
});
