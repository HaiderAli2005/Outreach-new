import { prisma } from "../../lib/prisma.js";
import { addDays, dateKeyInTz, tzMidnightUtc } from "../../lib/time.js";
import { newPeopleBounds } from "../../config/plans.js";
import { emailsPerDay } from "../budget.js";
import type { OrgSettings } from "@prisma/client";

/**
 * The day's split of the daily budget between follow-ups and new people. The pattern the main cold email
 * platforms use (follow-ups first, new people fill the rest, a cap on new people), with a floor:
 *
 *   1. Follow-ups first. Every follow-up due today (and any that waited) gets a place, up to the day's emails less
 *      the floor for new people.
 *   2. New people fill everything that is left, never less than NEW_SHARE_MIN of the day.
 *   3. Follow-ups that do not fit wait for the next sending day (day 4 instead of day 3), so new people never stop.
 *
 * The customer chooses only the budget. The money guard still caps the total, so this only decides who goes first.
 */
export interface DailyPlan {
  /** Emails the budget allows today. */
  emails: number;
  /** Follow-ups already sent today, and those still due before the day ends (including any waiting from before). */
  followupsSent: number;
  followupsDue: number;
  /** The most follow-ups that may go today; the rest wait a day. */
  followupsAllowed: number;
  /** New people (first emails) allowed today, and how many have gone. */
  newAllowed: number;
  firstsSent: number;
}

type PlanSettings = Pick<OrgSettings, "timezone" | "dailyBudgetDecicents">;

/** `dayOffset` 1 plans tomorrow: nothing has gone yet, and today's unsent follow-ups are counted as waiting. */
export async function dailyPlan(orgId: string, settings: PlanSettings, now = new Date(), dayOffset = 0): Promise<DailyPlan> {
  const tz = settings.timezone;
  const dayKey = addDays(dateKeyInTz(tz, now), dayOffset);
  const start = tzMidnightUtc(dayKey, tz);
  const end = tzMidnightUtc(addDays(dayKey, 1), tz);
  const emails = emailsPerDay(settings);
  const { min, max } = newPeopleBounds(emails);
  const [firstsSent, followupsSent, followupsDue] = await Promise.all([
    dayOffset ? 0 : prisma.send.count({ where: { organizationId: orgId, isFirstTouch: true, status: { not: "REJECTED" }, sentAt: { gte: start } } }),
    dayOffset ? 0 : prisma.send.count({ where: { organizationId: orgId, isFirstTouch: false, step: { gte: 2 }, status: { not: "REJECTED" }, sentAt: { gte: start } } }),
    prisma.contact.count({ where: { organizationId: orgId, status: "CONTACTED", sequenceStoppedAt: null, nextTouchAt: { lt: end } } }),
  ]);
  return planFor(emails, min, max, firstsSent, followupsSent, followupsDue);
}

/** The arithmetic alone, so it can be checked without a database. */
export function planFor(emails: number, min: number, max: number, firstsSent: number, followupsSent: number, followupsDue: number): DailyPlan {
  if (emails <= 0) return { emails: 0, followupsSent, followupsDue, followupsAllowed: 0, newAllowed: 0, firstsSent };
  const followupsWanted = Math.min(followupsSent + followupsDue, emails - min);
  // New people fill what follow-ups leave, never fewer than the floor or more than the cap; once some have gone
  // today the number never drops below them (a follow-up that turned up later waits instead).
  const newAllowed = Math.max(firstsSent, Math.min(max, Math.max(min, emails - followupsWanted)));
  return { emails, followupsSent, followupsDue, followupsAllowed: Math.max(0, emails - newAllowed), newAllowed, firstsSent };
}
