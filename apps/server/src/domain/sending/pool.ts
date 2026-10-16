import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { MAX_INBOXES_PER_DOMAIN, SENDS_PER_WARM_INBOX } from "../../config/plans.js";

/**
 * The shared pool. This file holds the router (which mailbox a NEW person is first emailed from) and the daily
 * slot counting that enforces the warmup ladder. Follow-ups and replies never come through here: they always go
 * out from the mailbox the person is pinned to.
 */

/** Pool-wide cap per domain per day: 3 mailboxes at 30 each. */
export const DOMAIN_DAILY_CAP = SENDS_PER_WARM_INBOX * MAX_INBOXES_PER_DOMAIN;

export interface Picked {
  mailboxId: string;
  domainId: string;
}

/** Today's count for a mailbox, in the mailbox's own time zone, as SQL. A constant, never user input. */
const SENT_TODAY = `(CASE WHEN m."sentTodayOn" = (now() AT TIME ZONE m."timezone")::date THEN m."sentToday" ELSE 0 END)`;

/**
 * The router (spec 2, section 7.1). For a first touch only:
 *
 *   eligible   pool mailbox and domain ACTIVE or WARMING, the domain's SPF, DKIM and DMARC all verified and the
 *              domain not paused, the mailbox under today's ladder cap, the domain under 90 sends today
 *              across all customers, and the domain in the customer's region or global
 *   order      0. a mailbox whose persona speaks the customer's market (a Hungarian campaign signed "Madison" fails)
 *              1. the domain THIS customer used least recently, never-used first (NULLS FIRST)
 *              2. a regional match before a global domain
 *              3. the least loaded mailbox
 *              4. random
 *
 * There is deliberately no per-customer-per-domain cap. Ordering by the customer's coldest domain already spreads
 * each customer as thin as the pool allows: about 80 a domain with 7 domains, about 3 with 190, with no tuning.
 * And because a brand-new warming domain has never been used by anyone, it sorts first for everyone; the ladder
 * cap (5 a day in week one) is all that holds it back. That is the whole warmup traffic engine.
 *
 * Picking also takes the slot (sent_today + 1) in the same statement, so two sends can't both take a last slot.
 */
export async function pickMailbox(customerId: string, region: string, opts: { exclude?: string[]; excludeDomains?: string[]; locales?: string[] } = {}): Promise<Picked | null> {
  const exclude = opts.exclude ?? [];
  const locales = opts.locales ?? [];
  const excludeDomains = opts.excludeDomains ?? [];
  const rows = await prisma.$queryRawUnsafe<{ id: string; domainId: string }[]>(
    `
    WITH cu AS (
      SELECT s.domain_id AS did, MAX(s.sent_at) AS last_used
      FROM sends s
      WHERE s.customer_id = $1 AND s.domain_id IS NOT NULL AND s.status <> 'REJECTED'
      GROUP BY s.domain_id
    ), dc AS (
      SELECT s.domain_id AS did, COUNT(*)::int AS n
      FROM sends s
      WHERE s.sent_at >= date_trunc('day', now()) AND s.domain_id IS NOT NULL AND s.status <> 'REJECTED'
      GROUP BY s.domain_id
    ), candidate AS (
      SELECT m.id, m."sendingDomainId" AS "domainId"
      FROM "Mailbox" m
      JOIN "SendingDomain" d ON d.id = m."sendingDomainId"
      LEFT JOIN cu ON cu.did = d.id
      LEFT JOIN dc ON dc.did = d.id
      LEFT JOIN personas p ON p.id = m."personaId"
      WHERE m."organizationId" IS NULL
        AND d."organizationId" IS NULL
        AND m.status IN ('ACTIVE', 'WARMING')
        AND d.status IN ('ACTIVE', 'WARMING')
        AND d.spf_ok AND d.dkim_ok AND d.dmarc_ok
        AND d.paused_at IS NULL
        AND m."credentialRef" IS NOT NULL
        AND m."sendCapToday" > 0
        AND ${SENT_TODAY} < m."sendCapToday"
        AND COALESCE(dc.n, 0) < $3
        AND d.region IN ($2, 'global')
        AND NOT (m.id = ANY($4::text[]))
        AND NOT (d.id = ANY($5::text[]))
      ORDER BY COALESCE(p.locale = ANY($6::text[]), false) DESC,
               cu.last_used ASC NULLS FIRST,
               (d.region = $2) DESC,
               (${SENT_TODAY})::float / GREATEST(m."sendCapToday", 1) ASC,
               random()
      LIMIT 1
      FOR UPDATE OF m SKIP LOCKED
    )
    UPDATE "Mailbox" m
    SET "sentToday" = ${SENT_TODAY} + 1, "sentTodayOn" = (now() AT TIME ZONE m."timezone")::date
    FROM candidate c
    WHERE m.id = c.id
    RETURNING m.id, c."domainId"`,
    customerId,
    region,
    DOMAIN_DAILY_CAP,
    exclude,
    excludeDomains,
    locales,
  );
  const r = rows[0];
  return r ? { mailboxId: r.id, domainId: r.domainId } : null;
}

