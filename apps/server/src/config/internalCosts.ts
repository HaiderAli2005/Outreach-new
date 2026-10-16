import { env } from "./env.js";

/**
 * INTERNAL COST TRACKING ONLY.
 *
 * What Aperture pays its suppliers for sending infrastructure. These numbers feed the ops console's margin view and
 * the parked branded-domain flow. They must never be shown to a customer and must never be used to price anything a
 * customer buys. Customers pay per email sent (see config/plans.ts), nothing else.
 */
export const INBOX_PRICE_CENTS = 400; // per mailbox per month
export const REPLIES_ONLY_INBOX_PRICE_CENTS = 300; // a quiet mailbox still billed until it is retired

/** Yearly registration per top-level domain. */
export const TLD_PRICES_CENTS: Record<string, number> = {
  ".com": 1499,
  ".co": 2499,
  ".io": 3499,
  ".net": 1599,
};

export function tldPriceCents(domain: string): number | null {
  const tld = domain.slice(domain.indexOf("."));
  return TLD_PRICES_CENTS[tld] ?? null;
}

/** USD per 1M tokens. */
export interface TokenPrice {
  input: number;
  cachedInput: number;
  output: number;
}

/** Supplier prices that change, so they are settings (CostSettings) with these as the starting values. */
export interface CostPrices {
  /** Keyed by model name prefix; "default" for any model not listed. */
  aiPrices: Record<string, TokenPrice>;
  apolloPerEnrichUsd: number;
  apolloPerSearchUsd: number;
  verifyPerEmailUsd: number;
  paymentFeePercent: number;
  paymentFeeFixedUsd: number;
  /** Per mailbox per month while it sends. */
  mailboxMonthUsd: number;
  /** Per burned (replies-only) mailbox per month, billed until it retires. */
  repliesOnlyMailboxMonthUsd: number;
  /** Registration per domain per year. */
  domainYearUsd: number;
}

export const DEFAULT_COST_PRICES: CostPrices = {
  aiPrices: {
    "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
    "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
    default: { input: 2, cachedInput: 0.5, output: 8 },
  },
  apolloPerEnrichUsd: 0.03,
  apolloPerSearchUsd: 0,
  verifyPerEmailUsd: 0.0006,
  paymentFeePercent: 2.9,
  paymentFeeFixedUsd: 0.3,
  mailboxMonthUsd: INBOX_PRICE_CENTS / 100,
  repliesOnlyMailboxMonthUsd: REPLIES_ONLY_INBOX_PRICE_CENTS / 100,
  domainYearUsd: 15,
};

/** The price for a model: the longest listed prefix of its name ("gpt-4.1-mini-2025-04-14" uses "gpt-4.1-mini"). */
export function tokenPriceFor(model: string, prices: Record<string, TokenPrice>): TokenPrice {
  const key = Object.keys(prices)
    .filter((k) => k !== "default" && model.toLowerCase().startsWith(k.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  return prices[key ?? "default"] ?? DEFAULT_COST_PRICES.aiPrices.default;
}

/** What one AI call cost, from the tokens it really used. Cached input tokens are part of the input count. */
export function aiCallUsd(model: string, t: { inputTokens: number; cachedInputTokens: number; outputTokens: number }, prices: Record<string, TokenPrice>): number {
  const p = tokenPriceFor(model, prices);
  const fresh = Math.max(0, t.inputTokens - t.cachedInputTokens);
  return (fresh * p.input + t.cachedInputTokens * p.cachedInput + t.outputTokens * p.output) / 1_000_000;
}
