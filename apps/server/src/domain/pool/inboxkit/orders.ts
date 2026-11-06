import type { Prisma, SupplierOrder, SupplierOrderItem } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { badRequest, conflict, notFound, unprocessable } from "../../../lib/errors.js";
import { logger } from "../../../lib/logger.js";
import { withLock } from "../../../lib/locks.js";
import { MAX_INBOXES_PER_DOMAIN, SENDS_PER_WARM_INBOX, WARMUP_DAYS_TO_ACTIVE } from "../../../config/plans.js";
import { SUPPLIER_WARMED_LADDER_DAY } from "../lifecycle.js";
import { account, domainAvailable, placeOrder, warmupPrice, type InboxKitCtx, type OrderDomain, type OrderItem } from "../../../integrations/inboxkit.js";
import { logSystem } from "../../systemLog.js";
import { WORKING_DAYS_PER_MONTH } from "../../usage.js";
import { REGION_TZ } from "../../sending/schedule.js";
import { transportRefFor } from "../../sending/transport/index.js";
import { GOOGLE_IMAP, GOOGLE_SMTP } from "../../../integrations/googleMail.js";
import { currentEwma, invalidateConsole, restockTargets } from "../metrics.js";
import { poolSettings } from "../settings.js";
import { generateNames } from "../names.js";
import { localPartFor, personasForDomain } from "../personas.js";
import { personaFor } from "../manual.js";
import { closeFilledReorders } from "../restock.js";
import { blockers, contactOf, inboxKitCtx, inboxKitKey, inboxKitSettings, INBOXKIT_PROVIDER, SUPPLIER, unitPrices } from "./settings.js";

/**
 * "Add new domains": the operator says how many, Aperture picks clean names, checks each one at InboxKit, plans three
 * personas per domain, prices the whole order, and after one confirmation orders it through InboxKit with InboxKit's
 * warmup on every mailbox.
 *
 * Never all at once. A large batch bought the same day, starting together, is what snowshoe detection looks for, so a
 * confirmed order is placed in batches of at most `maxBuyPerBatch` domains and `maxBuyPerDay` a day (Pool settings),
 * a few hours apart. The rest wait for the next day by themselves.
 *
 * Money is only ever spent by `placeBatch`, and every domain in it is claimed first (PENDING -> PLACING in one update),
 * so two runs can never order the same domain twice. A placement that gets no clear answer stays PLACING until the sync
 * finds the domain at InboxKit (then it is adopted), or 24 hours pass without it (then an operator is asked to check);
 * it is never sent again by itself.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const QUOTE_TTL = 30 * MIN;
/** Hours between two batches of one order on the same day. */
const BATCH_GAP = 3 * HOUR;
/** The most domains one quote checks at InboxKit (its availability check is limited to 50 calls a minute). */
export const MAX_PER_QUOTE = 50;
/**
 * A placement with no clear answer is never sent again by itself: buying twice costs real money every month. If the
 * domain hasn't shown up at InboxKit after this long, it is marked unconfirmed for an operator to check (and is still
 * adopted if it appears later).
 */
export const UNCONFIRMED_AFTER = 24 * HOUR;
export const UNCONFIRMED = "InboxKit never confirmed it";
/** Every placement holds this lock; longer than the slowest batch (a few availability checks plus a 2-minute order). */
const PLACE_LOCK_MS = 30 * MIN;
export const withPlaceLock = <T>(fn: () => Promise<T>) => withLock("inboxkit:place", PLACE_LOCK_MS, fn);
const ACTIVE = ["SCHEDULED", "WAITING_FOR_FUNDS"] as const;
/** InboxKit states of a domain that will never finish. */
export const DOMAIN_DEAD = ["payment_failed", "cancelled", "deleted", "refunded", "refunded_due_to_banned_keywords", "no_longer_available", "scheduled_for_deletion"];