/** Takes today's slot on a mailbox a person is already pinned to (a first touch being sent again). */
export async function takeSlot(mailboxId: string): Promise<boolean> {
  const n = await prisma.$executeRawUnsafe(
    `UPDATE "Mailbox" m
     SET "sentToday" = ${SENT_TODAY} + 1, "sentTodayOn" = (now() AT TIME ZONE m."timezone")::date
     WHERE m.id = $1 AND m.status IN ('ACTIVE', 'WARMING') AND ${SENT_TODAY} < m."sendCapToday"`,
    mailboxId,
  );
  return n > 0;
}

/** Hands a slot back when the email didn't go out after all. */
export async function giveSlotBack(mailboxId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "Mailbox" m SET "sentToday" = GREATEST(0, "sentToday" - 1) WHERE m.id = $1 AND m."sentTodayOn" = (now() AT TIME ZONE m."timezone")::date`,
    mailboxId,
  );
}

/** Counts an email that went out without a first-touch slot (a follow-up or a reply), so caps see the real load. */
export async function countSend(mailboxId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "Mailbox" m SET "sentToday" = ${SENT_TODAY} + 1, "sentTodayOn" = (now() AT TIME ZONE m."timezone")::date WHERE m.id = $1`,
    mailboxId,
  );
}

const inRotation: Prisma.MailboxWhereInput = { organizationId: null, status: { in: ["ACTIVE", "WARMING"] }, sendingDomain: { organizationId: null, status: { in: ["ACTIVE", "WARMING"] }, pausedAt: null } };

/** Total daily capacity of the pool: the ladder caps of every mailbox in rotation, within each domain's cap. */
export async function poolCapacity(): Promise<number> {
  const rows = await prisma.mailbox.groupBy({ by: ["sendingDomainId"], where: inRotation, _sum: { sendCapToday: true } });
  return rows.reduce((a, r) => a + Math.min(DOMAIN_DAILY_CAP, r._sum.sendCapToday ?? 0), 0);
}

/** What is left of today's pool capacity across every customer. */
export async function poolFreeToday(): Promise<{ capacity: number; used: number; free: number }> {
  const capacity = await poolCapacity();
  const since = new Date(new Date().setUTCHours(0, 0, 0, 0));
  const used = await prisma.send.count({ where: { isFirstTouch: true, status: { not: "REJECTED" }, sentAt: { gte: since }, mailbox: { organizationId: null } } });
  return { capacity, used, free: Math.max(0, capacity - used) };
}

/**
 * Internal outreach (our own companies) uses the pool only while there is room to spare, so paying customers are
 * always served first when capacity is tight.
 */
export async function internalMayUse(): Promise<boolean> {
  const { capacity, free } = await poolFreeToday();
  return capacity > 0 && free > capacity * env.POOL_CUSTOMER_RESERVE;
}

/** The customer's market from their analysis, as a pool region tag. Several countries, or none, is global. */
export function regionFor(countries: string[]): string {
  const tags = new Set(
    countries
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
      .map((c) => REGION_OF[c] ?? "global"),
  );
  return tags.size === 1 ? [...tags][0] : "global";
}

const REGION_OF: Record<string, string> = {
  pakistan: "pk",
  pk: "pk",
  "united kingdom": "uk",
  uk: "uk",
  england: "uk",
  scotland: "uk",
  wales: "uk",
  "united states": "us",
  "united states of america": "us",
  usa: "us",
  us: "us",
  germany: "eu-de",
  deutschland: "eu-de",
  austria: "eu-de",
  switzerland: "eu-de",
};
