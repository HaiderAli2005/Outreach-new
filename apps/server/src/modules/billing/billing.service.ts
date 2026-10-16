import { prisma } from "../../lib/prisma.js";
import { conflict, notFound, unprocessable } from "../../lib/errors.js";
import { env, features } from "../../config/env.js";
import { requireStripe, getStripe } from "./stripe.client.js";
import type Stripe from "stripe";
import { emailsFor, formatUsd, lastsText, MIN_TOPUP, toStripeCents, topupOptions, validateTopup, type DeciCents } from "../../domain/money.js";
import { BUDGET_DEFAULT_DECICENTS, BUDGET_MAX_DECICENTS, BUDGET_MIN_DECICENTS } from "../../config/plans.js";
import { getSettings } from "../../domain/settings.js";
import { activity, balanceOf, balanceView, customerOf, releaseForContact } from "../../domain/credits/index.js";
import { DELIVERED_OR_BOUNCED } from "../../domain/pool/lifecycle.js";
import { logSystem } from "../../domain/systemLog.js";
import { disableAutoReload } from "./autoReload.js";

export function billingConfig() {
  return { enabled: features.stripe && !!env.STRIPE_PUBLISHABLE_KEY, publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null };
}

export async function ensureCustomer(orgId: string, email: string): Promise<string> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  if (org.stripeCustomerId) return org.stripeCustomerId;
  const stripe = requireStripe();
  const customer = await stripe.customers.create({ email, name: org.name, metadata: { organizationId: orgId } }, { idempotencyKey: `org:${orgId}:customer` });
  await prisma.organization.update({ where: { id: orgId }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

/**
 * The suggested top-ups for the customer's daily budget (or a budget being chosen during setup), worked out here so
 * the client never does money arithmetic.
 */
export async function topupOptionsFor(orgId: string, budget?: DeciCents | null) {
  let b = budget ?? null;
  if (b === null || b < BUDGET_MIN_DECICENTS || b > BUDGET_MAX_DECICENTS) {
    const saved = (await getSettings(orgId)).dailyBudgetDecicents;
    b = saved !== null && saved > 0n ? saved : BUDGET_DEFAULT_DECICENTS;
  }
  const balance = await balanceOf(await customerOf(orgId));
  const emails = emailsFor(b);
  const daily = formatUsd(b).replace(/\.00$/, "");
  return {
    dailyBudget: b.toString(),
    emailsPerDay: emails,
    // The sentence that turns four amounts into an obvious choice.
    lead: `${emails.toLocaleString("en-US")} emails a day costs ${daily} a day. How long do you want to run?`,
    balance: formatUsd(balance),
    balanceLasts: lastsText(balance, b),
    minTopup: formatUsd(MIN_TOPUP),
    options: topupOptions(b),
  };
}

/**
 * Starts a prepaid top-up. The card is charged now, while the customer is here (no postpaid balance, and a failed
 * card is never retried later behind their back). The balance moves when Stripe confirms the payment.
 */
export async function startTopup(orgId: string, email: string, amount: DeciCents, idempotencyKey: string, opts: { savedCard?: boolean } = {}) {
  const problem = validateTopup(amount);
  if (problem) throw unprocessable(problem);
  const payer = await customerOf(orgId);
  const stripe = requireStripe();
  const customerId = await ensureCustomer(payer, email);
  if (opts.savedCard) return payWithSavedCard(stripe, payer, customerId, amount, idempotencyKey);
  const settings = await prisma.orgSettings.findUnique({ where: { organizationId: payer }, select: { autoReloadEnabled: true, autoReloadMandateAcceptedAt: true } });
  const pi = await stripe.paymentIntents.create(
    {
      amount: toStripeCents(amount),
      currency: "usd",
      customer: customerId,
      // "off_session" only when the customer has switched auto-reload on and accepted its mandate. Otherwise the card
      // is remembered for a top-up they make themselves, and can never be charged without them present.
      setup_future_usage: settings?.autoReloadEnabled && settings.autoReloadMandateAcceptedAt ? "off_session" : "on_session",
      automatic_payment_methods: { enabled: true },
      description: `Aperture credits ${formatUsd(amount)}`,
      metadata: { organizationId: payer, kind: "topup", source: "manual", deciCents: amount.toString() },
    },
    { idempotencyKey: `topup:${idempotencyKey}` },
  );
  if (!pi.client_secret) throw unprocessable("Stripe did not return a payment to confirm");
  return { paymentIntentId: pi.id, clientSecret: pi.client_secret, amount: formatUsd(amount) };
}

/**
 * One click, on the card already saved: the customer is here and pressed Pay, so the payment is confirmed now
 * (on-session). A bank that wants to check (3-D Secure) returns "requires_action" and the page shows its check; a
 * declined card is said in plain words. The balance still moves only when Stripe confirms the payment.
 */
async function payWithSavedCard(stripe: Stripe, payer: string, customerId: string, amount: DeciCents, idempotencyKey: string) {
  const pm = (await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 })).data[0];
  if (!pm) throw unprocessable("There's no saved card yet. Add a card first.");
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: toStripeCents(amount),
        currency: "usd",
        customer: customerId,
        payment_method: pm.id,
        payment_method_types: ["card"],
        confirm: true,
        description: `Aperture credits ${formatUsd(amount)}`,
        metadata: { organizationId: payer, kind: "topup", source: "saved_card", deciCents: amount.toString() },
      },
      { idempotencyKey: `topup-saved:${idempotencyKey}` },
    );
    if (!pi.client_secret) throw unprocessable("Stripe did not return a payment to confirm");
    return { paymentIntentId: pi.id, clientSecret: pi.client_secret, amount: formatUsd(amount), status: pi.status };
  } catch (err) {
    const e = err as { type?: string; message?: string };
    if (e?.type === "StripeCardError") throw unprocessable(`Your card was declined: ${(e.message ?? "try another card").replace(/\.$/, "")}. Try again, or use a different card.`);
    throw err;
  }
}