export interface PlannedMailbox {
  email: string;
  firstName: string;
  lastName: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const nextUtcDay = (d: Date) => new Date(startOfUtcDay(d).getTime() + 24 * HOUR + 5 * MIN);

// ─── How many: the suggestion ───────────────────────────────────────────────────────────────────────────────────

/** Domains ordered today (or being ordered), counted against the daily limit. */
async function placedToday(now: Date): Promise<number> {
  return prisma.supplierOrderItem.count({ where: { OR: [{ status: "PLACED", placedAt: { gte: startOfUtcDay(now) } }, { status: "PLACING", placingAt: { gte: startOfUtcDay(now) } }] } });
}

/** Spare mailboxes kept on top of what customers have committed, so one bad week never leaves them short. */
export const SPARE_SHARE = 0.2;

/**
 * How many domains to order, worked out only from the pool's own numbers, every step shown on the screen:
 *
 *   needed      mailboxes for what launched customers committed      ceil(emails a day / 30)
 *   spare       20% on top of that                                   ceil(needed x 0.2)
 *   burns       mailboxes expected to burn before a new order sends  weekly burn (measured, EWMA) x weeks to send x 3
 *   have        mailboxes sending or ramping, plus every one already ordered and not yet sending
 *   order       needed + spare + burns - have, as domains of 3       ceil(max(0, ...) / 3)
 *
 * Nothing in it is a guess: with no burns measured yet, burns are 0 and the screen says so.
 */
export async function orderPlan(now = new Date()) {
  const [ewma, targets, ps, s, key, sending, onTheWay, pendingItems, today] = await Promise.all([
    currentEwma(now),
    restockTargets(),
    poolSettings(),
    inboxKitSettings(),
    inboxKitKey(),
    prisma.mailbox.count({ where: { organizationId: null, status: { in: ["ACTIVE", "WARMING"] }, sendingDomain: { status: { in: ["ACTIVE", "WARMING"] } } } }),
    // Bought and not sending yet: being set up, waiting for DNS, warming (InboxKit's or the quiet aging period).
    prisma.mailbox.count({
      where: { organizationId: null, status: { in: ["CREATING", "CONNECTING"] }, sendingDomain: { status: { in: ["REGISTERED", "AGING"] }, OR: [{ providerStatus: null }, { providerStatus: { notIn: DOMAIN_DEAD } }] } },
    }),
    // Confirmed in an order but not at InboxKit yet (or sent with no answer yet).
    prisma.supplierOrderItem.count({ where: { OR: [{ status: "PLACING" }, { status: "PENDING", order: { status: { in: [...ACTIVE] } } }] } }),
    placedToday(now),
  ]);
  const ordered = pendingItems * MAX_INBOXES_PER_DOMAIN;
  const needed = targets.committed > 0 ? Math.ceil(targets.committed / SENDS_PER_WARM_INBOX) : 0;
  const spare = Math.ceil(needed * SPARE_SHARE);
  const burnsPerWeek = Math.round(ewma * 100) / 100;
  // Weeks from ordering to full speed: about a day of setup, InboxKit's warmup, then the ramp (10, 20, 30 a day).
  const weeksToSend = Math.ceil((1 + s.warmupDays + (WARMUP_DAYS_TO_ACTIVE - SUPPLIER_WARMED_LADDER_DAY)) / 7);
  const burns = Math.ceil(burnsPerWeek * weeksToSend * MAX_INBOXES_PER_DOMAIN);
  const have = sending + onTheWay + ordered;
  const short = Math.max(0, needed + spare + burns - have);
  const domains = Math.ceil(short / MAX_INBOXES_PER_DOMAIN);
  return {
    suggested: { domains, mailboxes: domains * MAX_INBOXES_PER_DOMAIN },
    maths: {
      committedPerDay: targets.committed,
      perMailbox: SENDS_PER_WARM_INBOX,
      neededMailboxes: needed,
      spareShare: SPARE_SHARE,
      spareMailboxes: spare,
      weeklyBurnDomains: burnsPerWeek,
      weeksToSend,
      burnMailboxes: burns,
      sendingMailboxes: sending,
      onTheWayMailboxes: onTheWay,
      orderedMailboxes: ordered,
      haveMailboxes: have,
      shortMailboxes: short,
    },
    pool: { capacityPerDay: targets.capacityTotal, committedPerDay: targets.committed },
    limits: { perBatch: ps.maxBuyPerBatch, perDay: ps.maxBuyPerDay, placedToday: today, perQuote: MAX_PER_QUOTE },
    blockers: blockers(s, !!key.key),
  };
}

// ─── Quote ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every name the pool already has or has asked for, so a new order never repeats one. */
async function takenNames(): Promise<Set<string>> {
  const [domains, items] = await Promise.all([prisma.sendingDomain.findMany({ select: { name: true } }), prisma.supplierOrderItem.findMany({ where: { status: { not: "REJECTED" } }, select: { domainName: true } })]);
  return new Set([...domains.map((d) => d.name), ...items.map((i) => i.domainName)].map((n) => n.toLowerCase()));
}

/** Runs `fn` over `xs` with at most `n` at once, stopping early once `done()` says so. */
async function pooled<T>(xs: T[], n: number, done: () => boolean, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length && !done()) await fn(xs[i++]);
    }),
  );
}

/** A name Aperture will register: free, not banned, and at most the price limit to register and to renew. */
const usable = (a: { available: boolean; banned: boolean; registrationPrice: number | null; renewalPrice: number | null }, maxPrice: number) =>
  a.available && !a.banned && a.registrationPrice !== null && a.registrationPrice <= maxPrice && (a.renewalPrice ?? a.registrationPrice) <= maxPrice;

