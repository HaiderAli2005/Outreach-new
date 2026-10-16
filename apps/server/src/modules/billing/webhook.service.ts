import type Stripe from "stripe";
import type { PaymentStatus, Prisma } from "@prisma/client";
import { prisma, isUniqueViolation } from "../../lib/prisma.js";
import { badRequest } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { logSystem } from "../../domain/systemLog.js";
import { webhookVerifier } from "./stripe.client.js";
import { credit, debitCorrection } from "../../domain/credits/index.js";
import { formatUsd, fromStripeCents, parseDeciCents } from "../../domain/money.js";
import { FREE_TRIAL_DECICENTS } from "../../config/plans.js";
import { notifyOwners } from "../../domain/sending/health.js";
import { authenticationNeeded, disableAutoReload } from "./autoReload.js";

export function verifyStripeEvent(rawBody: Buffer | undefined, signature: string | undefined): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) throw badRequest("Stripe webhook secret is not configured");
  if (!rawBody || !signature) throw badRequest("Missing Stripe signature");
  try {
    return webhookVerifier().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw badRequest("Invalid Stripe signature");
  }
}

async function orgForCustomer(customer: string | { id: string } | null | undefined): Promise<string | null> {
  const id = typeof customer === "string" ? customer : customer?.id;
  if (!id) return null;
  const org = await prisma.organization.findUnique({ where: { stripeCustomerId: id }, select: { id: true } });
  return org?.id ?? null;
}

async function upsertPayment(pi: Stripe.PaymentIntent, status: PaymentStatus): Promise<void> {
  const orgId = await orgForCustomer(pi.customer as string);
  if (!orgId) return;
  const data = {
    amountCents: pi.amount,
    currency: pi.currency,
    status,
    failureMessage: pi.last_payment_error?.message?.slice(0, 500) ?? null,
    description: pi.description ?? null,
  };
  await prisma.payment.upsert({ where: { stripePaymentIntentId: pi.id }, create: { organizationId: orgId, stripePaymentIntentId: pi.id, ...data }, update: data });
}

/**
 * A prepaid top-up cleared: the balance moves now. Idempotent on the PaymentIntent id, so a repeated event never
 * credits twice. The amount credited is what Stripe actually collected.
 */
export async function onTopupSucceeded(pi: Stripe.PaymentIntent): Promise<void> {
  if (pi.metadata?.kind !== "topup") return;
  const orgId = pi.metadata.organizationId || (await orgForCustomer(pi.customer as string));
  if (!orgId) return;
  const asked = parseDeciCents(pi.metadata.deciCents);
  const received = fromStripeCents(pi.amount_received || pi.amount);
  const amount = asked !== null && asked <= received ? asked : received;
  const note = pi.metadata.source === "auto_reload" ? `Auto top-up ${formatUsd(amount)}` : `Top-up ${formatUsd(amount)}`;
  const r = await credit(orgId, "TOPUP", amount, { ref: pi.id, note });
  if (r.ok && !r.duplicate) await logSystem(orgId, "INFO", "billing", `Added ${formatUsd(amount)} in credits.`);
}

async function onChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!piId) return;
  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: piId } });
  if (!payment) return;
  const refunded = charge.amount_refunded ?? 0;
  await prisma.payment.update({
    where: { id: payment.id },
    data: { amountRefundedCents: refunded, status: refunded >= payment.amountCents ? "REFUNDED" : refunded > 0 ? "PARTIALLY_REFUNDED" : payment.status },
  });
  await prisma.refund.updateMany({ where: { paymentId: payment.id, status: "pending" }, data: { status: "succeeded" } });
  // Money paid back for a top-up comes off the balance, as far as it is still unspent.
  const newly = refunded - payment.amountRefundedCents;
  if (newly > 0) {
    const r = await debitCorrection(payment.organizationId, fromStripeCents(newly), `top-up refunded (${charge.id})`);
    if (!r.ok) await logSystem(payment.organizationId, "WARN", "billing", `A refund of ${formatUsd(fromStripeCents(newly))} was larger than the unspent balance: ${r.reason}.`);
  }
}

