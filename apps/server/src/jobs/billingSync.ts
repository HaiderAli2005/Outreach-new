import type Stripe from "stripe";
import { getStripe } from "../modules/billing/stripe.client.js";
import { handleStripeWebhook } from "../modules/billing/webhook.service.js";

/**
 * Catches top-ups (and cards saved at setup) whose webhook never arrived: every succeeded payment from the last three days is replayed. Credits
 * are idempotent on the PaymentIntent id, so one already counted is never counted twice. Each replay goes through
 * handleStripeWebhook, so it writes a WebhookEvent row and a failure is recorded instead of swallowed.
 */
export async function runBillingSyncJob() {
  const stripe = getStripe();
  if (!stripe) return { skipped: "stripe-not-configured" };
  const since = Math.floor(Date.now() / 1000) - 3 * 86_400;
  let replayed = 0;
  let failed = 0;
  for await (const pi of stripe.paymentIntents.list({ created: { gte: since }, limit: 100 })) {
    if (pi.status !== "succeeded" || pi.metadata?.kind !== "topup") continue;
    try {
      await handleStripeWebhook({ id: `sync_${pi.id}`, type: "payment_intent.succeeded", data: { object: pi } } as unknown as Stripe.Event);
      replayed++;
    } catch {
      failed++;
    }
  }
  // Cards saved at setup: the free credit they unlock, if that webhook was missed too.
  for await (const si of stripe.setupIntents.list({ created: { gte: since }, limit: 100 })) {
    if (si.status !== "succeeded" || si.metadata?.kind !== "onboarding_card") continue;
    try {
      await handleStripeWebhook({ id: `sync_${si.id}`, type: "setup_intent.succeeded", data: { object: si } } as unknown as Stripe.Event);
      replayed++;
    } catch {
      failed++;
    }
  }
  return { replayed, failed };
}