/** Clean, available names priced under the limit, checked one by one at InboxKit. */
async function findNames(ctx: InboxKitCtx, count: number, maxPrice: number, exclude: Set<string>, seed: number): Promise<{ name: string; price: number }[]> {
  const found: { name: string; price: number }[] = [];
  for (let round = 0; round < 3 && found.length < count; round++) {
    const candidates = generateNames((count - found.length) * 3, seed + round * 7919, exclude);
    for (const c of candidates) exclude.add(c);
    await pooled(candidates, 4, () => found.length >= count, async (name) => {
      try {
        const a = await domainAvailable(ctx, name);
        if (!usable(a, maxPrice)) return;
        if (found.length < count) found.push({ name, price: a.registrationPrice! });
      } catch (e) {
        logger.warn({ name, err: (e as Error).message }, "inboxkit: availability check failed");
      }
    });
  }
  return found;
}

/** Three different personas for a domain, as the mailboxes InboxKit will create on it. */
async function plannedMailboxes(domain: string, region: string, salt: number): Promise<PlannedMailbox[]> {
  const people = await personasForDomain(region, salt);
  return people.slice(0, MAX_INBOXES_PER_DOMAIN).map((p) => ({ email: `${localPartFor(p.firstName)}@${domain}`, firstName: p.firstName, lastName: p.lastName?.trim() || p.firstName }));
}

export interface Estimate {
  domains: number;
  mailboxes: number;
  domainsUsd: number;
  mailboxMonthUsd: number;
  warmupMonthUsd: number;
  firstMonthUsd: number;
  perMonthUsd: number;
  perEmailUsd: number | null;
  /** estimated: InboxKit didn't report the account's own mailbox or warmup price, so its published price is used. */
  unit: { mailboxMonthUsd: number | null; warmupMonthUsd: number | null; avgDomainUsd: number | null; estimated?: boolean };
  walletUsd: number | null;
  schedule: { day: string; domains: number }[];
}

/** How a confirmed order spreads over days, within the per-batch and per-day limits. */
export function scheduleFor(count: number, perDay: number, doneToday: number, now = new Date()): { day: string; domains: number }[] {
  const out: { day: string; domains: number }[] = [];
  let left = count;
  let day = startOfUtcDay(now);
  let room = Math.max(0, perDay - doneToday);
  while (left > 0 && out.length < 366) {
    const n = Math.min(left, room, Math.max(1, perDay));
    if (n > 0) out.push({ day: day.toISOString().slice(0, 10), domains: n });
    left -= n;
    day = new Date(day.getTime() + 24 * HOUR);
    room = perDay;
  }
  return out;
}

function estimateFor(items: { price: number }[], mailboxPrice: number, warmup: number, withWarmup: boolean, wallet: number | null, schedule: Estimate["schedule"], estimated: boolean): Estimate {
  const domains = items.length;
  const mailboxes = domains * MAX_INBOXES_PER_DOMAIN;
  const domainsUsd = round2(items.reduce((a, i) => a + i.price, 0));
  const mailboxMonthUsd = round2(mailboxes * mailboxPrice);
  const warmupMonthUsd = withWarmup ? round2(mailboxes * warmup) : 0;
  const perMonthUsd = round2(mailboxMonthUsd + warmupMonthUsd + domainsUsd / 12);
  const emailsPerMonth = mailboxes * SENDS_PER_WARM_INBOX * WORKING_DAYS_PER_MONTH;
  return {
    domains,
    mailboxes,
    domainsUsd,
    mailboxMonthUsd,
    warmupMonthUsd,
    firstMonthUsd: round2(domainsUsd + mailboxMonthUsd + warmupMonthUsd),
    perMonthUsd,
    perEmailUsd: emailsPerMonth ? Math.round((perMonthUsd / emailsPerMonth) * 100_000) / 100_000 : null,
    unit: { mailboxMonthUsd: mailboxPrice, warmupMonthUsd: withWarmup ? warmup : 0, avgDomainUsd: domains ? round2(domainsUsd / domains) : null, estimated },
    walletUsd: wallet,
    schedule,
  };
}

export interface QuoteInput {
  domains: number;
  region: string;
  locale: string;
}

/**
 * Prices an order without buying anything: names checked available at InboxKit, three mailboxes each, unit prices
 * from the InboxKit account. Valid for 30 minutes.
 */
export async function quoteOrder(input: QuoteInput, operatorId: string, now = new Date()) {
  const s = await inboxKitSettings();
  const missing = blockers(s, !!(await inboxKitKey()).key);
  if (missing.length) throw unprocessable("InboxKit isn't set up yet", { blockers: missing });
  if (input.domains < 1 || input.domains > MAX_PER_QUOTE) throw badRequest(`Ask for 1 to ${MAX_PER_QUOTE} domains at a time`);
  const ctx = await inboxKitCtx();
  const [acct, warmup, ps, today] = await Promise.all([account(ctx), warmupPrice(ctx).catch(() => null), poolSettings(), placedToday(now)]);
  const names = await findNames(ctx, input.domains, Number(s.maxDomainPriceUsd), await takenNames(), now.getTime());
  if (!names.length) throw unprocessable(`InboxKit had no clean names at up to $${Number(s.maxDomainPriceUsd).toFixed(2)} a year right now. Raise the price limit or try again.`);
  const items = [];
  for (const [i, n] of names.entries()) items.push({ ...n, mailboxes: await plannedMailboxes(n.name, input.region, now.getTime() % 9973 + i) });
  const unit = unitPrices(s.platform, acct, warmup);
  const estimate = estimateFor(items, unit.mailboxMonthUsd, unit.warmupMonthUsd, true, acct.creditsRemaining, scheduleFor(items.length, ps.maxBuyPerDay, today, now), unit.estimated);
  const order = await prisma.supplierOrder.create({
    data: {
      supplier: SUPPLIER,
      platform: s.platform,
      region: input.region,
      locale: input.locale,
      warmup: true,
      requested: items.length,
      estimate: estimate as unknown as Prisma.InputJsonValue,
      expiresAt: new Date(now.getTime() + QUOTE_TTL),
      createdById: operatorId,
      items: { create: items.map((i) => ({ domainName: i.name, priceUsd: i.price.toFixed(2), mailboxes: i.mailboxes as unknown as Prisma.InputJsonValue })) },
    },
    include: { items: true },
  });
  return orderView(order, { short: names.length < input.domains ? input.domains - names.length : 0 });
}

