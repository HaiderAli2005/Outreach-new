export const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

export const n0 = (n: number | null | undefined) => Math.round(Number(n ?? 0)).toLocaleString("en-US");

export function money(cents: number | null | undefined, opts: { exact?: boolean } = {}): string {
  const v = Number(cents ?? 0) / 100;
  const frac = opts.exact || v % 1 ? 2 : 0;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: 2 });
}

export function dateShort(d: string | Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function dateLong(d: string | Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function dateTime(d: string | Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function daysFromNow(days: number): string {
  const x = new Date();
  x.setDate(x.getDate() + days);
  return dateShort(x);
}

export function ago(d: string | Date | null | undefined): string {
  if (!d) return "";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return dateShort(d);
}

export function initials(name: string | null | undefined, fallback = "?"): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback;
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function normDomain(v: string): string {
  return (v || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/)[0];
}

export function validDomain(d: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,24})+$/.test(d);
}

export function brandOf(domain: string): string {
  const base = domain.split(".")[0] ?? domain;
  return base
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const REPLY_LABEL: Record<string, string> = {
  hot: "Interested",
  question: "Question",
  review: "Needs review",
  curious: "Curious",
  not_now: "Later",
  away: "Away",
  referral: "Referral",
  not_interested: "Not interested",
  stop: "Unsubscribe",
  frustrated: "Frustrated",
  auto: "Auto reply",
  moved: "Moved on",
  deceased: "Closed",
};

export const REPLY_TONE: Record<string, "g" | "b" | "v" | "y" | "r"> = {
  hot: "g",
  question: "b",
  review: "y",
  curious: "b",
  not_now: "y",
  away: "v",
  referral: "v",
  not_interested: "r",
  stop: "r",
  frustrated: "r",
  auto: "v",
  moved: "v",
  deceased: "r",
};

export const titleCase = (s: string) => s.toLowerCase().replace(/(^|_|\s)(\w)/g, (_m, p, c: string) => (p ? " " : "") + c.toUpperCase());

/** "2:14pm", in `tz` or the viewer's own zone. */
export function clock(d: string | Date, tz?: string): string {
  return new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).replace(/\s?([AP])M$/i, (_m, x: string) => `${x.toLowerCase()}m`);
}

const dayKey = (d: Date, tz?: string) => d.toLocaleDateString("en-CA", { timeZone: tz });

/** "2:14pm", "tomorrow 9:05am" or "Thu 9:05am", relative to today where the viewer (or `tz`) is. */
export function when(d: string | Date, tz?: string, now = new Date()): string {
  const at = new Date(d);
  const t = clock(at, tz);
  if (dayKey(at, tz) === dayKey(now, tz)) return t;
  if (dayKey(at, tz) === dayKey(new Date(now.getTime() + 86_400_000), tz)) return `tomorrow ${t}`;
  return `${at.toLocaleDateString("en-US", { weekday: "short", timeZone: tz })} ${t}`;
}

/** "Today", "Tomorrow" or "Monday" for a moment, read in `tz`. */
export function dayName(d: string | Date, tz?: string, now = new Date()): string {
  const at = new Date(d);
  if (dayKey(at, tz) === dayKey(now, tz)) return "Today";
  if (dayKey(at, tz) === dayKey(new Date(now.getTime() + 86_400_000), tz)) return "Tomorrow";
  return at.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
}

/** "New York" from "America/New_York". */
export const placeOf = (tz: string) => (tz.split("/").pop() ?? tz).replace(/_/g, " ");

/** A daily email volume as its daily budget: every email is $0.04, so 100 a day is $4. */
export const dollarsOf = (emails: number) => (emails * 4) / 100;
/** "$4", "$10", "$200": the budget for a daily email volume. */
export const budgetOf = (emails: number) => `$${dollarsOf(emails).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
