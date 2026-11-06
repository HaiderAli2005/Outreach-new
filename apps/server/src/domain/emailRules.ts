import type { Contact } from "@prisma/client";

/**
 * The rules every email is held to, at write time (the writer retries, then falls back) and again before every send
 * (the content guard refuses). Modelled on what actually gets replies: 90 to 130 words, a researched observation,
 * who we are, one piece of real proof, and exactly one short question at the very end.
 */

export const FIRST_TOUCH_WORDS = { min: 90, max: 130 } as const;

export const BANNED_PHRASES = [
  "i hope this finds you well",
  "i hope this email finds you well",
  "hope you're well",
  "quick question",
  "reaching out",
  "reach out",
  "circle back",
  "touch base",
  "synergy",
  "synergies",
  "leverage",
  "just following up",
  "i wanted to reach out",
] as const;

const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|ai|app|dev|uk|pk|de|fr|es|info|biz|site|xyz)\b/i;
const BULLET = /^\s*([-*•▪◦]|\d+[.)])\s+/m;
const BOLD = /\*\*[^*]+\*\*|__[^_]+__/;

const words = (s: string) => s.replace(/\{\{[^}]+\}\}/g, "Name").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
// Chinese and Japanese are written without spaces: about 2.5 characters make a word.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
/** Question marks in every script we write in: Latin ?, full-width ？ (Chinese, Japanese), Arabic ؟. */
const QMARK = /[?？؟]/g;

export function wordCount(text: string): number {
  return words(text).reduce((n, w) => {
    const cjk = w.match(CJK)?.length ?? 0;
    return n + (cjk ? Math.max(1, Math.round(cjk / 2.5)) + (w.replace(CJK, "").match(/\p{L}+/gu)?.length ?? 0) : 1);
  }, 0);
}

/** First-email length by language: German and Finnish use long compound words, so the same message has fewer of them. */
export function firstTouchWords(language?: string | null): { min: number; max: number } {
  if (language === "de" || language === "fi" || language === "ko") return { min: 70, max: 130 };
  return FIRST_TOUCH_WORDS;
}

export function bannedPhrase(text: string): string | null {
  const t = text.toLowerCase().replace(/[’']/g, "'");
  return BANNED_PHRASES.find((p) => t.includes(p)) ?? null;
}

/** First-touch rules. Returns the first rule broken, or null. */
export function checkFirstTouch(text: string, language?: string | null, allow: (string | null | undefined)[] = []): string | null {
  const t = (text ?? "").trim();
  // A company named like a website ("THE OUTNET.COM") is a name, not a link: it is left out of the link check.
  const names = allow.filter((a): a is string => !!a && LINK.test(a));
  const linkText = names.reduce((acc, n) => acc.split(n).join(" ").replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " "), t);
  const n = wordCount(t);
  const range = firstTouchWords(language);
  if (n < range.min) return `the first email is ${n} words, under ${range.min}`;
  if (n > range.max) return `the first email is ${n} words, over ${range.max}`;
  if (LINK.test(linkText)) return "a first email may not contain any link";
  if (BULLET.test(t)) return "no bullet points";
  if (BOLD.test(t)) return "no bold text";
  const banned = bannedPhrase(t);
  if (banned) return `banned phrase "${banned}"`;
  const questions = (t.match(QMARK) ?? []).length;
  if (questions !== 1) return questions ? "more than one question" : "it must end with one question";
  const lastPara = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).at(-1) ?? "";
  if (!/[?？؟]$/.test(lastPara)) return "the one question must come at the end";
  return null;
}

/** Follow-up rules: still at most one question, still none of the banned phrases. */
export function checkFollowUp(text: string): string | null {
  const t = (text ?? "").trim();
  if (!t) return "the follow-up is empty";
  if ((t.match(QMARK) ?? []).length > 1) return "more than one question";
  const banned = bannedPhrase(t);
  return banned ? `banned phrase "${banned}"` : null;
}

// Words that make a subject a sentence instead of a noun phrase. Not exhaustive; it catches the usual openers.
const VERBS = new Set(
  (
    "is are was were be can could would will should do does did have has get gets got boost boosts boosting grow grows growing save saves saving cut " +
    "cuts cutting scale scales scaling improve improves improving help helps helping increase increases increasing reduce reduces reducing make makes " +
    "making need needs want wants try tries trying see sees let lets let's unlock unlocks unlocking drive drives driving win wins winning stop stops " +
    "stopping start starts starting transform transforms transforming streamline streamlines streamlining automate automates automating discover meet " +
    "book join learn check grab claim find finds finding turn turns turning take takes taking struggling"
  ).split(" "),
);