// ─── Confirm, cancel ────────────────────────────────────────────────────────────────────────────────────────────

export async function confirmOrder(id: string, operatorId: string, now = new Date()) {
  const o = await prisma.supplierOrder.findUnique({ where: { id } });
  if (!o) throw notFound("Order");
  if (o.status !== "QUOTED") throw conflict(`This order is already ${o.status.toLowerCase().replace(/_/g, " ")}`);
  if (o.expiresAt < now) {
    await prisma.supplierOrder.update({ where: { id }, data: { status: "EXPIRED" } });
    throw conflict("This price check is more than 30 minutes old. Check the price again.");
  }
  const r = await prisma.supplierOrder.updateMany({ where: { id, status: "QUOTED" }, data: { status: "SCHEDULED", confirmedById: operatorId, confirmedAt: now, nextRunAt: now } });
  if (!r.count) throw conflict("This order was just confirmed or cancelled");
  await logSystem(null, "INFO", "pool", `InboxKit order confirmed by an operator: ${o.requested} domain${o.requested === 1 ? "" : "s"} with ${o.requested * MAX_INBOXES_PER_DOMAIN} mailboxes and warmup.`, { orderId: id, operatorId });
  // Placed right away unless a batch is already being placed (then the next sync, within 10 minutes, places it).
  await withPlaceLock(() => placeDue(now, { orderId: id }));
  return getOrder(id);
}

/**
 * Stops the rest of an order. Takes the placement lock, so it never races a batch being placed; a domain already sent
 * to InboxKit with no answer yet is still adopted if InboxKit has it, and never sent again.
 */
export async function cancelOrder(id: string, operatorId: string) {
  const o = await prisma.supplierOrder.findUnique({ where: { id } });
  if (!o) throw notFound("Order");
  if (!["QUOTED", ...ACTIVE].includes(o.status)) throw conflict(`This order is already ${o.status.toLowerCase().replace(/_/g, " ")}`);
  const r = await withPlaceLock(async () => {
    const done = await prisma.supplierOrder.updateMany({ where: { id, status: { in: ["QUOTED", ...ACTIVE] } }, data: { status: "CANCELLED", nextRunAt: null } });
    if (!done.count) return null;
    return prisma.supplierOrderItem.updateMany({ where: { orderId: id, status: "PENDING" }, data: { status: "REJECTED", message: "Cancelled by an operator before it was ordered" } });
  });
  if (!r.ran) throw conflict("A batch of this order is being placed right now. Try again in a minute.");
  if (!r.result) throw conflict("This order just finished or was cancelled");
  await logSystem(null, "INFO", "pool", `InboxKit order cancelled by an operator; ${r.result.count} domain${r.result.count === 1 ? "" : "s"} not yet ordered won't be.`, { orderId: id, operatorId });
  return getOrder(id);
}

/** Order status writes from a batch: only while the order is still active, so a cancel always wins. */
const setActive = (id: string, data: Prisma.SupplierOrderUpdateManyMutationInput) => prisma.supplierOrder.updateMany({ where: { id, status: { in: [...ACTIVE] } }, data });

// ─── Placing batches ────────────────────────────────────────────────────────────────────────────────────────────

const mailboxesOf = (i: Pick<SupplierOrderItem, "mailboxes">) => i.mailboxes as unknown as PlannedMailbox[];

/** Claims one item for placing. Only the run that flips PENDING to PLACING may spend money on it. */
async function claim(itemId: string, now: Date): Promise<boolean> {
  const r = await prisma.supplierOrderItem.updateMany({ where: { id: itemId, status: "PENDING" }, data: { status: "PLACING", placingAt: now, attempts: { increment: 1 } } });
  return r.count === 1;
}

/** A domain InboxKit turned down for its name: a placeholder that gets a fresh name when its batch is placed. */
const PLACEHOLDER = "pending-replacement-";
const isPlaceholder = (name: string) => name.startsWith(PLACEHOLDER);

