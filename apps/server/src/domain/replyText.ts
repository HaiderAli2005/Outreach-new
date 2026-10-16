const QUOTE_MARKERS = [
  // Mail apps wrap a long attribution ("On Fri, Oct 16, 2026 at 4:51 PM Name <a@b.c>\nwrote:") over two lines.
  /^On [^\n]{0,200}(?:\n[^\n]{0,200})?wrote:\s*$/im,
  /^Den [^\n]{0,200}(?:\n[^\n]{0,200})?skrev[^\n]{0,80}:\s*$/im,
  /-{2,}\s*Original Message\s*-{2,}/im,
  /-{2,}\s*Ursprungligt meddelande\s*-{2,}/im,
  /^_{10,}\s*$/m,
  /^From:\s.+$/im,
  /^Från:\s.+$/im,
  /^Sent from my /im,
  /^Skickat från min /im,
];

export function cleanInboundReply(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw);
  if (/<[a-z][\s\S]*>/i.test(s)) {
    s = s
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function quoteStart(s: string): number {
  let cut = s.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(s);
    if (m && m.index < cut) cut = m.index;
  }
  return cut;
}

export function prospectOwnWords(raw: string | null | undefined): string {
  return splitQuoted(raw).own;
}

/** A reply split into what the prospect wrote and the quoted history under it (folded away in the inbox). */
export function splitQuoted(raw: string | null | undefined): { own: string; quoted: string | null } {
  const s = cleanInboundReply(raw);
  const cut = quoteStart(s);
  const head = s.slice(0, cut).split("\n");
  const own = head
    .filter((l) => !l.trim().startsWith(">"))
    .join("\n")
    .trim();
  const quoted = [head.filter((l) => l.trim().startsWith(">")).join("\n"), s.slice(cut)].join("\n").trim();
  return { own, quoted: quoted || null };
}

/** A draft that opens with just the first name on its own line ("Haider") gets a real greeting ("Hi Haider,"). */
export function fixGreeting(draft: string, firstName: string | null | undefined, language?: string | null): string {
  const name = firstName?.trim();
  if (!name || !draft.includes("\n")) return draft;
  const first = draft.split("\n", 1)[0].trim().replace(/[,.!:]$/, "");
  if (first.toLowerCase() !== name.toLowerCase()) return draft;
  return `${language === "sv" ? "Hej" : "Hi"} ${first},${draft.slice(draft.indexOf("\n"))}`;
}

const INLINE_QUOTE = /\s(?:-{2,}\s*(?:Original Message|Ursprungligt meddelande)|On (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? |Den (?:mån|tis|ons|tors|fre|lör|sön)[a-zå]*\s|From:\s|Från:\s)/i;

/** A one-line preview (whitespace already collapsed) cut where quoted history starts. */
export function trimQuotedPreview(p: string | null | undefined): string | null {
  if (!p) return null;
  const m = INLINE_QUOTE.exec(` ${p}`);
  const out = (m && m.index > 0 ? ` ${p}`.slice(0, m.index) : ` ${p}`).trim();
  return out || p;
}

const HARD_STOP = [
  /\bunsubscribe\b/i, /\bremove me\b/i, /\bstop (e-?mailing|contacting|sending)\b/i, /\bdo not (contact|email)\b/i,
  /\bgdpr\b/i, /\blawyer\b/i, /\battorney\b/i, /\blegal action\b/i, /\breport(ing)? (you|this)\b/i, /\bspam\b/i,
  /\bhow did you get my\b/i, /\bavregistrera\b/i, /\bta bort mig\b/i, /\bsluta (mejla|maila|skicka)\b/i, /\badvokat\b/i, /\banmäl/i,
];

export function screenHardStop(text: string): { hit: boolean; marker: string | null } {
  for (const re of HARD_STOP) if (re.test(text)) return { hit: true, marker: re.source.replace(/\\b|\\/g, "").slice(0, 24) };
  return { hit: false, marker: null };
}

const PHONE = /(\+?\d[\d\s().-]{7,}\d)/;
const TIME_PROPOSAL = /\b(\d{1,2}([:.]\d{2})?\s?(am|pm)|kl\.?\s?\d{1,2}([:.]\d{2})?|\d{1,2}:\d{2})\b/i;
const CALL_ME = /\b(call me|ring me|phone me|ring mig|kan du ringa|give me a call|ringa mig)\b/i;

export function wantsHumanScheduling(text: string): boolean {
  return CALL_ME.test(text) || TIME_PROPOSAL.test(text) || PHONE.test(text);
}

export function isThin(text: string): boolean {
  return text.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean).length < 3;
}

export function detectLanguage(text: string): "sv" | "en" | null {
  const t = ` ${text.toLowerCase()} `;
  const sv = (t.match(/ (och|jag|inte|det|är|vi|för|att|på|med|hej|tack|kan|vill) /g) ?? []).length + (/[åäö]/.test(t) ? 2 : 0);
  const en = (t.match(/ (and|i|not|the|is|we|for|to|on|with|hi|thanks|can|would) /g) ?? []).length;
  if (sv === 0 && en === 0) return null;
  return sv > en ? "sv" : "en";
}
