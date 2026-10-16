import type { OrgSettings } from "@prisma/client";

/**
 * What a conversation reply carries under the text: the sign-off, the company (and postal address when set) and,
 * only while the person has never answered, the opt-out line. Someone who wrote back is in a conversation, and a
 * cold-email footer under a reply to them reads as a mass mailing.
 */
export function replySignature(
  s: Pick<OrgSettings, "senderCompany" | "senderAddress" | "optOutLine" | "language">,
  opts: { name?: string | null; cold?: boolean } = {},
): string {
  const signOff = opts.name ? `Best,\n${opts.name}` : "";
  const identity = [s.senderCompany, s.senderAddress].filter(Boolean).join(", ");
  const block = [signOff, identity].filter(Boolean).join("\n");
  return [block, opts.cold ? optOutLine(s) : ""].filter(Boolean).join("\n\n");
}

export function optOutLine(s: Pick<OrgSettings, "optOutLine" | "language">): string {
  if (s.optOutLine?.trim()) return s.optOutLine.trim();
  return s.language === "sv"
    ? "Om det här inte är aktuellt, säg bara till så hör jag inte av mig igen."
    : "If this isn't relevant, just say so and I won't reach out again.";
}

const RTL_CHARS = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const LTR_CHARS = /[A-Za-z\u00C0-\u024F\u0400-\u04FF]/g;

/** True when most letters in the text are from a right-to-left script (Arabic, Urdu, Persian, Hebrew). */
export function isRtlText(text: string | null | undefined): boolean {
  if (!text) return false;
  // Merge tokens like {{first_name}} are Latin but say nothing about the language of the email.
  const clean = text.replace(/\{\{[^}]*\}\}/g, "");
  const rtl = clean.match(RTL_CHARS)?.length ?? 0;
  const ltr = clean.match(LTR_CHARS)?.length ?? 0;
  return rtl > 0 && rtl >= ltr;
}

/** Plain text to email HTML. Right-to-left text is wrapped so mail apps show it right to left. */
export function htmlize(text: string | null | undefined): string {
  if (!text) return "";
  const html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br/>");
  return isRtlText(text) ? `<div dir="rtl" style="direction:rtl;text-align:right">${html}</div>` : html;
}

/** The unsubscribe link every pool email carries. {{unsub_url}} is filled per person (see sending/unsubscribe.ts). */
export const UNSUBSCRIBE_LINK = '<br/><br/><a href="{{unsub_url}}">Unsubscribe</a>';

export function buildSequence(signature: string, delayFollowup2 = 4, delayFollowup3 = 6, opts: { unsubscribeLink?: boolean } = {}) {
  const block = (signature ? `<br/><br/>${signature.replace(/\r?\n/g, "<br/>")}` : "") + (opts.unsubscribeLink ? UNSUBSCRIBE_LINK : "");
  return [
    { seq_number: 1, seq_delay_details: { delay_in_days: 0 }, subject: "{{ai_subject}}", email_body: "{{ai_body}}" + block },
    { seq_number: 2, seq_delay_details: { delay_in_days: delayFollowup2 }, subject: "", email_body: "{{ai_followup2}}" + block },
    { seq_number: 3, seq_delay_details: { delay_in_days: delayFollowup3 }, subject: "", email_body: "{{ai_followup3}}" + block },
  ];
}

const SOFT_ACK = {
  away: {
    en: ["Thanks for letting me know. I'll get back in touch once you're back.", "No problem at all, I'll follow up when you're back."],
    sv: ["Tack för att du hör av dig. Jag hör av mig när du är tillbaka.", "Inga problem, jag återkommer när du är tillbaka."],
  },
  not_now: {
    en: ["Understood, thanks for the honest answer. I'll check back later on.", "Makes sense. I'll reach out again further down the line."],
    sv: ["Förstår, tack för ärligt svar. Jag hör av mig längre fram.", "Det låter rimligt. Jag återkommer lite längre fram."],
  },
};

export function softAck(kind: "away" | "not_now", language: string, seed: string): string {
  const variants = SOFT_ACK[kind][language === "sv" ? "sv" : "en"];
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return variants[h % variants.length];
}

export function returnNudge(language: string): string {
  return language === "sv"
    ? "Hej igen, hoppas det var skönt att komma tillbaka. Är det fortfarande intressant att ta en kort pratstund?"
    : "Hi again, welcome back. Is it still worth a short chat about this?";
}

export function ctaLine(language: string): string {
  return language === "sv" ? "Om du vill kan du välja en tid som passar här:" : "If it helps, you can pick a time that suits you here:";
}
