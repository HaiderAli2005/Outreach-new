import type { ContactStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { dateKeyInTz, tzMidnightUtc } from "../../lib/time.js";
import { getSettings } from "../settings.js";
import { emailsPerDay } from "../budget.js";
import { newPeoplePerDay } from "../../config/plans.js";
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
  const [org, next, inDay, last, common, firstsToday, approvedReady, waitingApproval] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { region: true } }),
    prisma.contact.findFirst({ where: { ...scheduled, nextTouchAt: { gte: soon.gte } }, orderBy: { nextTouchAt: "asc" }, select: { nextTouchAt: true, timezone: true, country: true, city: true, location: true } }),
    prisma.contact.count({ where: { ...scheduled, nextTouchAt: soon } }),
    prisma.contact.findFirst({ where: { ...scheduled, nextTouchAt: soon }, orderBy: { nextTouchAt: "desc" }, select: { nextTouchAt: true } }),
    prisma.contact.groupBy({ by: ["timezone"], where: { ...scheduled, timezone: { not: null } }, _count: { _all: true }, orderBy: { _count: { timezone: "desc" } }, take: 1 }),
    prisma.send.count({ where: { organizationId: orgId, isFirstTouch: true, status: { not: "REJECTED" }, sentAt: { gte: today } } }),
    prisma.contact.count({ where: { organizationId: orgId, sequenceStoppedAt: null, status: { in: READY }, approvedAt: { not: null } } }),
    prisma.contact.count({ where: { organizationId: orgId, sequenceStoppedAt: null, status: { in: READY }, approvedAt: null } }),
  ]);

  // The zone the window is read in: the next person's own, else where most of the list is, else the workspace's market.
  const fallback = s.prospectTimezone ?? (org?.region ? REGION_TZ[org.region] : null) ?? s.timezone;
  const tz = next ? prospectTz(next, s, org?.region) : (common[0]?.timezone ?? fallback);
  const window = { tz, start: s.sendingWindowStart, end: s.sendingWindowEnd, days: windowFor(s, tz).days, ...windowState(windowFor(s, tz), now) };
  const cap = newPeoplePerDay(emailsPerDay(s));

  let reason: QuietReason | null = null;
  if (!inDay) {
    if (!s.autopilotEnabled) reason = "autopilot-off";
    else if (!approvedReady && waitingApproval) reason = "awaiting-approval";
    else if (firstsToday >= cap) reason = "daily-cap";
    else if (!window.open) reason = "outside-window";
    else if (!approvedReady) reason = "nothing-ready";
    else reason = "scheduling";
  }
  return {
    next: next?.nextTouchAt ?? null,
    nextProspectTz: next ? tz : null,
    inDay,
    lastInDay: last?.nextTouchAt ?? null,
    firstsToday,
    cap,
    window,
    reason,
  };
}