/** A name that went since the quote (or a placeholder) gets a fresh one, with the same people on it. */
async function refreshName(ctx: InboxKitCtx, item: SupplierOrderItem, maxPrice: number, now: Date): Promise<SupplierOrderItem | null> {
  if (!isPlaceholder(item.domainName)) {
    try {
      const a = await domainAvailable(ctx, item.domainName);
      if (usable(a, maxPrice)) return item;
    } catch {
      return item; // The check itself failed: let InboxKit decide.
    }
  }
  const [next] = await findNames(ctx, 1, maxPrice, await takenNames(), now.getTime() + item.attempts * 104_729);
  if (!next) return null;
  const people = mailboxesOf(item).map((m) => ({ ...m, email: `${m.email.split("@")[0]}@${next.name}` }));
  const why = isPlaceholder(item.domainName) ? (item.message ?? "Replacement name") : `Replaced ${item.domainName}, which was taken since the price check`;
  return prisma.supplierOrderItem.update({ where: { id: item.id }, data: { domainName: next.name, priceUsd: next.price.toFixed(2), mailboxes: people as unknown as Prisma.InputJsonValue, message: why } });
}

/** The pool rows for a domain InboxKit accepted: REGISTERED, mailboxes CREATING until InboxKit finishes them. */
export async function createPlacedDomain(item: SupplierOrderItem, order: Pick<SupplierOrder, "region" | "locale" | "platform" | "warmup">, now = new Date()): Promise<string> {
  const s = await inboxKitSettings();
  const existing = await prisma.sendingDomain.findFirst({ where: { organizationId: null, name: item.domainName }, select: { id: true } });
  const ms = order.platform === "MICROSOFT";
  const domainId =
    existing?.id ??
    (
      await prisma.sendingDomain.create({
        data: {
          organizationId: null,
          name: item.domainName,
          priceCents: Math.round(Number(item.priceUsd ?? 0) * 100),
          status: "REGISTERED",
          registrar: SUPPLIER,
          supplier: SUPPLIER,
          externalWarmup: order.warmup,
          warmupTargetDays: s.warmupDays,
          region: order.region,
          registeredAt: now,
          ...(ms ? {} : { dkimSelector: "google" }),
        },
      })
    ).id;
  for (const m of mailboxesOf(item)) {
    const address = m.email.toLowerCase();
    if (await prisma.mailbox.findFirst({ where: { address, status: { not: "RETIRED" } }, select: { id: true } })) {
      await logSystem(null, "WARN", "pool", `${address} was ordered at InboxKit but the address is already in the pool, so it isn't tracked. Cancel it in InboxKit.`, { itemId: item.id });
      continue;
    }
    await prisma.mailbox.create({
      data: {
        organizationId: null,
        sendingDomainId: domainId,
        address,
        firstName: m.firstName,
        lastName: m.lastName,
        fromNameDefault: `${m.firstName} ${m.lastName}`.trim(),
        personaId: await personaFor(m.firstName, m.lastName, order.locale),
        provider: INBOXKIT_PROVIDER,
        status: "CREATING",
        transportRef: transportRefFor(address),
        smtpHost: ms ? "smtp.office365.com" : GOOGLE_SMTP.host,
        smtpPort: ms ? 587 : GOOGLE_SMTP.port,
        imapHost: ms ? "outlook.office365.com" : GOOGLE_IMAP.host,
        imapPort: ms ? 993 : GOOGLE_IMAP.port,
        timezone: REGION_TZ[order.region] ?? "UTC",
        dailyLimit: SENDS_PER_WARM_INBOX,
      },
    });
  }
  await prisma.supplierOrderItem.update({ where: { id: item.id }, data: { sendingDomainId: domainId } });
  return domainId;
}

async function markPlaced(item: SupplierOrderItem, order: SupplierOrder, externalOrderId: string | null, now: Date): Promise<void> {
  const r = await prisma.supplierOrderItem.updateMany({ where: { id: item.id, status: "PLACING" }, data: { status: "PLACED", placedAt: now, externalOrderId, message: null } });
  if (r.count) await createPlacedDomain({ ...item, status: "PLACED" }, order, now);
}

const NAME_REJECTED = "Name not usable: ";

/**
 * InboxKit turned a domain down. When the name was the problem (taken, banned) a fresh name takes its place in a later
 * batch, at most as many times as the order has domains, so a run of bad names can never loop. Anything else is final.
 */
async function markRejected(item: SupplierOrderItem, order: SupplierOrder, why: Pick<OrderItem, "message" | "nameProblem">): Promise<void> {
  const text = (why.message ?? "InboxKit rejected it").slice(0, 250);
  await prisma.supplierOrderItem.update({ where: { id: item.id }, data: { status: "REJECTED", message: why.nameProblem ? `${NAME_REJECTED}${text}` : text } });
  if (!why.nameProblem) return;
  const live = await prisma.supplierOrder.findUnique({ where: { id: order.id }, select: { status: true } });
  if (!live || !(ACTIVE as readonly string[]).includes(live.status)) return;
  const nameRejections = await prisma.supplierOrderItem.count({ where: { orderId: order.id, status: "REJECTED", message: { startsWith: NAME_REJECTED } } });
  if (nameRejections > order.requested) return;
  await prisma.supplierOrderItem.create({ data: { orderId: order.id, domainName: `${PLACEHOLDER}${item.id}`, mailboxes: item.mailboxes as Prisma.InputJsonValue, status: "PENDING", message: `Replaces ${item.domainName}` } });
}

