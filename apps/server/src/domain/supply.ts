import type { OrgSettings } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { SEND_FLOOR } from "./scoring.js";
import { autoApproves } from "./settings.js";
import { dailyPlan } from "./sending/dailyPlan.js";

/**
 * Whether there are enough people waiting for their first email. Aperture finds the people itself, so finding has to
 * keep pace with sending: a list that runs dry halfway through the week leaves a $4-a-day budget sending three emails
 * a day. The rule is the one cold email tools leave to the customer ("keep leads loaded"), done for them: always hold
 * about two days of new-people slots, so a slow search or a day of rejects never empties the day.
 */
export const SUPPLY_DAYS = 2;

/** People who can still get a first email: found, not stopped, not emailed, a fit, and an address that isn't known bad. */
export function readyWhere(orgId: string) {
  return {
    organizationId: orgId,
    status: { in: ["NEW" as const, "PERSONALIZED" as const, "QUEUED" as const] },
    sequenceStoppedAt: null,
    lastContactedAt: null,
    fitScore: { gte: SEND_FLOOR },
    OR: [{ verifyResult: null }, { verifyResult: "ok" }],
  };
}

export interface Supply {
  /** People waiting for a first email. */
  ready: number;
  /** What the next SUPPLY_DAYS of new-people slots take. */
  need: number;
  /** How many more to find now to get back to `need`. */
  short: number;
}

/** Tomorrow's new-people share is the steady one (today's may be partly spent), so the need is counted from it. */
export async function peopleSupply(orgId: string, s: Pick<OrgSettings, "timezone" | "dailyBudgetDecicents">, now = new Date()): Promise<Supply> {
  const [ready, plan] = await Promise.all([prisma.contact.count({ where: readyWhere(orgId) }), dailyPlan(orgId, s, now, 1)]);
  const need = plan.newAllowed * SUPPLY_DAYS;
  return { ready, need, short: Math.max(0, need - ready) };
}

/**
 * A weekly list only means something when a person reviews it. With new people approved automatically there is
 * nothing to wait for, so finding and sending run day by day whatever "Weekly review" says.
 */
export function reviewsWeekly(s: Pick<OrgSettings, "weeklyBatchMode" | "autoApproveBatches" | "launchMode" | "firstBatchApprovedAt">): boolean {
  return s.weeklyBatchMode && !autoApproves(s);
}