/** The saved card as the customer knows it ("Visa ending 4242"), or null. */
export async function savedCard(orgId: string): Promise<{ brand: string; last4: string } | null> {
  const stripe = getStripe();
  const org = await prisma.organization.findUnique({ where: { id: await customerOf(orgId) }, select: { stripeCustomerId: true } });
  if (!stripe || !org?.stripeCustomerId) return null;
  try {
    const pm = (await stripe.paymentMethods.list({ customer: org.stripeCustomerId, limit: 1 })).data[0];
    if (!pm) return null;
    const brand = pm.card?.brand ?? "card";
    return { brand: brand === "amex" ? "Amex" : brand.charAt(0).toUpperCase() + brand.slice(1), last4: pm.card?.last4 ?? "" };
  } catch {
    return null;
  }
}

/**
 * Saves a card without taking money (a SetupIntent), confirmed in the page with Stripe Elements.
 *
 *   card          step 6 of setup, or adding a card from Credits. usage "on_session": the card may be charged only
 *                 while the customer is here and presses a button. When it succeeds, the webhook adds the free credit.
 *   auto_reload   the separate, explicit consent to off-session charges, asked for only when the customer switches
 *                 auto-reload on. usage "off_session", on the card already saved.
 */
export async function startSetup(orgId: string, email: string, purpose: "card" | "auto_reload", idempotencyKey: string) {
  const payer = await customerOf(orgId);
  const stripe = requireStripe();
  const customerId = await ensureCustomer(payer, email);
  if (purpose === "card") {
    const si = await stripe.setupIntents.create(
      { customer: customerId, usage: "on_session", automatic_payment_methods: { enabled: true }, metadata: { organizationId: payer, kind: "onboarding_card" } },
      { idempotencyKey: `setup:${payer}:${idempotencyKey}` },
    );
    if (!si.client_secret) throw unprocessable("Stripe did not return a card form to confirm");
    return { setupIntentId: si.id, clientSecret: si.client_secret, paymentMethodId: null };
  }
  const pms = await stripe.paymentMethods.list({ customer: customerId, limit: 1 });
  const pm = pms.data[0];
  if (!pm) throw unprocessable("Add a card first. Auto-reload charges the card you saved.");
  const si = await stripe.setupIntents.create(
    { customer: customerId, payment_method: pm.id, usage: "off_session", payment_method_types: ["card"], metadata: { organizationId: payer, kind: "auto_reload_mandate" } },
    { idempotencyKey: `setup-reload:${payer}:${idempotencyKey}` },
  );
  if (!si.client_secret) throw unprocessable("Stripe did not return a confirmation to complete");
  return { setupIntentId: si.id, clientSecret: si.client_secret, paymentMethodId: pm.id };
}

