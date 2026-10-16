import type { Catalogue } from "@/lib/types";

/**
 * Display helpers only. Prices, email counts and durations all come from the API (`catalogue.volume.stops`,
 * `catalogue.budget.stops`, `/billing/topup-options`); nothing here works one out.
 */

/** Outreach runs about 22 working days a month: the same month the server prices. */
export const WORK_DAYS = 22;

const DOLLAR = 1000n;

export const toDc = (s: string | null | undefined) => {
  try {
    return BigInt(s || "0");
  } catch {
    return 0n;
  }
};

/** "$20" for whole dollars, "$20.50" otherwise, from deci-cents the server sent. */
export function usd(dc: bigint | string): string {
  const d = typeof dc === "string" ? toDc(dc) : dc;
  const cents = d / 10n;
  const whole = (cents / 100n).toLocaleString("en-US");
  return cents % 100n === 0n ? `$${whole}` : `$${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** The dashboard budget presets, as the server lists them. */
export const presets = (cat: Pick<Catalogue, "budget">) => cat.budget.presetsDeciCents.map(toDc);

export const monthsTxt = (m: number) => (m >= 24 ? "24+ months" : m < 1 ? "Under a month" : `${m < 10 ? m.toFixed(1) : Math.round(m)} months`);

/** Dollars a person typed ("40", "$40", "40.50") as deci-cents, or null. The server checks the amount. */
export function parseDollars(input: string): bigint | null {
  const m = input.trim().replace(/[$,\s]/g, "").match(/^(\d{1,6})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return BigInt(m[1]) * DOLLAR + BigInt((m[2] ?? "").padEnd(2, "0") || "0") * 10n;
}
