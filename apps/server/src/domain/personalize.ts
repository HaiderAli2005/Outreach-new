import type { Contact, OrgSettings } from "@prisma/client";
import { getAi } from "../integrations/ai.js";
import { brandProfileOf } from "./settings.js";
import { businessProfileOf, profileForPrompt } from "./businessProfile.js";
import { sequenceForPrompt, type Touch } from "./campaignSequence.js";
import { SENDER_FIRST_NAME } from "./sending/message.js";
import { BANNED_PHRASES, checkFirstTouch, checkFollowUp, checkSubject, unsupportedClaims, type ClaimCorpus } from "./emailRules.js";

/**
 * The emails themselves. One researched first email and three follow-ups per person, held to emailRules.ts:
 *
 *   para 1   a specific observation about THEIR company, then the pain that follows from it (2 sentences)
 *   para 2   who I am and what we do (1 to 2 sentences): "I'm {{sender_first_name}} from <company>"
 *   para 3   proof with a real, sourced number, plus a low-commitment offer
 *   para 4   ONE short question
 *
 * 90 to 130 words, no links, no bullets, no bold, exactly one question at the end. The subject is a 2 to 4 word noun
 * phrase about their world. Nothing about the prospect that the research did not establish, no invented customer
 * as proof, no number without a source. The writer retries once with the problems named, then falls back to a plain
 * email that makes no claims at all.
 */
export interface WrittenSequence {
  subject: string;
  body: string;
  followup2: string;
  followup3: string;
  followup4: string;
  status: "done" | "fallback" | "failed";
  problems?: string[];
}

const BANNED_LINT = [/\b(seamless|cutting-edge|revolutionary|game-changing)\b/gi, /\b(100% free|guaranteed|act now|limited time offer)\b/gi];

/** Plain text clean-up: no HTML, no em-dashes, no markdown. Never cuts words: length is a rule, not a trim. */
export function lintEmail(text: string): string {
  let s = String(text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[—–]/g, ",")
    .replace(/\s+-\s+/g, ", ")
    .replace(/\*\*|__|#+\s/g, "");
  for (const re of BANNED_LINT) s = s.replace(re, "");
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ ,/g, ",")
    .trim();
}

