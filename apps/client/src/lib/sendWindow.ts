import { clock, placeOf } from "./format";

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
/** "9am" or "9:30am" from "09:00" / "09:30". */
const hourLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};

/** Whether sending is open right now where the prospects are, worked out live from the hours on screen. */
export function windowNow(tz: string, days: number[], start: string, end: string, now = new Date()): { open: boolean; text: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  const dow = WEEKDAY[parts.weekday] ?? 1;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const a = minutesOf(start);
  const b = Math.max(a + 1, minutesOf(end));
  const lead = `Right now it is ${clock(now, tz)} for your prospects in ${placeOf(tz)}`;
  if (days.includes(dow) && minute >= a && minute < b) return { open: true, text: `${lead}, so sending is open until ${hourLabel(end)}.` };
  for (let i = 0; i < 8; i++) {
    const d = ((dow - 1 + i) % 7) + 1;
    if (!days.includes(d) || (i === 0 && minute >= a)) continue;
    const day = i === 0 ? "today" : i === 1 ? "tomorrow" : NAMES[d];
    return { open: false, text: `${lead}, so sending is closed until ${hourLabel(start)} ${day}.` };
  }
  return { open: false, text: `${lead}, so sending is closed.` };
}
