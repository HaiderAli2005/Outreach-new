import type { ContactStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { addDays, dateKeyInTz, tzMidnightUtc } from "../../lib/time.js";
import { getSettings } from "../settings.js";
import { dailyPlan } from "./dailyPlan.js";
import { peopleSupply, SUPPLY_DAYS } from "../supply.js";
import { REGION_TZ, prospectTz, windowFor, windowState } from "./schedule.js";

/**
 * When the next emails really go out, from each person's scheduled minute (nextTouchAt), and in plain words why
 * nothing is scheduled when nothing is.
 */

export type QuietReason = "autopilot-off" | "awaiting-approval" | "daily-cap" | "outside-window" | "nothing-ready" | "scheduling";

const IN_SEQUENCE: ContactStatus[] = ["PERSONALIZED", "QUEUED", "CONTACTED"];
const READY: ContactStatus[] = ["PERSONALIZED", "QUEUED"];
const LATE_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

export async function sendingOutlook(orgId: string, now = new Date()) {
  const s = await getSettings(orgId);
  const scheduled = { organizationId: orgId, sequenceStoppedAt: null, status: { in: IN_SEQUENCE } };
  const soon = { gte: new Date(now.getTime() - LATE_MS), lte: new Date(now.getTime() + DAY_MS) };
  const today = tzMidnightUtc(dateKeyInTz(s.timezone, now), s.timezone);
  const lined = { organizationId: orgId, sequenceStoppedAt: null, status: { in: READY }, approvedAt: { not: null }, lastContactedAt: null };
  const [org, nextBooked, inDay, last, common, firstsToday, approvedReady, waitingApproval, unbooked, lineup, firstBooked] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { region: true } }),
    prisma.contact.findFirst({ where: { ...scheduled, nextTouchAt: { gte: soon.gte } }, orderBy: { nextTouchAt: "asc" }, select: { nextTouchAt: true, timezone: true, country: true, city: true, location: true } }),
    prisma.contact.count({ where: { ...scheduled, nextTouchAt: soon } }),
    prisma.contact.findFirst({ where: { ...scheduled, nextTouchAt: soon }, orderBy: { nextTouchAt: "desc" }, select: { nextTouchAt: true } }),
    prisma.contact.groupBy({ by: ["timezone"], where: { ...scheduled, timezone: { not: null } }, _count: { _all: true }, orderBy: { _count: { timezone: "desc" } }, take: 1 }),
    prisma.send.count({ where: { organizationId: orgId, isFirstTouch: true, status: { not: "REJECTED" }, sentAt: { gte: today } } }),
    prisma.contact.count({ where: { organizationId: orgId, sequenceStoppedAt: null, status: { in: READY }, approvedAt: { not: null } } }),
    prisma.contact.count({ where: { organizationId: orgId, sequenceStoppedAt: null, status: { in: READY }, approvedAt: null } }),
    prisma.contact.count({ where: { organizationId: orgId, sequenceStoppedAt: null, status: { in: READY }, approvedAt: { not: null }, nextTouchAt: null } }),
    prisma.contact.count({ where: lined }),
    prisma.contact.findFirst({ where: { ...lined, nextTouchAt: { gte: soon.gte } }, orderBy: { nextTouchAt: "asc" }, select: { nextTouchAt: true } }),
  ]);
  let next = nextBooked;

  // The zone the window is read in: the next person's own, else where most of the list is, else the workspace's market.
  const fallback = s.prospectTimezone ?? (org?.region ? REGION_TZ[org.region] : null) ?? s.timezone;
  const tz = next ? prospectTz(next, s, org?.region) : (common[0]?.timezone ?? fallback);
  const window = { tz, start: s.sendingWindowStart, end: s.sendingWindowEnd, days: windowFor(s, tz).days, ...windowState(windowFor(s, tz), now) };
  // Today's share of the budget for new people (follow-ups first, new people fill the rest: see dailyPlan).
  const cap = (await dailyPlan(orgId, s, now)).newAllowed;
  // Today's new people are all out, and approved people wait without a minute yet: the send run books them when the
  // next sending day starts. Without this the page would show the next follow-up (days away) as the next email.
  if (s.autopilotEnabled && firstsToday >= cap && unbooked > 0) {
    const fromTomorrow = tzMidnightUtc(addDays(dateKeyInTz(tz, now), 1), tz);
    const opens = windowState(windowFor(s, tz), fromTomorrow).opensAt;
    if (opens && (!next?.nextTouchAt || opens < next.nextTouchAt)) next = { ...(next ?? { timezone: tz, country: null, city: null, location: null }), nextTouchAt: opens };
  }

  // The next new people: when their first emails start, and how many go that day (the daily budget's share for new
  // people, never more than are lined up). Today if there is room and the window is still ahead, else the next sending day.
  let newPeople: { at: Date; count: number } | null = null;
  if (s.autopilotEnabled && lineup > 0) {
    const room = Math.max(0, cap - firstsToday);
    const w = windowFor(s, tz);
    const todayState = windowState(w, now);
    const todayKey = dateKeyInTz(tz, now);
    const opensToday = todayState.opensAt && dateKeyInTz(tz, todayState.opensAt) === todayKey;
    if (room > 0 && (todayState.open || opensToday)) {
      const at = firstBooked?.nextTouchAt && firstBooked.nextTouchAt > now ? firstBooked.nextTouchAt : (todayState.opensAt ?? now);
      newPeople = { at, count: Math.min(lineup, room) };
    } else {
      const opens = windowState(w, tzMidnightUtc(addDays(todayKey, 1), tz)).opensAt;
      // Tomorrow's share, counted from the follow-ups due by then (today's that wait included).
      if (opens) newPeople = { at: opens, count: Math.min(lineup, (await dailyPlan(orgId, s, now, 1)).newAllowed) };
    }
  }

  let reason: QuietReason | null = null;
  if (!inDay) {
    if (!s.autopilotEnabled) reason = "autopilot-off";
    else if (!approvedReady && waitingApproval) reason = "awaiting-approval";
    else if (firstsToday >= cap) reason = "daily-cap";
    else if (!window.open) reason = "outside-window";
    else if (!approvedReady) reason = "nothing-ready";
    else reason = "scheduling";
  }
  // How many people are left for a first email, so the page can say the list is running low instead of "all fine".
  const supply = await peopleSupply(orgId, s, now);
  return {
    supply: { ready: supply.ready, need: supply.need, low: supply.need > 0 && supply.ready < supply.need / SUPPLY_DAYS, finding: s.autopilotEnabled && s.leadSourcing === "AUTOMATIC" },
    next: next?.nextTouchAt ?? null,
    nextProspectTz: next ? tz : null,
    inDay,
    lastInDay: last?.nextTouchAt ?? null,
    firstsToday,
    cap,
    newPeople,
    window,
    reason,
  };
}
