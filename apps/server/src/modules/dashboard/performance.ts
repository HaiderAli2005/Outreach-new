import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getSettings } from "../../domain/settings.js";
import { addDays, dateKeyInTz, dayKeyOf, tzMidnightUtc } from "../../lib/time.js";
import { formatUsd, PRICE_PER_EMAIL } from "../../domain/money.js";
import { groupsOf } from "../onboarding/onboarding.service.js";

/**
 * The cockpit's performance: what went out, what arrived, what came back and what it cost, day by day for the chosen
 * period and against the period before it; and the same per audience, which the customer sees as their campaigns.
 * Every number is read from the sends and the people, in the workspace's own time zone.
 */

const SENT = Prisma.sql`('SENT','DELIVERED','HARD_BOUNCE','SOFT_BOUNCE','COMPLAINT')`;
/** Outreach is step 1 (the first email) and steps 2 and up (follow-ups). Step 0 is an answer to someone who replied:
 * it costs the same and counts in what was spent, but it is a conversation, not outreach. */
const OUTREACH = Prisma.sql`s.status IN ${SENT} AND s.step >= 1`;
/** A hot lead: someone who replied with interest, by our reading or the customer's correction. */
const HOT = Prisma.sql`(COALESCE(c."customerIntent", c.intent) = 'INTERESTED' OR c.temperature = 'hot')`;

interface Totals {
  sent: number;
  firstEmails: number;
  followUps: number;
  delivered: number;
  bounced: number;
  replies: number;
  hot: number;
  spentDecicents: number;
}

const zero = (): Totals => ({ sent: 0, firstEmails: 0, followUps: 0, delivered: 0, bounced: 0, replies: 0, hot: 0, spentDecicents: 0 });

async function sendsByDay(orgId: string, tz: string, from: Date, to: Date) {
  return prisma.$queryRaw<{ d: Date; sent: bigint; first: bigint; delivered: bigint; bounced: bigint; spent: bigint | null }[]>`
    SELECT (s.sent_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date AS d,
           COUNT(*) FILTER (WHERE ${OUTREACH}) AS sent,
           COUNT(*) FILTER (WHERE ${OUTREACH} AND s.step = 1) AS first,
           COUNT(*) FILTER (WHERE ${OUTREACH} AND s.status IN ('SENT','DELIVERED')) AS delivered,
           COUNT(*) FILTER (WHERE ${OUTREACH} AND s.status = 'HARD_BOUNCE') AS bounced,
           SUM(s.price_charged) AS spent
    FROM sends s
    WHERE s.customer_id = ${orgId} AND s.sent_at >= ${from} AND s.sent_at < ${to}
    GROUP BY 1`;
}

async function repliesByDay(orgId: string, tz: string, from: Date, to: Date) {
  return prisma.$queryRaw<{ d: Date; replies: bigint; hot: bigint }[]>`
    SELECT (c."repliedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date AS d,
           COUNT(*) AS replies,
           COUNT(*) FILTER (WHERE ${HOT}) AS hot
    FROM "Contact" c
    WHERE c."organizationId" = ${orgId} AND c."repliedAt" >= ${from} AND c."repliedAt" < ${to}
    GROUP BY 1`;
}

function add(t: Totals, s?: { sent: bigint; first: bigint; delivered: bigint; bounced: bigint; spent: bigint | null }, r?: { replies: bigint; hot: bigint }) {
  if (s) {
    t.sent += Number(s.sent);
    t.firstEmails += Number(s.first);
    t.followUps += Number(s.sent) - Number(s.first);
    t.delivered += Number(s.delivered);
    t.bounced += Number(s.bounced);
    t.spentDecicents += Number(s.spent ?? 0);
  }
  if (r) {
    t.replies += Number(r.replies);
    t.hot += Number(r.hot);
  }
  return t;
}

type AudienceState = "sending" | "finding" | "waiting" | "paused" | "off" | "exhausted";

export async function performance(orgId: string, days: 7 | 30) {
  const s = await getSettings(orgId);
  const tz = s.timezone;
  const dayKey = dateKeyInTz(tz);
  const from = tzMidnightUtc(addDays(dayKey, -(days - 1)), tz);
  const to = tzMidnightUtc(addDays(dayKey, 1), tz);
  const prevFrom = tzMidnightUtc(addDays(dayKey, -(2 * days - 1)), tz);

  const [sends, replies, prevSends, prevReplies] = await Promise.all([sendsByDay(orgId, tz, from, to), repliesByDay(orgId, tz, from, to), sendsByDay(orgId, tz, prevFrom, from), repliesByDay(orgId, tz, prevFrom, from)]);
  const sMap = new Map(sends.map((r) => [dayKeyOf(new Date(r.d)), r]));
  const rMap = new Map(replies.map((r) => [dayKeyOf(new Date(r.d)), r]));
  const series = Array.from({ length: days }, (_, i) => {
    const d = addDays(dayKey, i - (days - 1));
    const t = add(zero(), sMap.get(d), rMap.get(d));
    return { day: d, sent: t.sent, delivered: t.delivered, bounced: t.bounced, replies: t.replies, hot: t.hot, spentDecicents: t.spentDecicents };
  });
  const totals = sends.reduce((t, r) => add(t, r), replies.reduce((t, r) => add(t, undefined, r), zero()));
  const previous = prevSends.reduce((t, r) => add(t, r), prevReplies.reduce((t, r) => add(t, undefined, r), zero()));

  return {
    days,
    series,
    totals: { ...totals, spent: formatUsd(BigInt(totals.spentDecicents)), pricePerEmail: formatUsd(PRICE_PER_EMAIL) },
    previous: { ...previous, spent: formatUsd(BigInt(previous.spentDecicents)) },
    audiences: await audiences(orgId, from, to, days),
  };
}

