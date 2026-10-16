import { prisma } from "../lib/prisma.js";
import { postToSlack } from "../integrations/slack.js";
import { forEachOrg, payingOrgs } from "./runner.js";

export type ReportPeriod = "daily" | "weekly" | "monthly";
const WINDOW: Record<ReportPeriod, number> = { daily: 1, weekly: 7, monthly: 30 };

export async function buildReport(orgId: string, period: ReportPeriod) {
  const since = new Date(Date.now() - WINDOW[period] * 86_400_000);
  const [sent, replies, leads, meetings, removed, byClass] = await Promise.all([
    prisma.message.count({ where: { organizationId: orgId, direction: "OUTBOUND", createdAt: { gte: since } } }),
    prisma.message.count({ where: { organizationId: orgId, direction: "INBOUND", createdAt: { gte: since } } }),
    prisma.contact.count({ where: { organizationId: orgId, createdAt: { gte: since }, status: { not: "REJECTED" } } }),
    prisma.contact.count({ where: { organizationId: orgId, meetingBookedAt: { gte: since } } }),
    prisma.contact.count({ where: { organizationId: orgId, updatedAt: { gte: since }, status: { in: ["UNSUBSCRIBED", "BOUNCED"] } } }),
    prisma.message.groupBy({ by: ["intent"], where: { organizationId: orgId, direction: "INBOUND", createdAt: { gte: since }, intent: { not: null } }, _count: { _all: true } }),
  ]);
  return { period, since, sent, replies, leads, meetings, removed, byClass: Object.fromEntries(byClass.map((r) => [r.intent, r._count._all])) };
}

export async function reportForOrg(orgId: string, period: ReportPeriod) {
  const r = await buildReport(orgId, period);
  const label = period.charAt(0).toUpperCase() + period.slice(1);
  const classes = Object.entries(r.byClass).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const posted = await postToSlack(orgId, `*${label} outreach report*\nSent: ${r.sent} · Replies: ${r.replies} · New leads: ${r.leads} · Meetings booked: ${r.meetings} · Removed (bounce/unsub): ${r.removed}\nReplies by type: ${classes}`);
  return { ...r, posted };
}

export function runReportJob(period: ReportPeriod) {
  return forEachOrg(`report-${period}`, payingOrgs, (orgId) => reportForOrg(orgId, period));
}