/** True when this SetupIntent is the customer's own, succeeded, and consents to off-session charges. */
export async function isOffSessionConsent(orgId: string, setupIntentId: string): Promise<boolean> {
  if (!/^seti_[A-Za-z0-9_]{6,80}$/.test(setupIntentId)) return false;
  const payer = await customerOf(orgId);
  const si = await requireStripe().setupIntents.retrieve(setupIntentId);
  return si.status === "succeeded" && si.usage === "off_session" && si.metadata?.organizationId === payer && si.metadata?.kind === "auto_reload_mandate";
}

async function sendingHealth(orgId: string) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [h, delivered, hard, soft, replies] = await Promise.all([
    prisma.customerHealth.findUnique({ where: { organizationId: orgId } }),
    prisma.send.count({ where: { organizationId: orgId, sentAt: { gte: since }, status: { in: ["SENT", "DELIVERED"] } } }),
    prisma.send.count({ where: { organizationId: orgId, sentAt: { gte: since }, status: { in: ["HARD_BOUNCE", "COMPLAINT"] } } }),
    prisma.send.count({ where: { organizationId: orgId, sentAt: { gte: since }, status: "SOFT_BOUNCE" } }),
    prisma.contact.count({ where: { organizationId: orgId, repliedAt: { gte: since } } }),
  ]);
  const total = await prisma.send.count({ where: { organizationId: orgId, sentAt: { gte: since }, status: { in: [...DELIVERED_OR_BOUNCED] } } });
  const status = h?.status ?? "OK";
  return {
    status,
    label: status === "PAUSED" ? "Paused" : status === "WARNING" ? "Watch" : "Good",
    bounceRate: total ? `${((hard / total) * 100).toFixed(1)}%` : "0.0%",
    delivered,
    bounced: hard + soft,
    replies,
    pausedReason: status === "PAUSED" ? (h?.pausedReason ?? null) : null,
  };
}

export async function hasCard(orgId: string): Promise<boolean> {
  const stripe = getStripe();
  const org = await prisma.organization.findUnique({ where: { id: await customerOf(orgId) }, select: { stripeCustomerId: true } });
  if (!stripe || !org?.stripeCustomerId) return false;
  try {
    const pms = await stripe.paymentMethods.list({ customer: org.stripeCustomerId, limit: 1 });
    return pms.data.length > 0;
  } catch {
    return false;
  }
}

/** Everything the credits panel shows. */
export async function creditsPanel(orgId: string) {
  const payer = await customerOf(orgId);
  const [balance, rows, health, card, trial] = await Promise.all([
    balanceView(orgId),
    activity(orgId),
    sendingHealth(orgId),
    savedCard(orgId),
    prisma.creditLedger.findUnique({ where: { kind_stripeRef: { kind: "BONUS", stripeRef: `trial:${payer}` } }, select: { id: true } }),
  ]);
  return { ...balance, health, activity: rows, hasCard: !!card, card, trialAvailable: !trial, minTopup: formatUsd(MIN_TOPUP) };
}

/** Removes every saved card and switches auto-reload off with it. Top-ups after this ask for a card again. */
export async function removeCard(orgId: string) {
  const stripe = requireStripe();
  const payer = await customerOf(orgId);
  await disableAutoReload(payer, "the saved card was removed");
  const org = await prisma.organization.findUnique({ where: { id: payer }, select: { stripeCustomerId: true } });
  if (!org?.stripeCustomerId) return { removed: 0 };
  const pms = await stripe.paymentMethods.list({ customer: org.stripeCustomerId, limit: 20 });
  for (const pm of pms.data) await stripe.paymentMethods.detach(pm.id);
  return { removed: pms.data.length };
}