/** Each audience as a campaign: its state in plain words, and what it has done in the period. */
async function audiences(orgId: string, from: Date, to: Date, days: number) {
  const [s, onboarding, campaign] = await Promise.all([
    getSettings(orgId),
    prisma.onboarding.findUnique({ where: { organizationId: orgId }, select: { groups: true, launchedAt: true } }),
    prisma.campaign.findFirst({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" }, select: { status: true, audiences: true } }),
  ]);
  // A workspace launched from onboarding sees its audiences; one set up by hand sees its campaigns.
  const byAudience = !!onboarding?.launchedAt;
  const key = byAudience ? Prisma.sql`c."audienceId"` : Prisma.sql`c."campaignId"`;
  const rows = await prisma.$queryRaw<{ a: string; found: bigint; waiting: bigint; sent: bigint; firstSent: bigint; spent: bigint | null; replies: bigint; hot: bigint; sentToday: bigint }[]>`
    WITH people AS (
      SELECT COALESCE(${key}, '') AS a,
             COUNT(*) FILTER (WHERE c.status <> 'REJECTED') AS found,
             COUNT(*) FILTER (WHERE c.status IN ('PERSONALIZED','QUEUED') AND c."sequenceStoppedAt" IS NULL) AS waiting,
             COUNT(*) FILTER (WHERE c."repliedAt" >= ${from} AND c."repliedAt" < ${to}) AS replies,
             COUNT(*) FILTER (WHERE c."repliedAt" >= ${from} AND c."repliedAt" < ${to} AND ${HOT}) AS hot
      FROM "Contact" c WHERE c."organizationId" = ${orgId}
      GROUP BY 1
    ),
    -- Every send is to someone in people, so people holds every key.
    out AS (
      SELECT COALESCE(${key}, '') AS a,
             COUNT(*) FILTER (WHERE ${OUTREACH}) AS sent,
             COUNT(*) FILTER (WHERE ${OUTREACH} AND s.step = 1) AS "firstSent",
             SUM(s.price_charged) AS spent,
             COUNT(*) FILTER (WHERE ${OUTREACH} AND s.sent_at >= now() - interval '1 day') AS "sentToday"
      FROM sends s JOIN "Contact" c ON c.id = s.prospect_id
      WHERE s.customer_id = ${orgId} AND s.sent_at >= ${from} AND s.sent_at < ${to}
      GROUP BY 1
    )
    SELECT p.a, p.found, p.waiting, COALESCE(o.sent, 0) AS sent, COALESCE(o."firstSent", 0) AS "firstSent", o.spent, p.replies, p.hot, COALESCE(o."sentToday", 0) AS "sentToday"
    FROM people p LEFT JOIN out o ON o.a = p.a`;
  const byId = new Map(rows.map((r) => [r.a, r]));
  const listed = (campaign?.audiences as { id?: string; saturatedAt?: string | null }[] | null) ?? [];
  const approvalPending = s.launchMode !== "AUTO" && !s.firstBatchApprovedAt;
  const paused = !s.autopilotEnabled || (byAudience && campaign?.status !== "ACTIVE");

  const shape = (id: string, name: string, on: boolean) => {
    const r = byId.get(id);
    const n = (x?: bigint | null) => Number(x ?? 0);
    const sent = n(r?.sent);
    const hot = n(r?.hot);
    const spent = n(r?.spent);
    const exhausted = !!listed.find((a) => a.id === id)?.saturatedAt && !n(r?.waiting);
    const state: AudienceState = !on ? "off" : paused ? "paused" : approvalPending ? "waiting" : n(r?.sentToday) || n(r?.waiting) ? "sending" : exhausted ? "exhausted" : "finding";
    return {
      id,
      name,
      state,
      found: n(r?.found),
      sent,
      perDay: Math.round(sent / days),
      replies: n(r?.replies),
      // Of the people emailed for the first time in the period, the share who replied.
      replyRate: n(r?.firstSent) ? Math.round((1000 * n(r?.replies)) / n(r?.firstSent)) / 10 : 0,
      hot,
      spent: formatUsd(BigInt(spent)),
      costPerLead: hot ? formatUsd(BigInt(Math.round(spent / hot))) : null,
    };
  };
  if (!byAudience || !onboarding) {
    const campaigns = await prisma.campaign.findMany({ where: { organizationId: orgId, status: { in: ["ACTIVE", "PAUSED"] } }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, status: true } });
    return campaigns.filter((c) => byId.has(c.id)).map((c) => shape(c.id, c.name, c.status === "ACTIVE"));
  }
  const out = groupsOf(onboarding).map((g) => shape(g.id, g.name, g.on));
  // People the customer uploaded themselves have no audience: shown as their own row when there are any.
  const own = byId.get("");
  if (own && (Number(own.found) || Number(own.sent))) out.push(shape("", "Your own contacts", true));
  return out;
}