/** A failed card is shown to the customer and never retried. A failed auto-reload also switches auto-reload off. */
async function onPaymentFailed(pi: Stripe.PaymentIntent): Promise<void> {
  if (pi.metadata?.source !== "auto_reload") return;
  const payer = pi.metadata.organizationId || (await orgForCustomer(pi.customer as string));
  if (!payer) return;
  const amount = parseDeciCents(pi.metadata.deciCents) ?? fromStripeCents(pi.amount);
  if (pi.last_payment_error?.code === "authentication_required") await authenticationNeeded(payer, amount, pi.id);
  else if (await disableAutoReload(payer, pi.last_payment_error?.message ?? "the card was declined")) {
    await notifyOwners(payer, "Auto-reload failed and is now off", `Your ${formatUsd(amount)} auto-reload did not go through (${pi.last_payment_error?.message ?? "the card was declined"}). Auto-reload is now off and will not try again. Top up from Credits whenever you like.`);
  }
}

/** An off-session auto-reload needs the customer to authenticate: switch it off and email them a link. */
async function onRequiresAction(pi: Stripe.PaymentIntent): Promise<void> {
  if (pi.metadata?.source !== "auto_reload") return;
  const payer = pi.metadata.organizationId || (await orgForCustomer(pi.customer as string));
  if (!payer) return;
  await authenticationNeeded(payer, parseDeciCents(pi.metadata.deciCents) ?? fromStripeCents(pi.amount), pi.id);
}

async function paymentForDispute(dispute: Stripe.Dispute) {
  const piId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  return piId ? prisma.payment.findUnique({ where: { stripePaymentIntentId: piId } }) : null;
}

/**
 * A chargeback: the money is already gone and the bank is deciding. The disputed amount comes off the unspent
 * balance, auto-reload goes off and new sending pauses at once. Either it is fraud or a very unhappy customer, and in
 * both cases more email from our domains is the wrong move.
 */
async function onDisputeOpened(dispute: Stripe.Dispute): Promise<void> {
  const payment = await paymentForDispute(dispute);
  if (!payment) return;
  const org = payment.organizationId;
  await prisma.payment.update({ where: { id: payment.id }, data: { status: "DISPUTED" } });
  const r = await debitCorrection(org, fromStripeCents(dispute.amount), `disputed (${dispute.id})`);
  if (!r.ok) await logSystem(org, "WARN", "billing", `The disputed ${formatUsd(fromStripeCents(dispute.amount))} was more than the unspent balance: ${r.reason}.`);
  await disableAutoReload(org, "a payment was disputed");
  const reason = `A payment was disputed (${dispute.id}).`;
  await prisma.customerHealth.upsert({
    where: { organizationId: org },
    create: { organizationId: org, status: "PAUSED", pausedAt: new Date(), pausedReason: reason },
    update: { status: "PAUSED", pausedAt: new Date(), pausedReason: reason },
  });
  await logSystem(org, "CRITICAL", "billing", `Chargeback opened: ${formatUsd(fromStripeCents(dispute.amount))}. New sending is paused.`);
}

/** Won: the money comes back to the balance and sending resumes. Lost: it stays as it is. */
async function onDisputeClosed(dispute: Stripe.Dispute): Promise<void> {
  const payment = await paymentForDispute(dispute);
  if (!payment) return;
  const org = payment.organizationId;
  if (dispute.status !== "won") {
    await logSystem(org, "WARN", "billing", `Chargeback closed as ${dispute.status}.`);
    return;
  }
  await prisma.payment.update({ where: { id: payment.id }, data: { status: "SUCCEEDED" } });
  await credit(org, "REFUND", fromStripeCents(dispute.amount), { ref: `dispute-won:${dispute.id}`, note: `Dispute won (${dispute.id})` });
  await prisma.customerHealth.updateMany({ where: { organizationId: org, status: "PAUSED", pausedReason: { startsWith: "A payment was disputed" } }, data: { status: "OK", unpausedAt: new Date(), unpauseReason: "dispute won" } });
  await logSystem(org, "INFO", "billing", "Chargeback won. The amount is back in the balance and sending resumed.");
}