/**
 * Closes the account from the credits screen, no support ticket needed: sending stops, held money goes back to
 * the balance, saved cards are removed and the workspace is closed.
 */
export async function closeAccount(orgId: string, userId: string, confirm: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, status: true, primaryDomain: true } });
  if (!org) throw notFound("Organization");
  if (org.status !== "ACTIVE") throw conflict("This workspace is already deleted");
  const typed = confirm.trim().toLowerCase();
  if (typed !== org.name.trim().toLowerCase() && typed !== (org.primaryDomain ?? "").toLowerCase()) throw unprocessable("Type the workspace name or its website to confirm");
  await prisma.orgSettings.updateMany({ where: { organizationId: orgId }, data: { autopilotEnabled: false } });
  await disableAutoReload(await customerOf(orgId), "the account was closed");
  await prisma.campaign.updateMany({ where: { organizationId: orgId, status: "ACTIVE" }, data: { status: "PAUSED" } });
  const held = await prisma.creditReservation.findMany({ where: { organizationId: await customerOf(orgId), status: "OPEN", contactId: { not: null } }, select: { contactId: true } });
  for (const r of held) await releaseForContact(r.contactId!, "Account closed");
  if (getStripe()) await removeCard(orgId).catch(() => undefined);
  await prisma.organization.update({ where: { id: orgId }, data: { status: "SUSPENDED" } });
  await logSystem(orgId, "INFO", "billing", "Account closed by its owner. Sending stopped and saved cards were removed.", { userId });
  return { closed: true };
}

export function listPayments(orgId: string, { skip, take }: { skip: number; take: number }) {
  return Promise.all([
    prisma.payment.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" }, skip, take, include: { refunds: true } }),
    prisma.payment.count({ where: { organizationId: orgId } }),
  ]);
}

export async function refundPayment(paymentId: string, amountCents: number | undefined, reason: string | undefined, adminId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw notFound("Payment");
  if (!["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(payment.status)) throw unprocessable("Only successful payments can be refunded");
  const refundable = payment.amountCents - payment.amountRefundedCents;
  const amount = amountCents ?? refundable;
  if (amount <= 0 || amount > refundable) throw unprocessable(`You can refund up to ${(refundable / 100).toFixed(2)}`);
  const refund = await requireStripe().refunds.create(
    { payment_intent: payment.stripePaymentIntentId, amount, reason: "requested_by_customer", metadata: { note: reason ?? "", adminId } },
    { idempotencyKey: `refund:${payment.id}:${payment.amountRefundedCents}:${amount}` },
  );
  return prisma.refund.upsert({
    where: { stripeRefundId: refund.id },
    create: { paymentId: payment.id, stripeRefundId: refund.id, amountCents: amount, reason: reason ?? null, status: refund.status ?? "pending", createdById: adminId },
    update: { status: refund.status ?? "pending" },
  });
}

/**
 * An auto-reload the bank wants the customer to approve (3-D Secure). The customer opens the link we emailed and
 * confirms it in the page; only their own workspace's payments, and only ones still waiting, are returned.
 */
export async function paymentToConfirm(orgId: string, paymentIntentId: string) {
  if (!/^pi_[A-Za-z0-9_]{6,80}$/.test(paymentIntentId)) throw notFound("Payment");
  const payer = await customerOf(orgId);
  const pi = await requireStripe().paymentIntents.retrieve(paymentIntentId);
  if (pi.metadata?.organizationId !== payer || pi.metadata?.kind !== "topup") throw notFound("Payment");
  if (pi.status === "succeeded") return { status: "succeeded" as const, amount: formatUsd(BigInt(pi.amount) * 10n) };
  if (pi.status !== "requires_action" && pi.status !== "requires_payment_method" && pi.status !== "requires_confirmation") throw conflict("This payment can no longer be confirmed");
  const pm = typeof pi.payment_method === "string" ? pi.payment_method : (pi.payment_method?.id ?? pi.last_payment_error?.payment_method?.id ?? null);
  return { status: "needs_confirmation" as const, clientSecret: pi.client_secret, paymentMethodId: pm, amount: formatUsd(BigInt(pi.amount) * 10n) };
}
