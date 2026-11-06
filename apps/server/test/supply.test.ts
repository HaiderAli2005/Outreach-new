import { beforeEach, describe, expect, it } from "vitest";
import { createTenant, makeCampaign, makeContact, resetDb, sendable } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { peopleSupply, reviewsWeekly, SUPPLY_DAYS } from "../src/domain/supply.js";
import { sendingOutlook } from "../src/domain/sending/outlook.js";
import { emailsPerDay } from "../src/domain/budget.js";
import { newPeopleBounds } from "../src/config/plans.js";

/**
 * Finding keeps pace with sending: a workspace that launched midweek with "Weekly review" on found people only on
 * Sunday, emailed everyone it had by day three, and then sent three emails a day on a 100-a-day budget.
 */

describe("people supply", () => {
  beforeEach(resetDb);

  it("a weekly list holds people back only when someone reviews it", () => {
    const base = { weeklyBatchMode: true, autoApproveBatches: false, launchMode: "APPROVE_FIRST_BATCH" as const, firstBatchApprovedAt: new Date() };
    expect(reviewsWeekly(base)).toBe(true);
    // Approved automatically: nothing to wait for, so finding and sending go day by day.
    expect(reviewsWeekly({ ...base, autoApproveBatches: true })).toBe(false);
    expect(reviewsWeekly({ ...base, weeklyBatchMode: false })).toBe(false);
    // Before the first 20 are approved nothing is approved automatically yet, so the weekly list still applies.
    expect(reviewsWeekly({ ...base, autoApproveBatches: true, firstBatchApprovedAt: null })).toBe(true);
  });

  it("counts who can still get a first email against two days of new-people slots, and says when it runs low", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true, leadSourcing: "AUTOMATIC", dailyBudgetDecicents: 2000n } });
    const campaign = await makeCampaign(t.orgId);
    for (let i = 0; i < 3; i++) await makeContact(t.orgId, sendable(campaign.id));
    // Already emailed, a known-bad address, and a stopped sequence never count.
    await makeContact(t.orgId, sendable(campaign.id, { status: "CONTACTED", lastContactedAt: new Date() }));
    await makeContact(t.orgId, sendable(campaign.id, { verifyResult: "invalid" }));
    await makeContact(t.orgId, sendable(campaign.id, { sequenceStoppedAt: new Date() }));

    const s = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    const perDay = newPeopleBounds(emailsPerDay(s)).max;
    const supply = await peopleSupply(t.orgId, s);
    expect(supply).toEqual({ ready: 3, need: perDay * SUPPLY_DAYS, short: perDay * SUPPLY_DAYS - 3 });

    const o = await sendingOutlook(t.orgId);
    expect(o.supply).toEqual({ ready: 3, need: perDay * SUPPLY_DAYS, low: true, finding: true });

    // A full list is not low.
    for (let i = 0; i < perDay; i++) await makeContact(t.orgId, sendable(campaign.id));
    expect((await sendingOutlook(t.orgId)).supply.low).toBe(false);
  });
});
