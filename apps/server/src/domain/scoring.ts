const DM_TITLE = /founder|owner|ceo|coo|cto|cmo|cfo|chief|president|partner|managing|director|head of|\bhead\b|\bvp\b|vice president|principal|general manager/i;
const DM_SENIORITY = new Set(["owner", "founder", "c_suite", "partner", "vp", "head", "director"]);
const JUNIOR_TITLE = /\b(intern|trainee|student|junior|assistant|coordinator|apprentice)\b/i;

export interface ScoreInput {
  title?: string | null;
  seniority?: string | null;
  emailStatus?: string | null;
  employees?: number | null;
  industry?: string | null;
  website?: string | null;
  linkedinUrl?: string | null;
  source?: string | null;
}

export interface Score {
  fitScore: number;
  tier: "A" | "B" | "C";
}

export function scoreContact(c: ScoreInput, audience?: { industries?: string[]; titles?: string[] }): Score {
  let s = 30;
  const title = (c.title ?? "").toLowerCase();
  if (DM_TITLE.test(title) || DM_SENIORITY.has(String(c.seniority ?? "").toLowerCase())) s += 25;
  if (JUNIOR_TITLE.test(title)) s -= 25;
  if (audience?.titles?.some((t) => t && title.includes(t.toLowerCase().split(" ")[0]))) s += 10;
  if (c.industry && audience?.industries?.some((i) => i && c.industry!.toLowerCase().includes(i.toLowerCase().split(" ")[0]))) s += 10;
  if (c.emailStatus === "verified") s += 15;
  else if (c.emailStatus === "unavailable" || c.emailStatus === "invalid") s -= 30;
  if (c.employees != null) {
    if (c.employees >= 5 && c.employees <= 500) s += 10;
    else if (c.employees > 5000) s -= 10;
  }
  if (c.website) s += 5;
  if (c.linkedinUrl) s += 5;
  const fitScore = Math.max(0, Math.min(100, s));
  return { fitScore, tier: fitScore >= 70 ? "A" : fitScore >= 50 ? "B" : "C" };
}

export const SEND_FLOOR = 25;