/** Order status once a batch is done: finished, or when the next batch may go. */
async function settle(orderId: string, now: Date, perDay: number): Promise<void> {
  const items = await prisma.supplierOrderItem.groupBy({ by: ["status"], where: { orderId }, _count: { _all: true } });
  const n = (s: string) => items.find((i) => i.status === s)?._count._all ?? 0;
  const o = await prisma.supplierOrder.findUniqueOrThrow({ where: { id: orderId } });
  if (!(ACTIVE as readonly string[]).includes(o.status)) return;
  if (!n("PENDING") && !n("PLACING")) {
    const status = n("REJECTED") ? (n("PLACED") ? "PARTIAL" : "FAILED") : "DONE";
    await setActive(orderId, { status, nextRunAt: null });
    await logSystem(null, status === "DONE" ? "INFO" : "WARN", "pool", `InboxKit order finished: ${n("PLACED")} domain${n("PLACED") === 1 ? "" : "s"} ordered${n("REJECTED") ? `, ${n("REJECTED")} rejected` : ""}.`, { orderId });
    return;
  }
  if (o.status === "WAITING_FOR_FUNDS") return;
  const quotaLeft = perDay - (await placedToday(now));
  await setActive(orderId, { nextRunAt: quotaLeft > 0 ? new Date(now.getTime() + BATCH_GAP) : nextUtcDay(now) });
}

/**
 * Places the next batch of one order. Returns how many domains InboxKit queued. Never more than the per-batch limit
 * or what is left of today's limit.
 */
