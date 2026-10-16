import type { Contact, OrgSettings } from "@prisma/client";
import { addDays, dateKeyInTz, dayOfWeekInTz, isValidTimeZone, minutesInTz, tzMidnightUtc } from "../../lib/time.js";

/**
 * When an email goes out. Everything here is in the PROSPECT's local time: a customer in Lahore writing to people in
 * California wants 9am Pacific, not 9am Pakistan. Each email gets a random minute inside the window on a sending
 * day, so a day's sends are spread out with uneven gaps instead of firing together at 09:00:00 (a bulk-send
 * signature).
 */

const US_STATES: Record<string, string> = {};
const zone = (tz: string, names: string[]) => names.forEach((n) => (US_STATES[n.toLowerCase()] = tz));
zone("America/Los_Angeles", ["California", "CA", "Washington", "WA", "Oregon", "OR", "Nevada", "NV"]);
zone("America/Denver", ["Colorado", "CO", "Utah", "UT", "New Mexico", "NM", "Wyoming", "WY", "Montana", "MT", "Idaho", "ID"]);
zone("America/Phoenix", ["Arizona", "AZ"]);
zone("America/Chicago", [
  "Texas", "TX", "Illinois", "IL", "Minnesota", "MN", "Wisconsin", "WI", "Missouri", "MO", "Iowa", "IA", "Kansas", "KS", "Nebraska", "NE",
  "Oklahoma", "OK", "Louisiana", "LA", "Arkansas", "AR", "Mississippi", "MS", "Alabama", "AL", "Tennessee", "TN", "North Dakota", "ND", "South Dakota", "SD",
]);
zone("America/New_York", [
  "New York", "NY", "Massachusetts", "MA", "Pennsylvania", "PA", "New Jersey", "NJ", "Florida", "FL", "Georgia", "GA", "Virginia", "VA", "North Carolina", "NC",
  "South Carolina", "SC", "Ohio", "OH", "Michigan", "MI", "Maryland", "MD", "Connecticut", "CT", "Delaware", "DE", "District of Columbia", "DC", "Maine", "ME",
  "New Hampshire", "NH", "Vermont", "VT", "Rhode Island", "RI", "West Virginia", "WV", "Kentucky", "KY", "Indiana", "IN",
]);
zone("America/Anchorage", ["Alaska", "AK"]);
zone("Pacific/Honolulu", ["Hawaii", "HI"]);

const REGIONS_CA: Record<string, string> = {
  "british columbia": "America/Vancouver", alberta: "America/Edmonton", saskatchewan: "America/Regina", manitoba: "America/Winnipeg",
  ontario: "America/Toronto", quebec: "America/Toronto", "nova scotia": "America/Halifax", "new brunswick": "America/Halifax", newfoundland: "America/St_Johns",
};
const REGIONS_AU: Record<string, string> = {
  "new south wales": "Australia/Sydney", victoria: "Australia/Melbourne", queensland: "Australia/Brisbane", "western australia": "Australia/Perth",
  "south australia": "Australia/Adelaide", tasmania: "Australia/Hobart", "australian capital territory": "Australia/Sydney", "northern territory": "Australia/Darwin",
};