/** Subject in sentence case with nothing trailing. */
export function cleanSubject(s: string): string {
  const t = lintEmail(s).replace(/[.!?:;,]+$/, "").replace(/\s+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function capitalise(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function words(n: string) {
  return n.split(/\s+/).filter(Boolean);
}

/**
 * The plain email used when the writer is unavailable or keeps breaking the rules. It makes no claim about the
 * prospect beyond their company and industry, names no customer and quotes no number.
 */
export function fallbackSequence(contact: Pick<Contact, "firstName" | "company" | "industry">, settings: OrgSettings): Omit<WrittenSequence, "status"> {
  const brand = brandProfileOf(settings);
  const sender = settings.senderCompany || brand.company || "our team";
  const offerRaw = (settings.valueProp || brand.valueProp || brand.summary || "we help teams spend less time on the routine work around their main job").replace(/\s+/g, " ").trim();
  const offer = words(offerRaw.replace(/\d[\d,.%x]*/g, "").replace(/\s+/g, " ")).slice(0, 30).join(" ").replace(/[.,;:]+$/, "");
  const company = contact.company?.trim() || "your team";
  const industry = contact.industry?.trim().toLowerCase();
  const hi = contact.firstName?.trim() ? `Hi ${contact.firstName.trim()},` : "Hi,";
  const para1 = `I was looking at ${company}${industry ? ` and how teams in ${industry} work today` : " and how teams like yours work today"}. As a team grows, a lot of time tends to go into the work around the work, and it rarely gets easier on its own.`;
  const para2 = `I'm ${SENDER_FIRST_NAME} from ${sender}. In short, ${offer.charAt(0).toLowerCase()}${offer.slice(1)}.`;
  let para3 = `Happy to put together a short example of how this could look for ${company}, with no obligation either way.`;
  const para4 = "Would it be useful if I sent it over?";
  let body = [hi, para1, para2, para3, para4].join("\n\n");
  if (words(body).length < 90) {
    para3 = `${para3} It takes a few minutes to read, there is nothing to install, and you can simply ignore it if the timing is wrong.`;
    body = [hi, para1, para2, para3, para4].join("\n\n");
  }
  const topic = industry ? words(industry).slice(0, 2).join(" ") : "team";
  return {
    subject: capitalise(`${topic} workflow ideas`.replace(/\s+/g, " ")),
    body,
    followup2: `${hi}\n\nA short follow-up on my note. If the example would help, I can have it ready this week. Is it worth sending?`,
    followup3: `${hi}\n\nOne more thought: the example is short and made for ${company}, so it should take a couple of minutes to judge whether it fits. Happy to send it whenever suits you.`,
    followup4: `${hi}\n\nI'll leave it here so I don't crowd your inbox. If the timing is better later on, just reply to this email and I'll pick it up.`,
  };
}

/**
 * Without the writer, the approved sequence itself is the fallback: its merge fields filled in for this person. It
 * says only what the customer approved, so it makes no claim about the prospect.
 */
export function fromTemplate(touches: Touch[], contact: Pick<Contact, "firstName" | "company">): Omit<WrittenSequence, "status"> | null {
  if (touches.length !== 4 || touches.some((t) => !t.body.trim()) || !touches[0].subject?.trim()) return null;
  const first = contact.firstName?.trim() ?? "";
  const fill = (t: string) =>
    t
      .replace(/(Hi|Hello|Hey|Dear) \{\{first_name\}\},/g, first ? `$1 ${first},` : "$1,")
      .split("{{first_name}}").join(first || "there")
      .split("{{company}}").join(contact.company?.trim() || "your team")
      .replace(/\{\{similar_company\}\}/g, "teams like yours");
  return { subject: touches[0].subject!.trim(), body: fill(touches[0].body), followup2: fill(touches[1].body), followup3: fill(touches[2].body), followup4: fill(touches[3].body) };
}

/** Every rule a written sequence breaks. Empty means it may be used. */
export function sequenceProblems(seq: Omit<WrittenSequence, "status">, contact: Pick<Contact, "company" | "firstName">, corpus: ClaimCorpus): string[] {
  const problems: string[] = [];
  const subj = checkSubject(seq.subject, contact);
  if (subj) problems.push(`subject ${subj}`);
  const first = checkFirstTouch(seq.body);
  if (first) problems.push(first);
  if (!seq.body.includes(SENDER_FIRST_NAME)) problems.push(`the first email must introduce the sender as "${SENDER_FIRST_NAME}"`);
  for (const [name, text] of [["follow-up 2", seq.followup2], ["follow-up 3", seq.followup3], ["follow-up 4", seq.followup4]] as const) {
    const p = checkFollowUp(text);
    if (p) problems.push(`${name}: ${p}`);
    if (/https?:\/\/|www\./i.test(text)) problems.push(`${name}: no links`);
  }
  for (const text of [seq.body, seq.followup2, seq.followup3, seq.followup4]) {
    const claims = unsupportedClaims(text, corpus);
    if (claims.length) problems.push(`unsupported claim or name: ${claims.join(", ")}`);
  }
  return [...new Set(problems)];
}

/** What the writer may use: the research, and the customer's own facts with their sources. */
export function corpusOf(contact: Contact, settings: OrgSettings, companyDescription?: string | null): ClaimCorpus {
  const proof = Array.isArray(settings.proofPoints) ? (settings.proofPoints as { claim?: string; source?: string }[]).filter((p) => p?.claim && p?.source) : [];
  return {
    prospect: [contact.firstName, contact.lastName, contact.fullName, contact.title, contact.company, contact.industry, contact.website, contact.location, contact.city, contact.country, contact.headline, companyDescription].filter(Boolean).join("\n"),
    customer: [settings.senderCompany, settings.valueProp, JSON.stringify(settings.brandProfile ?? {}), ...proof.map((p) => p.claim)].filter(Boolean).join("\n"),
  };
}

function buildPrompt(contact: Contact, settings: OrgSettings, opts: { marketBrief?: string | null; companyDescription?: string | null; language: string; sequence?: Touch[] | null }, feedback: string[]): string {
  const brand = brandProfileOf(settings);
  // The business profile the customer approved is the one record of who they are; read here, at draft time.
  const profile = profileForPrompt(businessProfileOf(settings));
  const proof = Array.isArray(settings.proofPoints) ? (settings.proofPoints as { claim?: string; source?: string }[]).filter((p) => p?.claim && p?.source) : [];
  const facts = [
    contact.fullName && `Name: ${contact.fullName}`,
    contact.firstName && `First name: ${contact.firstName}`,
    contact.title && `Title: ${contact.title}`,
    contact.company && `Company: ${contact.company}`,
    contact.industry && `Industry: ${contact.industry}`,
    contact.website && `Website: ${contact.website}`,
    contact.location && `Location: ${contact.location}`,
    opts.companyDescription && `About the company: ${opts.companyDescription.slice(0, 500)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const language = opts.language === "sv" ? "Swedish" : opts.language === "en" ? "English" : opts.language;
  return `Write a cold email sequence for ONE prospect on behalf of ${settings.senderCompany || brand.company || "our company"}.

WHAT WE SELL (the only services you may mention; never offer anything beyond this):
${(settings.valueProp || brand.valueProp || brand.summary || "(not provided)").slice(0, 700)}
${opts.marketBrief ? `\nCAMPAIGN ANGLE:\n${opts.marketBrief.slice(0, 600)}\n` : ""}${profile ? `\n${profile}\n` : ""}
PROOF WE MAY USE (each has a source; use at most one, word for word in substance, never invent another):
${proof.length ? proof.map((p) => `- ${p.claim} (source: ${p.source})`).join("\n") : "(none recorded: use no numbers, no results, no customer names at all)"}

THE PROSPECT (everything you know; claim nothing about them beyond this):
${facts || "(very little known: keep the observation to their company and role)"}

LANGUAGE: ${language}.
${opts.sequence ? `\nTHE APPROVED SEQUENCE (the customer wrote and approved it; follow it closely):
${sequenceForPrompt(opts.sequence)}

Write THIS prospect's version of it. Keep each email's structure, offer, proof, question and tone. Use the subject as written. Replace {{first_name}} and {{company}} with this prospect's details, and rewrite only the first paragraph's observation so it is true of THIS prospect, from the facts above. Keep ${SENDER_FIRST_NAME} exactly as written.
` : ""}
FIRST EMAIL, 90 to 130 words, exactly this shape:
"Hi <first name>," on its own line (just "Hi," if no first name).
Paragraph 1: one specific observation about THEIR company taken from the facts above, then the pain that follows from it. Two sentences.
Paragraph 2: "I'm ${SENDER_FIRST_NAME} from <our company>." and what we do, in one or two sentences. Write ${SENDER_FIRST_NAME} exactly like that; it is filled in later.
Paragraph 3: the proof (only from PROOF above; if there is none, skip the proof) and a low-commitment offer, such as a short example made for them.
Paragraph 4: ONE short question, and it is the only question mark in the email.
No sign-off and no name at the end (a sign-off is added).

SUBJECT: 2 to 4 words, a noun phrase with no verb, sentence case, no question mark, no exclamation mark. It describes the prospect's world, never our product. Never their company name, never their first name, never "quick question". Examples of the style: "Research content volume", "Client reporting systems", "Podcast research flow".

FOLLOW-UPS, written as replies in the same thread, each under 60 words, at most one question each:
followup2 (day 3): a different angle on the same problem.
followup3 (day 7): one more useful thought or a smaller offer.
followup4 (day 14): a short, warm closing note that leaves the door open.

NEVER: links, bullet points, bold, emojis, em-dashes, " - ", HTML. Never ${BANNED_PHRASES.map((p) => `"${p}"`).join(", ")}. Never invent a fact, a customer, a result, a number or a price.
${feedback.length ? `\nYOUR LAST DRAFT BROKE THESE RULES, FIX THEM:\n${feedback.map((f) => `- ${f}`).join("\n")}\n` : ""}
Return STRICT JSON: {"subject":"...","body":"...","followup2":"...","followup3":"...","followup4":"..."}`;
}

type Raw = { subject?: string; body?: string; followup2?: string; followup3?: string; followup4?: string };

/** A second read by the model: anything in the email that the facts don't support (a service we don't offer, a claim about them). */
async function factCheck(email: string, corpus: ClaimCorpus, orgId: string): Promise<string[]> {
  const ai = getAi();
  if (!ai) return [];
  const prompt = `You check a sales email before it is sent. List every statement in the EMAIL that is not supported by the FACTS: a claim about the prospect the research does not show, a service the sender does not offer, a customer name or a number that is not in the facts. Ignore ${SENDER_FIRST_NAME}.

FACTS ABOUT THE PROSPECT:
${corpus.prospect.slice(0, 1500) || "(none)"}

WHAT THE SENDER OFFERS AND CAN PROVE:
${corpus.customer.slice(0, 1500) || "(none)"}

EMAIL:
${email}

Return STRICT JSON: {"unsupported": ["..."]} (an empty list when everything is supported).`;
  try {
    const r = await ai.generateJSON<{ unsupported?: unknown }>(prompt, { maxTokens: 300, temperature: 0, meter: { orgId, purpose: "fact-check" } });
    return Array.isArray(r?.unsupported) ? (r!.unsupported as unknown[]).map(String).filter((x) => x.trim()).slice(0, 5) : [];
  } catch {
    return [];
  }
}

export async function personalizeContact(
  contact: Contact,
  settings: OrgSettings,
  opts: { marketBrief?: string | null; companyDescription?: string | null; language?: string; sequence?: Touch[] | null } = {},
): Promise<WrittenSequence> {
  const fb = (opts.sequence && fromTemplate(opts.sequence, contact)) || fallbackSequence(contact, settings);
  const ai = getAi();
  if (!ai) return { ...fb, status: "fallback" };
  const language = opts.language || settings.language;
  const corpus = corpusOf(contact, settings, opts.companyDescription);
  let feedback: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: Raw | null = null;
    try {
      out = await ai.generateJSON<Raw>(buildPrompt(contact, settings, { ...opts, language }, feedback), { maxTokens: 1000, temperature: attempt ? 0.5 : 0.8, meter: { orgId: contact.organizationId, purpose: "personalize" } });
    } catch {
      out = null;
    }
    if (!out) return { ...fb, status: "failed" };
    const seq = {
      subject: cleanSubject(String(out.subject ?? "")),
      body: lintEmail(String(out.body ?? "")),
      followup2: lintEmail(String(out.followup2 ?? "")),
      followup3: lintEmail(String(out.followup3 ?? "")),
      followup4: lintEmail(String(out.followup4 ?? "")),
    };
    feedback = sequenceProblems(seq, contact, corpus);
    if (!feedback.length) feedback = (await factCheck(seq.body, corpus, contact.organizationId)).map((x) => `not supported by the facts: ${x}`);
    if (!feedback.length) return { ...seq, status: "done" };
  }
  return { ...fb, status: "fallback", problems: feedback };
}
