export function dateKeyInTz(tz: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function dayOfWeekInTz(tz: string, at: Date = new Date()): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(at);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

export function hourInTz(tz: string, at: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(at));
}

function tzOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - instant.getTime();
}

export function tzMidnightUtc(dayKey: string, tz: string): Date {
  const guess = new Date(`${dayKey}T00:00:00Z`);
  return new Date(guess.getTime() - tzOffsetMs(guess, tz));
}

export function dateOnly(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00Z`);
}

export function dayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(dayKey: string, days: number): string {
  const d = dateOnly(dayKey);
  d.setUTCDate(d.getUTCDate() + days);
  return dayKeyOf(d);
}

export function mondayOf(dayKey: string): string {
  const dow = dateOnly(dayKey).getUTCDay();
  return addDays(dayKey, dow === 0 ? -6 : 1 - dow);
}

export function nextMondayOf(dayKey: string): string {
  return addDays(mondayOf(dayKey), 7);
}

export function workdaysLeft(weekStart: string, dayKey: string): number {
  if (dayKey < weekStart) return 5;
  const friday = addDays(weekStart, 4);
  if (dayKey > friday) return 0;
  const dow = dateOnly(dayKey).getUTCDay();
  return Math.max(0, 5 - (dow - 1));
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function minutesInTz(tz: string, at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

const hhmm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (Number.isFinite(h) ? h : 9) * 60 + (Number.isFinite(m) ? m : 0);
};

/**
 * Where we are in a sending window ("09:00" to "17:00", Monday to Friday, in the customer's time zone). `fraction`
 * is how much of today's window has passed, so a day's emails are spread across it instead of going in one burst.
 */
export function sendingWindow(tz: string, start: string, end: string, at: Date = new Date()): { open: boolean; fraction: number } {
  const dow = dayOfWeekInTz(tz, at);
  if (dow === 0 || dow === 6) return { open: false, fraction: 0 };
  const now = minutesInTz(tz, at);
  const a = hhmm(start);
  const b = hhmm(end);
  if (b <= a || now < a || now >= b) return { open: false, fraction: now >= b ? 1 : 0 };
  return { open: true, fraction: (now - a + 30) / (b - a) };
}