/** Subject rules: 2 to 4 words, a noun phrase, sentence case, about their world, never their name or company. */
export function checkSubject(subject: string, contact?: Pick<Contact, "company" | "firstName"> | null): string | null {
  const s = (subject ?? "").trim();
  const w = s.split(/\s+/).filter(Boolean);
  const cjk = s.match(CJK)?.length ?? 0;
  if (cjk) {
    // Chinese and Japanese: a short phrase of about 4 to 20 characters.
    if (s.length < 4 || s.length > 20) return `has ${s.length} characters, it must be 4 to 20`;
  } else if (w.length < 2 || w.length > 4) return `has ${w.length} words, it must be 2 to 4`;
  if (/[?!？！؟]/.test(s)) return "has a question mark or exclamation mark";
  if (/^(re|fwd?|aw|sv|wg|tr)\s*:/i.test(s)) return "pretends to be a reply";
  // Scripts without capitals (Arabic, Hebrew, Chinese) pass; a Latin or Cyrillic subject must not start lower case.
  if (/^\p{Ll}/u.test(s)) return "is not in sentence case";
  if (/\p{Lu}/u.test(s) && s === s.toUpperCase() && /\p{L}{3,}/u.test(s)) return "is in capitals";
  if (/quick question/i.test(s)) return 'says "quick question"';
  const lower = s.toLowerCase();
  const verb = w.map((x) => x.toLowerCase().replace(/[^\p{L}']/gu, "")).find((x) => VERBS.has(x));
  if (verb) return `has a verb ("${verb}"), it must be a noun phrase`;
  const company = (contact?.company ?? "").toLowerCase().replace(/\b(inc|ltd|llc|gmbh|plc|limited|corp|co)\b\.?/g, "").trim();
  if (company.length >= 3 && lower.includes(company)) return "contains the prospect's company name";
  const first = (contact?.firstName ?? "").trim().toLowerCase();
  if (first.length >= 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)) return "contains the recipient's first name";
  return null;
}

/** What an email may draw on: research about the prospect, and the customer's own facts and sourced proof. */
export interface ClaimCorpus {
  prospect: string;
  customer: string;
}

// Capitalised words that are not claims about anyone.
const COMMON = new Set(
  (
    "I I'm I've I'd I'll Hi Hello Dear Best Thanks Thank Regards Cheers Happy Want Would Could Should Can Is Are Do Does Our We We're Your You You're " +
    "The A An It It's That This These Those If When Most Many One Two Three Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February " +
    "March April May June July August September October November December Q1 Q2 Q3 Q4 AI API CRM ERP SaaS B2B B2C CEO CTO CFO COO CMO VP HR SEO PPC " +
    "PDF UK US USA EU UAE Google Microsoft LinkedIn Gmail Outlook Excel Word PowerPoint Slack Salesforce HubSpot Shopify Zoom Teams YouTube Instagram " +
    "Facebook TikTok WhatsApp Amazon Apple Android iOS Power BI Notion Zapier"
  ).split(" "),
);

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}%.]+/gu, " ");

/**
 * Claims the email makes that nothing on record supports:
 *   a number (60%, 3x, $2,000, 500 clients) that appears in neither the research nor the customer's sourced facts
 *   a name used as proof ("helped Acme", "teams like Northwind") that is on record nowhere
 *   any other proper name mid-sentence that the research did not establish
 * Returns the offending pieces; empty means clean.
 */
export function unsupportedClaims(text: string, corpus: ClaimCorpus, language?: string | null): string[] {
  const body = (text ?? "").replace(/\{\{[^}]+\}\}/g, " ");
  const all = norm(`${corpus.prospect}\n${corpus.customer}`);
  const digitsOnRecord = new Set((all.match(/\d[\d.,]*/g) ?? []).map((d) => d.replace(/[.,]+$/, "").replace(/,/g, "")));
  const out: string[] = [];
  for (const m of body.matchAll(/\$?\d[\d,.]*\s*(%|x\b|×|k\b|percent\b)?/gi)) {
    const digits = m[0].replace(/[^\d.]/g, "").replace(/\.+$/, "");
    if (!digits) continue;
    if (!digitsOnRecord.has(digits)) out.push(m[0].trim());
  }
  // Proper names that are not at the start of a sentence. German capitalises every noun, so there a capital says
  // nothing about a name: only the numbers are checked (and the fact check that follows reads names in context).
  if (language === "de") return [...new Set(out)];
  for (const sentence of body.split(/(?<=[.!?:])\s+|\n+/)) {
    const tokens = sentence.trim().split(/\s+/);
    for (let i = 1; i < tokens.length; i++) {
      const raw = tokens[i].replace(/^[("'“]+|[)"'”.,;:!?]+$/g, "");
      if (!/^\p{Lu}/u.test(raw) || COMMON.has(raw) || /^\p{Lu}{1,4}$/u.test(raw)) continue;
      const word = raw.toLowerCase().replace(/'s$/, "");
      // "AI-driven" is supported when each part is ("AI" in the offer): a compound is not a new name.
      // Only its capitalised parts can be names; ordinary lower-case parts ("-driven", "-based") are just words.
      const parts = raw.split(/[-‐–]/).filter((x) => x.length > 0);
      const named = parts.filter((x) => /^\p{Lu}/u.test(x)).map((x) => x.toLowerCase());
      const compoundOk = parts.length > 1 && named.length > 0 && named.every((x) => all.includes(x));
      if (!all.includes(word) && !compoundOk) out.push(raw);
    }
  }
  return [...new Set(out)];
}