const COUNTRIES: Record<string, string> = {
  "united states": "America/New_York", usa: "America/New_York", us: "America/New_York", "united kingdom": "Europe/London", uk: "Europe/London", england: "Europe/London",
  scotland: "Europe/London", wales: "Europe/London", ireland: "Europe/Dublin", canada: "America/Toronto", australia: "Australia/Sydney", "new zealand": "Pacific/Auckland",
  germany: "Europe/Berlin", france: "Europe/Paris", spain: "Europe/Madrid", portugal: "Europe/Lisbon", italy: "Europe/Rome", netherlands: "Europe/Amsterdam",
  belgium: "Europe/Brussels", switzerland: "Europe/Zurich", austria: "Europe/Vienna", sweden: "Europe/Stockholm", norway: "Europe/Oslo", denmark: "Europe/Copenhagen",
  finland: "Europe/Helsinki", poland: "Europe/Warsaw", czechia: "Europe/Prague", "czech republic": "Europe/Prague", hungary: "Europe/Budapest", romania: "Europe/Bucharest",
  greece: "Europe/Athens", turkey: "Europe/Istanbul", türkiye: "Europe/Istanbul", ukraine: "Europe/Kyiv", russia: "Europe/Moscow", israel: "Asia/Jerusalem",
  "united arab emirates": "Asia/Dubai", uae: "Asia/Dubai", "saudi arabia": "Asia/Riyadh", qatar: "Asia/Qatar", kuwait: "Asia/Kuwait", bahrain: "Asia/Bahrain",
  oman: "Asia/Muscat", egypt: "Africa/Cairo", jordan: "Asia/Amman", pakistan: "Asia/Karachi", india: "Asia/Kolkata", bangladesh: "Asia/Dhaka",
  "sri lanka": "Asia/Colombo", nepal: "Asia/Kathmandu", singapore: "Asia/Singapore", malaysia: "Asia/Kuala_Lumpur", indonesia: "Asia/Jakarta",
  philippines: "Asia/Manila", thailand: "Asia/Bangkok", vietnam: "Asia/Ho_Chi_Minh", "hong kong": "Asia/Hong_Kong", china: "Asia/Shanghai", taiwan: "Asia/Taipei",
  japan: "Asia/Tokyo", "south korea": "Asia/Seoul", korea: "Asia/Seoul", "south africa": "Africa/Johannesburg", nigeria: "Africa/Lagos", kenya: "Africa/Nairobi",
  morocco: "Africa/Casablanca", brazil: "America/Sao_Paulo", mexico: "America/Mexico_City", argentina: "America/Argentina/Buenos_Aires", chile: "America/Santiago",
  colombia: "America/Bogota", peru: "America/Lima",
};

/** The market a workspace sells into, as a fallback zone when a person's own location says nothing. */
export const REGION_TZ: Record<string, string> = { uk: "Europe/London", us: "America/New_York", pk: "Asia/Karachi", "eu-de": "Europe/Berlin", ae: "Asia/Dubai", sa: "Asia/Riyadh", in: "Asia/Kolkata", au: "Australia/Sydney", ca: "America/Toronto" };

/** The IANA zone for a location, or null when it can't be told. */
export function tzFromLocation(country?: string | null, state?: string | null, city?: string | null): string | null {
  const c = (country ?? "").trim().toLowerCase();
  const s = (state ?? "").trim().toLowerCase();
  if (["united states", "usa", "us"].includes(c) || (!c && s && US_STATES[s])) {
    if (s && US_STATES[s]) return US_STATES[s];
    const cityZone: Record<string, string> = { "san francisco": "America/Los_Angeles", "los angeles": "America/Los_Angeles", seattle: "America/Los_Angeles", "san diego": "America/Los_Angeles", denver: "America/Denver", chicago: "America/Chicago", austin: "America/Chicago", dallas: "America/Chicago", houston: "America/Chicago", phoenix: "America/Phoenix" };
    const z = cityZone[(city ?? "").trim().toLowerCase()];
    if (z) return z;
  }
  if (c === "canada" && REGIONS_CA[s]) return REGIONS_CA[s];
  if (c === "australia" && REGIONS_AU[s]) return REGIONS_AU[s];
  return COUNTRIES[c] ?? null;
}

/** The zone a person is emailed in: their own, else the workspace's prospect zone, its market, its own zone. */
export function prospectTz(contact: Pick<Contact, "timezone" | "country" | "city" | "location">, settings: Pick<OrgSettings, "prospectTimezone" | "timezone">, region?: string | null): string {
  const candidates = [
    contact.timezone,
    tzFromLocation(contact.country, contact.location?.split(",")[1]?.trim() ?? null, contact.city),
    settings.prospectTimezone,
    region ? REGION_TZ[region] : null,
    settings.timezone,
  ];
  return candidates.find((z): z is string => !!z && isValidTimeZone(z)) ?? "UTC";
}

