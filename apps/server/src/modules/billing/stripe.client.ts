import Stripe from "stripe";
import { env } from "../../config/env.js";
import { notConfigured } from "../../lib/errors.js";

export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

let override: Stripe | null | undefined;
let cached: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (override !== undefined) return override;
  if (cached === undefined)
    cached = env.STRIPE_SECRET_KEY
      ? new Stripe(env.STRIPE_SECRET_KEY, {
          // Pinned to the version this SDK release is typed against, so a dependency bump can't silently change
          // API behaviour. Upgrade both together, deliberately.
          apiVersion: STRIPE_API_VERSION,
          maxNetworkRetries: 2,
          appInfo: { name: "Aperture" },
        })
      : null;
  return cached;
}

export function requireStripe(): Stripe {
  const s = getStripe();
  if (!s) throw notConfigured("Billing (STRIPE_SECRET_KEY)");
  return s;
}

export function setStripeClient(client: Stripe | null | undefined): void {
  override = client;
}

/** Signature checking is pure crypto and needs no live key, so webhooks are testable without one. */
let verifier: Stripe | null = null;
export function webhookVerifier(): Stripe {
  verifier ??= new Stripe(env.STRIPE_SECRET_KEY ?? "sk_test_webhook_verification_only");
  return verifier;
}