/**
 * A card was saved without being charged. A card added at setup (or from Credits) unlocks the free credit, once:
 * the ledger ref `trial:<payer>` makes a repeat delivery a no-op. An auto-reload consent needs nothing here; the
 * settings change that switches auto-reload on checks it with Stripe.
 */
async function onSetupSucceeded(si: Stripe.SetupIntent): Promise<void> {
  if (si.metadata?.kind !== "onboarding_card") return;
  const payer = si.metadata.organizationId || (await orgForCustomer(si.customer as string));
  if (!payer) return;
  const r = await credit(payer, "BONUS", FREE_TRIAL_DECICENTS, { ref: `trial:${payer}`, note: "Free credit for adding a card" });
  if (r.ok && !r.duplicate) await logSystem(payer, "INFO", "billing", `Card added. ${formatUsd(FREE_TRIAL_DECICENTS)} of free credit is in your balance; nothing was charged.`);
}

async function onSetupFailed(si: Stripe.SetupIntent): Promise<void> {
  const payer = si.metadata?.organizationId || (await orgForCustomer(si.customer as string));
  if (payer) await logSystem(payer, "WARN", "billing", `A card could not be saved: ${si.last_setup_error?.message ?? "it was declined"}.`);
}

/** Nine events, and nothing about subscriptions or invoices: Aperture has neither. */
export async function dispatchStripeEvent(event: Stripe.Event): Promise<boolean> {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      await upsertPayment(pi, "SUCCEEDED");
      await onTopupSucceeded(pi);
      return true;
    }
    case "payment_intent.payment_failed":
      await upsertPayment(event.data.object as Stripe.PaymentIntent, "FAILED");
      await onPaymentFailed(event.data.object as Stripe.PaymentIntent);
      return true;
    case "payment_intent.requires_action":
      await upsertPayment(event.data.object as Stripe.PaymentIntent, "REQUIRES_PAYMENT");
      await onRequiresAction(event.data.object as Stripe.PaymentIntent);
      return true;
    case "setup_intent.succeeded":
      await onSetupSucceeded(event.data.object as Stripe.SetupIntent);
      return true;
    case "setup_intent.setup_failed":
      await onSetupFailed(event.data.object as Stripe.SetupIntent);
      return true;
    case "payment_intent.processing":
      await upsertPayment(event.data.object as Stripe.PaymentIntent, "PROCESSING");
      return true;
    case "charge.refunded":
      await onChargeRefunded(event.data.object as Stripe.Charge);
      return true;
    case "charge.dispute.created":
      await onDisputeOpened(event.data.object as Stripe.Dispute);
      return true;
    case "charge.dispute.closed":
      await onDisputeClosed(event.data.object as Stripe.Dispute);
      return true;
    default:
      return false;
  }
}

export async function handleStripeWebhook(event: Stripe.Event): Promise<{ duplicate: boolean }> {
  const key = { provider_externalId: { provider: "STRIPE" as const, externalId: event.id } };
  let row = await prisma.webhookEvent.findUnique({ where: key });
  if (row && row.status !== "FAILED") return { duplicate: true };
  if (!row) {
    try {
      row = await prisma.webhookEvent.create({
        data: { provider: "STRIPE", externalId: event.id, type: event.type, payload: event as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { duplicate: true };
      throw err;
    }
  }
  try {
    const handled = await dispatchStripeEvent(event);
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: handled ? "PROCESSED" : "IGNORED", processedAt: new Date(), error: null } });
    return { duplicate: false };
  } catch (err) {
    logger.error({ err, eventId: event.id, type: event.type }, "stripe webhook failed");
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 1000) } });
    throw err;
  }
}