const hhmm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (Number.isFinite(h) ? h : 9) * 60 + (Number.isFinite(m) ? m : 0);
};

/** ISO weekday, 1 = Monday .. 7 = Sunday. */
function isoDow(tz: string, at: Date): number {
  const d = dayOfWeekInTz(tz, at);
  return d === 0 ? 7 : d;
}

export interface Window {
  tz: string;
  days: number[];
  start: string;
  end: string;
}

export function windowFor(settings: Pick<OrgSettings, "sendDays" | "sendingWindowStart" | "sendingWindowEnd">, tz: string): Window {
  const days = settings.sendDays?.length ? settings.sendDays : [1, 2, 3, 4, 5];
  return { tz, days, start: settings.sendingWindowStart, end: settings.sendingWindowEnd };
}

/** True when `at` is inside the window, in the window's own zone. */
export function inWindow(w: Window, at = new Date()): boolean {
  if (!w.days.includes(isoDow(w.tz, at))) return false;
  const m = minutesInTz(w.tz, at);
  return m >= hhmm(w.start) && m < hhmm(w.end);
}

/**
 * A random minute inside the first open window at or after `notBefore`, as a UTC instant. Skips days that are not
 * sending days in the prospect's zone, and the rest of today once the window is over.
 */
export function nextSlot(w: Window, notBefore: Date, rnd: () => number = Math.random): Date {
  const a = hhmm(w.start);
  const b = Math.max(a + 1, hhmm(w.end));
  let day = dateKeyInTz(w.tz, notBefore);
  for (let i = 0; i < 14; i++, day = addDays(day, 1)) {
    const midnight = tzMidnightUtc(day, w.tz);
    const noon = new Date(midnight.getTime() + 12 * 3_600_000);
    if (!w.days.includes(isoDow(w.tz, noon))) continue;
    const from = i === 0 ? Math.max(a, minutesInTz(w.tz, notBefore) + 1) : a;
    if (from >= b) continue;
    const minute = from + Math.floor(rnd() * (b - from));
    const second = Math.floor(rnd() * 60);
    return new Date(midnight.getTime() + minute * 60_000 + second * 1000);
  }
  return new Date(notBefore.getTime() + 86_400_000);
}

/** The slot for sequence email `step`: its day after the first email (0, 3, 7, 14), at a random minute in the window. */
export function slotForStep(w: Window, firstSentAt: Date, dayOffset: number, rnd: () => number = Math.random): Date {
  const day = addDays(dateKeyInTz(w.tz, firstSentAt), dayOffset);
  const midnight = tzMidnightUtc(day, w.tz);
  return nextSlot(w, new Date(Math.max(midnight.getTime(), firstSentAt.getTime() + 60_000)), rnd);
}

/** Whether the window is open at `now` in its zone, when it closes if so, and when it next opens if not. */
export function windowState(w: Window, now = new Date()): { open: boolean; closesAt: Date | null; opensAt: Date | null } {
  const a = hhmm(w.start);
  const b = Math.max(a + 1, hhmm(w.end));
  const minute = minutesInTz(w.tz, now);
  let day = dateKeyInTz(w.tz, now);
  for (let i = 0; i < 14; i++, day = addDays(day, 1)) {
    const midnight = tzMidnightUtc(day, w.tz);
    if (!w.days.includes(isoDow(w.tz, new Date(midnight.getTime() + 12 * 3_600_000)))) continue;
    if (i === 0 && minute >= b) continue;
    if (i === 0 && minute >= a) return { open: true, closesAt: new Date(midnight.getTime() + b * 60_000), opensAt: null };
    return { open: false, closesAt: null, opensAt: new Date(midnight.getTime() + a * 60_000) };
  }
  return { open: false, closesAt: null, opensAt: null };
}
