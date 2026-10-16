/**
 * Money. Every amount in Aperture is a bigint count of deci-cents (tenths of a US cent). Floats never hold money.
 *
 *   1 deci-cent = $0.001     $1.00 = 1000     $25.00 = 25000
 *   every email sent = 40 ($0.04): first email, follow-up or reply alike
 *
 * Balances, prices, reservations and ledger rows are all deci-cents. They become a display string only at the API
 * boundary, with formatUsd.
 */
export type DeciCents = bigint;

/**
 * One price for every email. A flat price is what makes every figure in the product exact: $20 a day is 500 emails,
 * a $140 top-up is 3,500 emails, whoever replies, bounces or finishes the sequence.
 */
export const PRICE_PER_EMAIL: DeciCents = 40n; // $0.04
/**
 * The reply reserve. Cold email (first emails and follow-ups) never spends the last $2 of a balance; that money is
 * kept for replies in live conversations, so a deal never dies mid-thread because the credit ran out. Replies
 * themselves cost the same $0.04 and can spend down to zero.
 */
export const REPLY_RESERVE: DeciCents = 2_000n; // $2.00
/** Emails in a full sequence: the first email and three follow-ups (days 0, 3, 7 and 14). */
export const SEQUENCE_EMAILS = 4;

export const DOLLAR: DeciCents = 1_000n;
/** Top-ups: whole dollars, at least $25, at most $10,000 (a fraud brake; above that an operator handles it). */
export const MIN_TOPUP: DeciCents = 25_000n; // $25
export const MAX_TOPUP: DeciCents = 10_000_000n; // $10,000

/** The server is the authority on a top-up amount. Three rules, not a list. Null when the amount is fine. */
export function validateTopup(amount: DeciCents): string | null {
  if (amount % DOLLAR !== 0n) return "Top-ups are in whole dollars";
  if (amount < MIN_TOPUP) return `The smallest top-up is ${formatUsd(MIN_TOPUP)}`;
  if (amount > MAX_TOPUP) return `For more than ${formatUsd(MAX_TOPUP)}, contact us`;
  return null;
}

/**
 * Sending days a suggested top-up lasts at the daily budget. One definition everywhere: a week is 5 sending days and
 * a month is 22, the same month the setup step prices.
 */
export const TOPUP_DAYS = [1, 3, 5, 22] as const;
const DAY_LABELS: Record<number, string> = { 1: "1 day", 3: "3 days", 5: "1 week", 22: "1 month" };

/**
 * The suggested top-ups for a daily budget: budget x {1, 3, 5, 22} sending days, rounded up to the next $5, never
 * under $25. When the $25 floor makes a card last longer than its label, it is labelled with the days it really
 * lasts. Amounts that land on the same figure merge. Because every email costs the same, `emails` is exact.
 * At $20 a day: $25, $60, $100, $440.
 */
export function topupOptions(dailyBudget: DeciCents) {
  const out: { days: number; label: string; deciCents: string; amount: string; emails: number; people: number; recommended: boolean }[] = [];
  for (const d of TOPUP_DAYS) {
    const raw = dailyBudget * BigInt(d);
    const rounded = ((raw + 4_999n) / 5_000n) * 5_000n;
    const amount = rounded < MIN_TOPUP ? MIN_TOPUP : rounded;
    const lasts = dailyBudget > 0n ? Number(amount / dailyBudget) : d;
    const days = lasts > d ? lasts : d;
    if (out.some((o) => o.deciCents === amount.toString())) continue;
    const emails = emailsFor(amount);
    out.push({ days, label: days === d ? DAY_LABELS[d] : `${days} days`, deciCents: amount.toString(), amount: formatUsd(amount).replace(/\.00$/, ""), emails, people: peopleFor(emails), recommended: d === 5 });
  }
  return out;
}

/** "about half a day", "about 3 days": how long a balance lasts at a daily budget, in sending days. */
export function lastsText(balance: DeciCents, dailyBudget: DeciCents | null): string | null {
  if (dailyBudget === null || dailyBudget <= 0n) return null;
  const d = Number(balance) / Number(dailyBudget);
  if (d <= 0) return "nothing left";
  if (d < 0.35) return "less than half a day";
  if (d < 0.75) return "about half a day";
  if (d < 1.5) return "about a day";
  return `about ${Math.round(d)} days`;
}


/** Emails a sum of money pays for. Exact, because every email costs the same. */
export function emailsFor(amount: DeciCents): number {
  return amount <= 0n ? 0 : Number(amount / PRICE_PER_EMAIL);
}

/** New people a day (or a top-up) reaches: each person gets a 4-email sequence. */
export function peopleFor(emails: number): number {
  return Math.floor(emails / SEQUENCE_EMAILS);
}

/** "$47.20". Rounds down to the cent, so a balance is never shown as more than it is. */
export function formatUsd(d: DeciCents): string {
  const neg = d < 0n;
  const cents = (neg ? -d : d) / 10n;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${whole.toLocaleString("en-US")}.${frac}`;
}

/** Deci-cents to Stripe's integer cents. Top-ups are whole cents, so this is exact for them. */
export function toStripeCents(d: DeciCents): number {
  if (d % 10n !== 0n) throw new Error("Amount is not a whole number of cents");
  return Number(d / 10n);
}

export function fromStripeCents(cents: number): DeciCents {
  return BigInt(Math.round(cents)) * 10n;
}

/** Parses a decimal string from the API ("25000") into deci-cents, rejecting anything that isn't a whole number. */
export function parseDeciCents(v: unknown): DeciCents | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d{1,15}$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

/** A unit price, which can need a tenth of a cent: 5n would be "$0.005". */
export function formatPrice(d: DeciCents): string {
  if (d % 10n === 0n) return formatUsd(d);
  const neg = d < 0n;
  const v = neg ? -d : d;
  return `${neg ? "-" : ""}$${(v / 1000n).toString()}.${(v % 1000n).toString().padStart(3, "0")}`;
}