export async function placeBatch(orderId: string, now = new Date()): Promise<{ placed: number; rejected: number; waiting?: string }> {
  const order = await prisma.supplierOrder.findUniqueOrThrow({ where: { id: orderId } });
  if (!["SCHEDULED", "WAITING_FOR_FUNDS"].includes(order.status)) return { placed: 0, rejected: 0 };
  const [ps, s, today] = await Promise.all([poolSettings(), inboxKitSettings(), placedToday(now)]);
  const room = Math.min(ps.maxBuyPerBatch, ps.maxBuyPerDay - today);
  if (room <= 0) {
    await setActive(orderId, { nextRunAt: nextUtcDay(now) });
    return { placed: 0, rejected: 0, waiting: "today's limit is used" };
  }
  const { contact, missing } = contactOf(s);
  if (!contact || !s.redirectUrl) {
    await setActive(orderId, { lastError: `InboxKit setup is incomplete (${missing.join(", ") || "redirect URL"})`, nextRunAt: new Date(now.getTime() + HOUR) });
    return { placed: 0, rejected: 0, waiting: "setup incomplete" };
  }
  const ctx = await inboxKitCtx();
  const candidates = await prisma.supplierOrderItem.findMany({ where: { orderId, status: "PENDING" }, orderBy: { createdAt: "asc" }, take: room });
  const claimed: SupplierOrderItem[] = [];
  for (const c of candidates) if (await claim(c.id, now)) claimed.push(c);
  if (!claimed.length) return { placed: 0, rejected: 0 };

  // Fresh names for taken ones (and for replacement placeholders), before any money moves.
  const batch: SupplierOrderItem[] = [];
  for (const c of claimed) {
    const it = await refreshName(ctx, c, Number(s.maxDomainPriceUsd), now);
    if (it) batch.push(it);
    else await prisma.supplierOrderItem.update({ where: { id: c.id }, data: { status: "REJECTED", message: "No clean replacement name was available" } });
  }
  if (!batch.length) {
    await settle(orderId, now, ps.maxBuyPerDay);
    return { placed: 0, rejected: claimed.length };
  }

  // Cancelled while names were being checked: nothing is sent, and the claimed domains are released as cancelled.
  const still = await prisma.supplierOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
  if (!(ACTIVE as readonly string[]).includes(still.status)) {
    await prisma.supplierOrderItem.updateMany({ where: { id: { in: batch.map((b) => b.id) }, status: "PLACING" }, data: { status: "REJECTED", message: "Cancelled by an operator before it was ordered" } });
    return { placed: 0, rejected: 0, waiting: "cancelled" };
  }

  const platform = order.platform === "MICROSOFT" ? "MICROSOFT" : "GOOGLE";
  const domains: OrderDomain[] = batch.map((i) => ({ name: i.domainName, redirect_url: s.redirectUrl!, registration_years: 1, mailboxes: mailboxesOf(i).map((m) => ({ email: m.email, first_name: m.firstName, last_name: m.lastName, platform })) }));
  const outcome = await placeOrder(ctx, { contact, domains, warmup: order.warmup });

  let placed = 0;
  let rejected = 0;
  if (outcome.kind === "unknown") {
    // Leave them PLACING: the sync adopts any that show up at InboxKit and never sends them again (see reconcilePlacing).
    await setActive(orderId, { lastError: `No clear answer from InboxKit (${outcome.message}). Aperture adopts these domains as soon as InboxKit shows them and never orders them again by itself.`, nextRunAt: new Date(now.getTime() + 30 * MIN) });
    await logSystem(null, "WARN", "pool", `InboxKit order: no clear answer for ${batch.length} domain${batch.length === 1 ? "" : "s"} (${outcome.message}). They are adopted when InboxKit shows them and never sent again, so nothing is bought twice.`, { orderId });
    return { placed: 0, rejected: 0, waiting: "unknown outcome" };
  }
  const byName = new Map(outcome.items.map((x) => [x.domain, x]));
  if (outcome.kind === "refused" && !outcome.items.some((x) => x.domain)) {
    // The whole request was refused (wallet, validation, rate limit): nothing was bought.
    await prisma.supplierOrderItem.updateMany({ where: { id: { in: batch.map((b) => b.id) }, status: "PLACING" }, data: { status: "PENDING", placingAt: null } });
    const funds = outcome.status === 402;
    const message = funds
      ? `The InboxKit wallet has $${(outcome.availableCredits ?? 0).toFixed(2)}; this batch needs $${(outcome.totalCost ?? 0).toFixed(2)}. Top up InboxKit and it carries on by itself.`
      : `InboxKit refused the batch: ${outcome.message}`;
    const wasWaiting = order.status === "WAITING_FOR_FUNDS";
    await setActive(orderId, { status: funds ? "WAITING_FOR_FUNDS" : "SCHEDULED", lastError: message, nextRunAt: new Date(now.getTime() + HOUR) });
    if (!(funds && wasWaiting)) await logSystem(null, funds ? "CRITICAL" : "ERROR", "pool", `InboxKit order paused: ${message}`, { orderId });
    return { placed: 0, rejected: 0, waiting: message };
  }
  const refused = outcome.kind === "refused";
  for (const it of batch) {
    const res = byName.get(it.domainName);
    if (!res) {
      // Not in InboxKit's answer: left PLACING, adopted if it shows up, never sent again.
      continue;
    }
    if (res.queued && !refused) {
      await markPlaced(it, order, res.orderId, now);
      placed++;
    } else if (!res.queued && (res.message || res.nameProblem)) {
      await markRejected(it, order, res);
      rejected++;
    } else {
      // A refused request bought nothing: this one goes back to wait for the next batch.
      await prisma.supplierOrderItem.updateMany({ where: { id: it.id, status: "PLACING" }, data: { status: "PENDING", placingAt: null } });
    }
  }
  await setActive(orderId, { status: "SCHEDULED", lastError: rejected ? `${rejected} domain${rejected === 1 ? "" : "s"} rejected by InboxKit` : refused ? `InboxKit refused part of the batch: ${outcome.message}` : null });
  await settle(orderId, now, ps.maxBuyPerDay);
  if (placed) {
    await closeFilledReorders();
    await invalidateConsole();
    await logSystem(null, "INFO", "pool", `InboxKit ordered ${placed} domain${placed === 1 ? "" : "s"} with ${placed * MAX_INBOXES_PER_DOMAIN} mailboxes and warmup: ${batch.filter((b) => byName.get(b.domainName)?.queued).map((b) => b.domainName).join(", ")}.`, { orderId });
  }
  return { placed, rejected };
}

/** Every order whose next batch is due. Called by the sync job and right after a confirmation. */
export async function placeDue(now = new Date(), opts: { orderId?: string } = {}): Promise<{ orders: number; placed: number; rejected: number }> {
  const due = await prisma.supplierOrder.findMany({
    where: { status: { in: ["SCHEDULED", "WAITING_FOR_FUNDS"] }, nextRunAt: { lte: now }, ...(opts.orderId ? { id: opts.orderId } : {}) },
    orderBy: { confirmedAt: "asc" },
    select: { id: true },
  });
  let placed = 0;
  let rejected = 0;
  for (const o of due) {
    try {
      const r = await placeBatch(o.id, now);
      placed += r.placed;
      rejected += r.rejected;
    } catch (e) {
      logger.error({ orderId: o.id, err: (e as Error).message }, "inboxkit: placing a batch failed");
      await prisma.supplierOrder.update({ where: { id: o.id }, data: { lastError: (e as Error).message.slice(0, 300), nextRunAt: new Date(now.getTime() + HOUR) } }).catch(() => undefined);
    }
  }
  return { orders: due.length, placed, rejected };
}

/**
 * Domains sent with no clear answer: adopted the moment InboxKit shows them (also when that is days later), and marked
 * unconfirmed for an operator after 24 hours without them. They are never sent again by Aperture: a duplicate order is
 * a domain and three mailboxes billed every month for nothing. `known` is every domain name InboxKit has, from its
 * domain and mailbox lists.
 */
