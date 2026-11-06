/**
 * Pricing and sizing. There are no plans or tiers: customers prepay a balance and every email sent costs $0.04
 * (domain/money.ts), first email, follow-up or reply alike. Finding, verifying and writing to people is included. Supplier costs live in config/internalCosts.ts and are never shown to a customer.
 */

// ─── Pricing (deci-cents, see domain/money.ts) ──────────────────────────────
export const MIN_TOPUP_DECICENTS = 25_000n; // $25.00
export const FREE_TRIAL_DECICENTS = 10_000n; // $10.00, exactly 250 emails
/** Warn about the balance only once sending has started and less than this many days of budget are left. */
export const LOW_BALANCE_WARN_DAYS = 2;

// ─── Sizing ─────────────────────────────────────────────────────────────────
/** Cold emails a mailbox sends a day at full capacity. The safe sustained rate. */
export const SENDS_PER_WARM_INBOX = 30;
/** Mailboxes per domain. Keeps one domain at 90 emails a day, below where it looks like a bulk sender. */
export const MAX_INBOXES_PER_DOMAIN = 3;

/** mailboxes_needed = ceil(emails_per_day / 30) */
export function mailboxesNeeded(emailsPerDay: number): number {
  return emailsPerDay > 0 ? Math.ceil(emailsPerDay / SENDS_PER_WARM_INBOX) : 0;
}

/** domains_needed = ceil(mailboxes_needed / 3) = ceil(emails_per_day / 90) */
export function domainsNeeded(emailsPerDay: number): number {
  return Math.ceil(mailboxesNeeded(emailsPerDay) / MAX_INBOXES_PER_DOMAIN);
}

/** Emails in every sequence: the first email and three follow-ups. A daily email volume reaches volume / 4 new people. */
export const SEQUENCE_STEPS = 4;

/**
 * How a day's emails are split (see dailyPlan.ts): follow-ups first, new people fill everything they leave. New people
 * always get at least NEW_SHARE_MIN of the day, so a Monday stacked with weekend follow-ups never stops new people.
 * There is no cap below the day itself: a customer who chose 1,250 a day sends 1,250 from the first full day, and
 * the follow-ups that start on day 3 take their place first from then on, inside the same total.
 */
export const NEW_SHARE_MIN = 0.2;
export const NEW_SHARE_MAX = 1;

/** The fewest and the most new people a day a daily email volume allows. */
export function newPeopleBounds(emailsPerDay: number): { min: number; max: number } {
  if (!emailsPerDay || emailsPerDay <= 0) return { min: 0, max: 0 };
  const min = Math.max(1, Math.ceil(emailsPerDay * NEW_SHARE_MIN));
  return { min, max: Math.max(min, Math.floor(emailsPerDay * NEW_SHARE_MAX)) };
}

/** New people a day that a daily email volume carries on average once every step of the sequence is going out. */
export function newPeoplePerDay(emailsPerDay: number): number {
  if (!emailsPerDay || emailsPerDay <= 0) return 0;
  return Math.max(1, Math.floor(emailsPerDay / SEQUENCE_STEPS));
}

export const VOLUME_MIN = 100;
export const VOLUME_MAX = 5000;
/** Setup asks for emails a day: the slider moves in steps of 50, with these presets. */
export const VOLUME_STEP = 50;
export const VOLUME_PRESETS = [250, 500, 1000, 2500, 5000] as const;
/** Never recommend more than this for a first campaign: one that works at 500 beats one that burns the pool at 5,000. */
export const VOLUME_RECOMMEND_CAP = 1000;
/** Days of reachable market a recommended pace should leave. */
export const VOLUME_RECOMMEND_MARKET_DAYS = 90;

// ─── The daily budget: the one volume control, in money ────────────────────
/** $4 a day (100 emails) to $200 a day (5,000 emails). Emails a day are derived: budget / $0.04. */
export const BUDGET_MIN_DECICENTS = 4_000n;
export const BUDGET_MAX_DECICENTS = 200_000n;
export const BUDGET_DEFAULT_DECICENTS = 20_000n; // $20 a day, 500 emails
export const BUDGET_PRESETS_DECICENTS = [10_000n, 20_000n, 40_000n, 100_000n, 200_000n] as const;
/** Top-up cards offered at a daily budget: this many days of it, rounded up to $5, never under the minimum top-up. */
export { TOPUP_DAYS } from "../domain/money.js";

// ─── Warmup (shared pool) ───────────────────────────────────────────────────
/**
 * A new domain ages with DNS set and sends nothing for this long. The "brand-new domain" penalty fades within the first
 * couple of weeks, and reputation itself is built by the warmup ladder, not by silence, so 14 days is enough.
 */
export const AGING_DAYS = 14;
/** The warmup ramp: [first warmup day, daily cap]. Day 28 and beyond is full capacity. */
export const WARMUP_RAMP: readonly [number, number][] = [
  [1, 5],
  [8, 10],
  [15, 20],
  [22, 30],
];
/** warmup_day 29 and on is ACTIVE: the ladder's four weeks are done. */
export const WARMUP_DAYS_TO_ACTIVE = 29;
/**
 * When each sequence email goes, in days after the first: 0, 3, 7 and 14. Days, never hours: four emails in four
 * days earns spam complaints, and a complaint weighs ten times a bounce. Every follow-up is a reply in the same
 * thread, from the same mailbox.
 */
export const SEQUENCE_DAYS = [0, 3, 7, 14] as const;
/**
 * Purchase to full capacity, in weeks: DNS, the aging days, then 29 days on the warmup ladder (14 + 29 = 43 days, so 7
 * weeks). Every shelf and reorder calculation uses it as the lead time, and it is worked out from the two so changing
 * either keeps them right.
 */
export const LEAD_TIME_WEEKS = Math.ceil((AGING_DAYS + WARMUP_DAYS_TO_ACTIVE) / 7);

// ─── Parked branded-domain flow (dedicated domains per customer) ────────────
export const CAMPAIGN_START = { lo: 10, hi: 15, rampDays: 14 } as const;
export const FAST_START = { days: 3, lo: 15, hi: 20, rampDays: 7 } as const;
export const WARMUP_OPTIONS = [14, 21, 28] as const;
