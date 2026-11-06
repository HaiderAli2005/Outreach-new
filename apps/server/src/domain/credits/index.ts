import type { LedgerKind, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { coldEmailPaused, insufficientCredits } from "../../lib/errors.js";
import { PRICE_PER_EMAIL, REPLY_RESERVE, SEQUENCE_EMAILS, emailsFor, formatPrice, formatUsd, lastsText, peopleFor, type DeciCents } from "../money.js";
import { FREE_TRIAL_DECICENTS, LOW_BALANCE_WARN_DAYS } from "../../config/plans.js";

/**
 * The prepaid balance. Every function that moves money lives here, and every one of them runs inside a transaction
 * that holds a per-customer advisory lock, so two movements for one customer never interleave.
 *
 *   balance   = balanceAfter of the newest ledger row (0 when there is none)
 *   holds     = sum of `remaining` over the customer's OPEN reservations
 *   available = balance - holds, and nothing may make it negative
 *
 * Reserve-then-commit: a lead pushed for sending holds its whole sequence (4 emails). Each email that goes out turns
 * one email's worth of the hold into a CHARGE. What is left when the sequence ends is RELEASEd. Follow-ups only
 * ever spend what was held, so a long queue can never outrun the balance.
 */

type Tx = Prisma.TransactionClient;

/** The organization whose balance pays for this workspace's sending. One level deep, and itself on any doubt. */
export async function customerOf(orgId: string, db: Tx | typeof prisma = prisma): Promise<string> {
  try {
    const org = await db.organization.findUnique({ where: { id: orgId }, select: { billingOrganizationId: true } });
    return org?.billingOrganizationId ?? orgId;
  } catch {
    return orgId;
  }
}

/** Runs fn in a transaction that holds this customer's money lock. */
export function withCustomerLock<T>(customerId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"credits:" + customerId}))`;
      return fn(tx);
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

export async function balanceOf(customerId: string, db: Tx | typeof prisma = prisma): Promise<DeciCents> {
  const last = await db.creditLedger.findFirst({ where: { organizationId: customerId }, orderBy: { seq: "desc" }, select: { balanceAfter: true } });
  return last?.balanceAfter ?? 0n;
}

export async function holdsOf(customerId: string, db: Tx | typeof prisma = prisma): Promise<DeciCents> {
  const agg = await db.creditReservation.aggregate({ where: { organizationId: customerId, status: "OPEN" }, _sum: { remaining: true } });
  return agg._sum.remaining ?? 0n;
}

export async function availableOf(customerId: string, db: Tx | typeof prisma = prisma): Promise<DeciCents> {
  const [balance, holds] = await Promise.all([balanceOf(customerId, db), holdsOf(customerId, db)]);
  const a = balance - holds;
  return a > 0n ? a : 0n;
}

/** Writes one ledger row on top of the current balance. Caller holds the lock. */
async function append(tx: Tx, customerId: string, row: { kind: LedgerKind; amount: DeciCents; sendId?: string | null; reservationId?: string | null; stripeRef?: string | null; note?: string | null }) {
  const before = await balanceOf(customerId, tx);
  const after = before + row.amount;
  if (after < 0n) throw new Error(`Ledger would go negative for ${customerId}`);
  return tx.creditLedger.create({
    data: { organizationId: customerId, kind: row.kind, amount: row.amount, balanceAfter: after, sendId: row.sendId ?? null, reservationId: row.reservationId ?? null, stripeRef: row.stripeRef ?? null, note: row.note ?? null },
  });
}

export type CreditResult = { ok: true; balance: DeciCents; duplicate?: boolean } | { ok: false; reason: string };

/**
 * Money in: a top-up, a bonus (free trial, goodwill) or a refund of a charge. Idempotent on (kind, ref): the same
 * Stripe payment can be reported twice and is credited once.
 */
export async function credit(orgId: string, kind: "TOPUP" | "BONUS" | "REFUND", amount: DeciCents, opts: { ref?: string | null; note?: string | null } = {}): Promise<CreditResult> {
  if (amount <= 0n) return { ok: false, reason: "Amount must be positive" };
  const customerId = await customerOf(orgId);
  return withCustomerLock(customerId, async (tx) => {
    if (opts.ref) {
      const seen = await tx.creditLedger.findUnique({ where: { kind_stripeRef: { kind, stripeRef: opts.ref } }, select: { id: true } });
      if (seen) return { ok: true as const, balance: await balanceOf(customerId, tx), duplicate: true };
    }
    const row = await append(tx, customerId, { kind, amount, stripeRef: opts.ref ?? null, note: opts.note ?? null });
    return { ok: true as const, balance: row.balanceAfter };
  });
}

/**
 * An operator taking money back (a correction). Never below zero, never past what is held for queued emails.
 */
export async function debitCorrection(orgId: string, amount: DeciCents, note: string): Promise<CreditResult> {
  if (amount <= 0n) return { ok: false, reason: "Amount must be positive" };
  const customerId = await customerOf(orgId);
  return withCustomerLock(customerId, async (tx) => {
    const available = (await balanceOf(customerId, tx)) - (await holdsOf(customerId, tx));
    if (available < amount) return { ok: false as const, reason: `Only ${formatUsd(available > 0n ? available : 0n)} is free to take back` };
    const row = await append(tx, customerId, { kind: "CHARGE", amount: -amount, note: `Correction: ${note}` });
    return { ok: true as const, balance: row.balanceAfter };
  });
}

export type ReserveResult = { ok: true; reservationId: string; available: DeciCents } | { ok: false; code: "INSUFFICIENT_CREDITS" | "COLD_EMAIL_PAUSED"; available: DeciCents };

/** Holds money for queued emails. Refuses rather than letting available go below zero. */
export async function reserve(orgId: string, wanted: DeciCents, opts: { contactId?: string | null; note?: string | null; atLeast?: DeciCents; keep?: DeciCents } = {}): Promise<ReserveResult> {
  const customerId = await customerOf(orgId);
  return withCustomerLock(customerId, async (tx) => {
    const balance = await balanceOf(customerId, tx);
    const available = balance - (await holdsOf(customerId, tx));
    // With atLeast, holds what is there (down to that floor) instead of refusing, so a balance is spent to the cent.
    // With keep, that much is never held: cold email leaves the reply reserve alone.
    const floor = opts.atLeast ?? wanted;
    if (available < floor) return { ok: false as const, code: "INSUFFICIENT_CREDITS" as const, available: available > 0n ? available : 0n };
    const usable = available - (opts.keep ?? 0n);
    if (usable < floor) return { ok: false as const, code: "COLD_EMAIL_PAUSED" as const, available };
    const amount = usable < wanted ? usable - (usable % floor) : wanted;
    const r = await tx.creditReservation.create({ data: { organizationId: customerId, contactId: opts.contactId ?? null, amount, remaining: amount } });
    await tx.creditLedger.create({
      data: { organizationId: customerId, kind: "RESERVE", amount: 0n, balanceAfter: balance, reservationId: r.id, note: opts.note ?? `Held ${formatUsd(amount)}` },
    });
    return { ok: true as const, reservationId: r.id, available: available - amount };
  });
}

/**
 * Whether one more email may go out now, and why not. The floor depends on what is being sent:
 *
 *   a reply in a live conversation   may spend the balance down to zero
 *   cold email (first or follow-up)  may not touch the last $2 (REPLY_RESERVE), kept for replies
 *
 * Money already held for this person's sequence was set aside above the reserve, so it may be spent. Refusals carry
 * different codes so the app can say "cold email is paused, conversations carry on" or "everything is paused".
 */
export async function sendAllowance(orgId: string, opts: { isReply: boolean; contactId?: string | null }): Promise<{ ok: true } | { ok: false; code: "COLD_EMAIL_PAUSED" | "INSUFFICIENT_CREDITS" }> {
  const customerId = await customerOf(orgId);
  if (!opts.isReply && opts.contactId) {
    const held = await prisma.creditReservation.findFirst({ where: { organizationId: customerId, contactId: opts.contactId, status: "OPEN", remaining: { gte: PRICE_PER_EMAIL } }, select: { id: true } });
    if (held) return { ok: true };
  }
  const available = (await balanceOf(customerId)) - (await holdsOf(customerId));
  if (available < PRICE_PER_EMAIL) return { ok: false, code: "INSUFFICIENT_CREDITS" };
  const floor = opts.isReply ? 0n : REPLY_RESERVE;
  if (available - PRICE_PER_EMAIL < floor) return { ok: false, code: "COLD_EMAIL_PAUSED" };
  return { ok: true };
}

export const COLD_PAUSED_MESSAGE = "Cold email is paused. Your live conversations are still running. Add credits to resume sending.";
export const ALL_PAUSED_MESSAGE = "Your balance is used up. Everything is paused, replies included, until you add credits.";

/**
 * For an email written by a person in the inbox: a reply to someone who wrote back may spend down to zero; a message
 * into a cold thread is cold email and leaves the reserve alone. Our own outreach is never billed.
 */
export async function assertCanEmail(orgId: string, contactId: string): Promise<void> {
  const payer = await prisma.organization.findUnique({ where: { id: await customerOf(orgId) }, select: { kind: true } });
  if (payer?.kind === "INTERNAL") return;
  const a = await sendAllowance(orgId, { isReply: await isLiveConversation(contactId), contactId });
  if (!a.ok) throw a.code === "COLD_EMAIL_PAUSED" ? coldEmailPaused(COLD_PAUSED_MESSAGE) : insufficientCredits(ALL_PAUSED_MESSAGE);
}

/**
 * A live conversation: the person has written back themselves. Only a human reply counts (it sets repliedAt); an
 * out-of-office or other auto-reply never does, or one vacation message would let every later email draw on the
 * reserve.
 */
export async function isLiveConversation(contactId: string): Promise<boolean> {
  const c = await prisma.contact.findUnique({ where: { id: contactId }, select: { repliedAt: true } });
  return !!c?.repliedAt;
}

/**
 * Held when a person starts: their whole 4-email sequence, $0.16, or whatever is left when the balance is lower, so
 * the last cents of a balance still go out as emails. Each email turns $0.04 of the hold into a charge.
 */
export const SEQUENCE_HOLD: DeciCents = PRICE_PER_EMAIL * BigInt(SEQUENCE_EMAILS);

export type ChargeResult = { ok: true; balance: DeciCents; duplicate?: boolean } | { ok: false; reason: string };

/**
 * One email went out: turn its price ($0.04, whatever it is) of the contact's hold into a charge. Idempotent per send. When nothing is
 * held (it was released, or the email was never queued through Aperture) it charges only what is free, and records
 * a zero charge rather than ever going negative.
 */
/** Runs after a debit commits (auto-reload registers here). It must only enqueue work, never wait on it. */
let afterDebit: ((payer: string) => void) | null = null;
export function setAfterDebit(fn: ((payer: string) => void) | null): void {
  afterDebit = fn;
}

export async function chargeSend(orgId: string, sendId: string, contactId: string, price: DeciCents = PRICE_PER_EMAIL): Promise<ChargeResult> {
  const r = await chargeSendInner(orgId, sendId, contactId, price);
  if (r.ok && !r.duplicate && price > 0n && afterDebit) {
    try {
      afterDebit(await customerOf(orgId));
    } catch {
      // never let a reload check affect a send
    }
  }
  return r;
}

async function chargeSendInner(orgId: string, sendId: string, contactId: string, price: DeciCents): Promise<ChargeResult> {
  if (price <= 0n) return { ok: true, balance: await balanceOf(await customerOf(orgId)) };
  const customerId = await customerOf(orgId);
  // Our own outreach (Marketlytics, skimming.ai, RankHouse) is never billed, so it never shows up as revenue.
  const payer = await prisma.organization.findUnique({ where: { id: customerId }, select: { kind: true } });
  if (payer?.kind === "INTERNAL") return { ok: true, balance: await balanceOf(customerId) };
  return withCustomerLock(customerId, async (tx) => {
    const seen = await tx.creditLedger.findUnique({ where: { kind_sendId: { kind: "CHARGE", sendId } }, select: { balanceAfter: true } });
    if (seen) return { ok: true as const, balance: await balanceOf(customerId, tx), duplicate: true };
    const hold = await tx.creditReservation.findFirst({ where: { organizationId: customerId, contactId, status: "OPEN", remaining: { gte: price } }, orderBy: { createdAt: "asc" } });
    if (hold) {
      const remaining = hold.remaining - price;
      await tx.creditReservation.update({ where: { id: hold.id }, data: { remaining, ...(remaining === 0n ? { status: "SETTLED", settledAt: new Date() } : {}) } });
      const row = await append(tx, customerId, { kind: "CHARGE", amount: -price, sendId, reservationId: hold.id, note: "Email sent" });
      await tx.send.update({ where: { id: sendId }, data: { priceCharged: price } });
      return { ok: true as const, balance: row.balanceAfter };
    }
    const free = (await balanceOf(customerId, tx)) - (await holdsOf(customerId, tx));
    if (free < price) {
      logger.warn({ customerId, sendId }, "email sent with nothing held and no free balance; not charged");
      return { ok: false as const, reason: "nothing held and no free balance" };
    }
    const row = await append(tx, customerId, { kind: "CHARGE", amount: -price, sendId, note: "Email sent" });
    await tx.send.update({ where: { id: sendId }, data: { priceCharged: price } });
    return { ok: true as const, balance: row.balanceAfter };
  });
}

/** Gives back whatever is still held. Used when a send is refused or a sequence ends early. */
export async function release(reservationId: string, note: string): Promise<DeciCents> {
  const r = await prisma.creditReservation.findUnique({ where: { id: reservationId }, select: { organizationId: true } });
  if (!r) return 0n;
  return withCustomerLock(r.organizationId, async (tx) => {
    const hold = await tx.creditReservation.findUnique({ where: { id: reservationId } });
    if (!hold || hold.status !== "OPEN") return 0n;
    await tx.creditReservation.update({ where: { id: hold.id }, data: { remaining: 0n, status: "SETTLED", settledAt: new Date() } });
    if (hold.remaining > 0n) {
      await tx.creditLedger.create({
        data: { organizationId: hold.organizationId, kind: "RELEASE", amount: 0n, balanceAfter: await balanceOf(hold.organizationId, tx), reservationId: hold.id, note: `${note}: ${formatUsd(hold.remaining)} back` },
      });
    }
    return hold.remaining;
  });
}

/** Releases every open hold for a person (they replied, bounced, unsubscribed or the sequence finished). */
export async function releaseForContact(contactId: string, note: string): Promise<DeciCents> {
  const open = await prisma.creditReservation.findMany({ where: { contactId, status: "OPEN" }, select: { id: true } });
  let total = 0n;
  for (const r of open) total += await release(r.id, note);
  return total;
}

/** Holds that outlived any sequence (a follow-up that could never go out). Returned so money is never stuck. */
export async function releaseStaleHolds(olderThanDays = 30): Promise<number> {
  const stale = await prisma.creditReservation.findMany({ where: { status: "OPEN", createdAt: { lt: new Date(Date.now() - olderThanDays * 86_400_000) } }, select: { id: true } });
  for (const r of stale) await release(r.id, "Sequence ended");
  return stale.length;
}

// ─── What the customer sees ─────────────────────────────────────────────────

export interface BalanceView {
  balance: string;
  balanceDeciCents: string;
  available: string;
  held: string;
  /** Emails the balance pays for: exact, every email costs the same. */
  emailsLeft: number;
  /** New people those emails reach, each with a 4-email sequence. */
  peopleLeft: number;
  pricePerEmail: string;
  sendRatePerDay: number;
  /** The daily budget, or null when uncapped. */
  dailyBudget: string | null;
  /** Days the balance lasts at the daily budget (or, uncapped, at the last week's spend). */
  runwayDays: number | null;
  lastTopup: string | null;
  /** How long the balance lasts at the daily budget, in words ("about half a day"). */
  lasts: string | null;
  /**
   * Where the money stands, which decides what the customer is told:
   *   unfunded  no card added and nothing bought: "Add a card to start sending"
   *   trial     only the free credit, nothing sent yet: a fact, never a warning
   *   ok        sending, with more than two days of budget left
   *   low       sending, under two days of budget: a warning
   *   reserve   $2 or less: cold email is paused, live conversations keep sending
   *   empty     nothing left: everything is paused, replies included
   */
  stage: "unfunded" | "trial" | "ok" | "low" | "reserve" | "empty";
  warnings: { low: boolean; runway: boolean; empty: boolean };
}

/** Balance, runway and warnings. Display strings are made here, at the boundary. */
export async function balanceView(orgId: string): Promise<BalanceView> {
  const customerId = await customerOf(orgId);
  const [balance, holds, lastTop, sent7, settings, spent7, firstCharge, topups] = await Promise.all([
    balanceOf(customerId),
    holdsOf(customerId),
    prisma.creditLedger.findFirst({ where: { organizationId: customerId, kind: { in: ["TOPUP", "BONUS"] } }, orderBy: { seq: "desc" }, select: { amount: true } }),
    prisma.send.count({ where: { organizationId: orgId, status: { in: ["SENT", "DELIVERED", "HARD_BOUNCE", "SOFT_BOUNCE", "COMPLAINT"] }, sentAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
    prisma.orgSettings.findUnique({ where: { organizationId: orgId }, select: { dailyBudgetDecicents: true } }),
    prisma.send.aggregate({ where: { organizationId: orgId, sentAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _sum: { priceCharged: true } }),
    prisma.creditLedger.findFirst({ where: { organizationId: customerId, kind: "CHARGE" }, select: { id: true } }),
    prisma.creditLedger.count({ where: { organizationId: customerId, kind: "TOPUP" } }),
  ]);
  const available = balance - holds > 0n ? balance - holds : 0n;
  const rate = Math.round(sent7 / 7);
  const emailsLeft = emailsFor(balance);
  const budget = settings?.dailyBudgetDecicents ?? null;
  // Runway at the customer's own daily budget: the number they chose, not a guess from a blended price.
  const perDay = budget !== null && budget > 0n ? budget : (spent7._sum.priceCharged ?? 0n) / 7n;
  const runway = perDay > 0n ? Number(balance / perDay) : null;
  // "Running low" means money is actually being spent: a balance that hasn't started yet is never low.
  const started = !!firstCharge;
  const low = started && runway !== null && runway < LOW_BALANCE_WARN_DAYS;
  // "Free credit" only while the balance is no more than the free credit: a gift or correction on top is just balance.
  const trial = !started && topups === 0 && balance <= FREE_TRIAL_DECICENTS;
  const stage: BalanceView["stage"] = !lastTop ? "unfunded" : emailsLeft === 0 ? "empty" : balance <= REPLY_RESERVE ? "reserve" : trial ? "trial" : low ? "low" : "ok";
  return {
    balance: formatUsd(balance),
    balanceDeciCents: balance.toString(),
    available: formatUsd(available),
    held: formatUsd(holds),
    emailsLeft,
    peopleLeft: peopleFor(emailsLeft),
    pricePerEmail: formatPrice(PRICE_PER_EMAIL),
    sendRatePerDay: rate,
    dailyBudget: budget === null ? null : budget.toString(),
    runwayDays: runway,
    lastTopup: lastTop ? formatUsd(lastTop.amount) : null,
    lasts: lastsText(balance, perDay > 0n ? perDay : null),
    stage,
    warnings: { low, runway: low, empty: !!lastTop && emailsLeft === 0 },
  };
}

export interface ActivityRow {
  day: string;
  kind: "sent" | "topup" | "bonus" | "refund" | "correction";
  emails: number | null;
  amount: string;
}

/** Recent activity, one row per day for sending and one per top-up. Holds are bookkeeping and are left out. */
export async function activity(orgId: string, days = 30): Promise<ActivityRow[]> {
  const customerId = await customerOf(orgId);
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.creditLedger.findMany({
    where: { organizationId: customerId, createdAt: { gte: since }, kind: { in: ["CHARGE", "TOPUP", "BONUS", "REFUND"] } },
    orderBy: { createdAt: "desc" },
    select: { kind: true, amount: true, createdAt: true, sendId: true },
  });
  const sent = new Map<string, { emails: number; amount: DeciCents }>();
  const out: ActivityRow[] = [];
  for (const r of rows) {
    const day = r.createdAt.toISOString().slice(0, 10);
    if (r.kind === "CHARGE" && r.sendId) {
      const s = sent.get(day) ?? { emails: 0, amount: 0n };
      s.emails++;
      s.amount += r.amount;
      sent.set(day, s);
    } else {
      out.push({ day, kind: r.kind === "TOPUP" ? "topup" : r.kind === "BONUS" ? "bonus" : r.kind === "REFUND" ? "refund" : "correction", emails: null, amount: (r.amount >= 0n ? "+" : "-") + formatUsd(r.amount >= 0n ? r.amount : -r.amount) });
    }
  }
  for (const [day, s] of sent) out.push({ day, kind: "sent", emails: s.emails, amount: "-" + formatUsd(-s.amount) });
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.kind === "sent" ? -1 : 1));
}