export async function reconcilePlacing(known: Set<string>, now = new Date()): Promise<{ adopted: number; unconfirmed: number }> {
  const items = await prisma.supplierOrderItem.findMany({
    where: { OR: [{ status: "PLACING", placingAt: { lt: new Date(now.getTime() - 10 * MIN) } }, { status: "REJECTED", message: { startsWith: UNCONFIRMED } }] },
    include: { order: true },
  });
  let adopted = 0;
  let unconfirmed = 0;
  for (const it of items) {
    if (known.has(it.domainName)) {
      const r = await prisma.supplierOrderItem.updateMany({ where: { id: it.id, status: it.status }, data: { status: "PLACED", placedAt: now, message: it.status === "REJECTED" ? "Found at InboxKit after all and adopted" : null } });
      if (r.count) {
        await createPlacedDomain({ ...it, status: "PLACED" }, it.order, now);
        adopted++;
        await settle(it.orderId, now, (await poolSettings()).maxBuyPerDay);
      }
    } else if (it.status === "PLACING" && it.placingAt && now.getTime() - it.placingAt.getTime() > UNCONFIRMED_AFTER) {
      const r = await prisma.supplierOrderItem.updateMany({ where: { id: it.id, status: "PLACING" }, data: { status: "REJECTED", message: `${UNCONFIRMED} within 24 hours. Check your InboxKit account: if it is there, Aperture adopts it by itself; Aperture never orders it again.` } });
      if (r.count) {
        unconfirmed++;
        await logSystem(null, "ERROR", "pool", `InboxKit never confirmed the order for ${it.domainName}. Check your InboxKit account; if it was bought, Aperture adopts it as soon as InboxKit lists it. It will not be ordered again.`, { itemId: it.id, orderId: it.orderId });
        await settle(it.orderId, now, (await poolSettings()).maxBuyPerDay);
      }
    }
  }
  return { adopted, unconfirmed };
}

/** A domain marked ordered whose pool rows never got written (a crash in between): writes them now. */
export async function repairPlaced(now = new Date()): Promise<number> {
  const orphans = await prisma.supplierOrderItem.findMany({ where: { status: "PLACED", sendingDomainId: null }, include: { order: true } });
  for (const it of orphans) await createPlacedDomain(it, it.order, now);
  return orphans.length;
}

// ─── Views ──────────────────────────────────────────────────────────────────────────────────────────────────────

type OrderWithItems = SupplierOrder & { items: SupplierOrderItem[] };

export function orderView(o: OrderWithItems, extra: { short?: number } = {}) {
  const count = (s: string) => o.items.filter((i) => i.status === s).length;
  return {
    id: o.id,
    status: o.status,
    platform: o.platform,
    region: o.region,
    requested: o.requested,
    placed: count("PLACED"),
    pending: count("PENDING") + count("PLACING"),
    rejected: count("REJECTED"),
    estimate: o.estimate as unknown as Estimate,
    lastError: o.lastError,
    nextRunAt: o.nextRunAt,
    expiresAt: o.expiresAt,
    confirmedAt: o.confirmedAt,
    createdAt: o.createdAt,
    short: extra.short ?? 0,
    items: o.items
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((i) => ({ id: i.id, domain: isPlaceholder(i.domainName) ? null : i.domainName, priceUsd: i.priceUsd === null ? null : Number(i.priceUsd), status: i.status, message: i.message, mailboxes: mailboxesOf(i).map((m) => ({ email: isPlaceholder(i.domainName) ? null : m.email, name: `${m.firstName} ${m.lastName}` })), placedAt: i.placedAt })),
  };
}

export async function getOrder(id: string) {
  const o = await prisma.supplierOrder.findUnique({ where: { id }, include: { items: true } });
  if (!o) throw notFound("Order");
  return orderView(o);
}

export async function listOrders(limit = 20) {
  const rows = await prisma.supplierOrder.findMany({ where: { status: { notIn: ["QUOTED", "EXPIRED"] } }, orderBy: { createdAt: "desc" }, take: limit, include: { items: true } });
  return rows.map((o) => orderView(o));
}

/** Old unconfirmed quotes are marked expired so they never confuse anyone. */
export async function expireQuotes(now = new Date()): Promise<number> {
  const old = await prisma.supplierOrder.findMany({ where: { status: "QUOTED", expiresAt: { lt: now } }, select: { id: true } });
  if (!old.length) return 0;
  const ids = old.map((o) => o.id);
  await prisma.supplierOrder.updateMany({ where: { id: { in: ids }, status: "QUOTED" }, data: { status: "EXPIRED" } });
  // Their names are free again for the next price check.
  await prisma.supplierOrderItem.updateMany({ where: { orderId: { in: ids }, status: "PENDING" }, data: { status: "REJECTED", message: "Price check expired" } });
  return old.length;
}
