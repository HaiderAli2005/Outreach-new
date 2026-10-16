import type { Contact, OrgSettings } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { normalizeEmail } from "../lib/normalize.js";
import { getAi } from "../integrations/ai.js";
import { brandProfileOf, getSettings } from "./settings.js";
import { blockEmail } from "./suppression.js";
import { markNeverAuto } from "./conversation.js";
import { partitionCandidates } from "./dedup.js";
import { addUsage } from "./usage.js";
import { cleanInboundReply, detectLanguage, fixGreeting, prospectOwnWords } from "./replyText.js";
import { logSystem } from "./systemLog.js";
import { unsubscribeEverywhere } from "./sending/unsubscribe.js";
import { postToSlack } from "../integrations/slack.js";

export const LEAD_CLASSES = new Set(["hot", "question", "curious", "not_now", "away", "review"]);
export const URGENT_CLASSES = new Set(["hot", "question", "curious", "review"]);
const LATER_CLASSES = new Set(["away", "not_now"]);
/** Drafts are written only for people who want to talk or asked something: INTERESTED and INFO_REQUEST. */
const DRAFT_CLASSES = new Set(["hot", "question", "curious"]);
const VALID = new Set(["hot", "question", "curious", "not_now", "away", "referral", "not_interested", "stop", "frustrated", "auto", "review", "moved", "deceased"]);

/**
 * The intent shown to the customer, from the classifier's finer class:
 *   INTERESTED      wants to talk, asks for the demo, example or call
 *   INFO_REQUEST    asks a question before committing
 *   REFERRAL        "talk to someone else here", and who
 *   NOT_NOW         "not right now", "ask me in Q2", away until a date
 *   NOT_INTERESTED  a clear no (also: left the company, deceased)
 *   UNSUBSCRIBE     asks to be removed: suppressed everywhere at once
 *   HOSTILE         angry, threatens to report: suppressed everywhere and an operator is alerted
 *   UNCLEAR         can't tell: goes to the customer, never drafted
 */
export const INTENTS = ["INTERESTED", "INFO_REQUEST", "REFERRAL", "NOT_NOW", "NOT_INTERESTED", "UNSUBSCRIBE", "HOSTILE", "UNCLEAR"] as const;
export type Intent = (typeof INTENTS)[number];

export const INTENT_OF: Record<string, Intent> = {
  hot: "INTERESTED",
  curious: "INTERESTED",
  question: "INFO_REQUEST",
  referral: "REFERRAL",
  not_now: "NOT_NOW",
  away: "NOT_NOW",
  not_interested: "NOT_INTERESTED",
  moved: "NOT_INTERESTED",
  deceased: "NOT_INTERESTED",
  stop: "UNSUBSCRIBE",
  frustrated: "HOSTILE",
  review: "UNCLEAR",
  auto: "UNCLEAR",
};

export function temperatureOf(cls: string): "hot" | "warm" | "cold" {
  if (cls === "hot") return "hot";
  if (cls === "question" || cls === "curious" || cls === "referral" || cls === "not_now" || cls === "away" || cls === "review") return "warm";
  return "cold";
}
const ROLE_ACCOUNT = /^(info|sales|salj|sälj|kontakt|contact|support|hello|hej|office|admin|order|noreply|no-reply)@/i;

export interface Referral {
  emails: string[];
  best_email: string | null;
  name: string | null;
  replier_gone: boolean | null;
  same_person: boolean;
}

export interface Classification {
  class: string;
  confidence: number;
  draft: string | null;
  followUpAt: Date | null;
  referral: Referral | null;
  newEmail: string | null;
  language: string;
  sentiment: string;
  needsHuman: boolean;
  summary: string | null;
  hasAttachment: boolean;
}

interface RawClassification {
  class?: string;
  confidence?: number;
  draft?: string | null;
  return_date?: string | null;
  referral?: Partial<Referral> | null;
  new_email?: string | null;
  language?: string;
  sentiment?: string;
  needs_human?: boolean;
  summary?: string;
}

function sanitizeDraft(s: string | null | undefined): string | null {
  if (!s) return null;
  const out = String(s)
    .replace(/[—–]/g, ",")
    .replace(/\s+-\s+/g, ", ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out.length >= 15 ? out : null;
}

function greet(draft: string | null, firstName: string | null, language: string | null | undefined): string | null {
  return draft ? fixGreeting(draft, firstName, language) : null;
}

function parseReturnDate(v: string | null | undefined): Date | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T08:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const max = Date.now() + 400 * 86_400_000;
  return d.getTime() > Date.now() - 86_400_000 && d.getTime() < max ? d : null;
}

function mentionedEmails(text: string): Set<string> {
  return new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((e) => normalizeEmail(e).normalized));
}

export function buildClassifierPrompt(args: {
  settings: OrgSettings;
  contact: Contact;
  lastOutbound: string;
  history: { direction: string; body: string | null }[];
  subject: string | null;
  body: string;
  isFirstReply: boolean;
}): string {
  const { settings, contact, lastOutbound, history, subject, body, isFirstReply } = args;
  const brand = brandProfileOf(settings);
  const company = settings.senderCompany || brand.company || "our company";
  const valueProp = (settings.valueProp || brand.valueProp || brand.summary || "").slice(0, 300);
  const facts = [
    contact.fullName && `Name: ${contact.fullName}`,
    contact.title && `Title: ${contact.title}`,
    contact.company && `Company: ${contact.company}`,
    contact.industry && `Industry: ${contact.industry}`,
  ]
    .filter(Boolean)
    .join("\n");
  const historyBlock = history
    .slice(-6)
    .map((m) => `${m.direction === "INBOUND" ? "THEM" : "US"}: ${String(m.body ?? "").replace(/\s+/g, " ").slice(0, 220)}`)
    .join("\n");
  const today = new Date().toISOString().slice(0, 10);

  return `You are the reply-triage brain of a cold-outreach system for ${company}${valueProp ? ` (${valueProp})` : ""}.
A prospect replied. Classify the reply and, when it is a lead, draft our next message.

=== WHAT WE SENT (last message) ===
${lastOutbound.slice(0, 700) || "(unknown)"}
${historyBlock ? `\n=== EARLIER IN THIS CONVERSATION (already said; do not repeat, contradict or add new claims) ===\n${historyBlock}\n` : ""}
=== THE PROSPECT ===
${facts || "(little known)"}

=== THEIR REPLY (subject: ${String(subject ?? "").slice(0, 100)}) ===
${body.slice(0, 1800)}
=== END ===

CLASSIFY into exactly ONE class:
- "hot": wants a meeting, call or demo, says they are interested, asks for price or a proposal with buying energy.
- "question": asks a real question about the offer, results or who we are, without clear buying energy yet.
- "curious": mild positive signal without a question ("interesting, I'll take a look", "forwarding to our marketing lead").
- "not_now": a timing objection only ("not right now", "come back after summer"). Any "not relevant" softened by a time reference is not_now, never not_interested. Put the date they name in return_date.
- "referral": the replier is permanently the wrong person (left the company, "talk to X instead") and points to someone else. Someone merely away on leave is "away".
- "not_interested": a clear, calm, final no. When unsure between not_now and not_interested, choose not_now.
- "stop": any opt-out ("unsubscribe", "remove me", "stop emailing").
- "frustrated": anger, spam accusations, privacy complaints, threats, profanity.
- "away": a human out-of-office or leave note; they will return. Put the return date in return_date. If it names a stand-in with an email to contact meanwhile, put that in referral with replier_gone=false.
- "auto": pure machine mail (bounce notices, read receipts, ticket auto-acknowledgements).
- "moved": the address we used is dead or the person has left and names no reachable colleague. If they give their own new personal address, put it in new_email (never a shared inbox like info@).
- "deceased": the person has died. Never a lead, never extract anyone.
- "review": genuinely mixed or unreadable. When unsure between lead and not-lead, choose review.

PRECEDENCE: interest beats absence; employment status decides referral vs away; a human absence note is away, a system notice is auto.

REFERRAL (for referral, or away with a stand-in): from the prospect's own words only, list the hand-off emails in "emails", the best one in "best_email" (a named person's address beats a shared inbox; null if only a name), the person's "name", "replier_gone" (true only if the replier is leaving or is not the right person) and "same_person" (true if the other address is the replier's own new address).

RETURN DATE: for away or not_now, "return_date" as YYYY-MM-DD relative to today (${today}), or null.

DRAFT (only for hot, question, curious, not_now, referral, review; otherwise null):
- Write in the language the prospect used.
- 35 to 80 words, plain text, no bullet points, no dashes, no links, no sign-off and no name at the end.
- ${isFirstReply ? `Open with a short greeting using their first name on its own line${contact.firstName ? `, written as "Hi ${contact.firstName}," (or the same in their language), never the bare name` : ""}.` : "We already answered earlier in this thread: no greeting, start with substance."}
- Open on substance: the specific thing they said or the direct answer. No reflexive thanks, no praise of their reply, no "I wanted to share".
- Never invent facts, customers, results, numbers or prices. If a question needs facts you do not have, say you will confirm and suggest a short call.
- For not_now: a short, warm acknowledgement that respects their timing.

Also return:
- "confidence": 0 to 1, how sure you are of the class.
- "language": the reply's language code (e.g. "en", "sv", "de").
- "sentiment": "positive", "neutral" or "negative".
- "needs_human": true if the reply asks for something only a person can decide (a contract, a discount, legal terms, a specific proposal).
- "summary": one short sentence describing the reply for the owner.

Return STRICT JSON: {"class":"...","confidence":0.0,"draft":null,"return_date":null,"referral":null,"new_email":null,"language":"en","sentiment":"neutral","needs_human":false,"summary":"..."}`;
}

export async function classifyReply(orgId: string, contactId: string, messageId: string): Promise<Classification | null> {
  const ai = getAi();
  if (!ai) return null;
  const [settings, contact, message] = await Promise.all([
    getSettings(orgId),
    prisma.contact.findFirst({ where: { id: contactId, organizationId: orgId } }),
    prisma.message.findFirst({ where: { id: messageId, organizationId: orgId } }),
  ]);
  if (!contact || !message) return null;
  const history = await prisma.message.findMany({
    where: { organizationId: orgId, contactId, createdAt: { lt: message.createdAt } },
    orderBy: { createdAt: "asc" },
    select: { direction: true, body: true, via: true },
    take: 20,
  });
  const lastOutbound = [...history].reverse().find((m) => m.direction === "OUTBOUND")?.body ?? contact.personalization ?? "";
  const isFirstReply = !history.some((m) => m.direction === "OUTBOUND" && (m.via === "auto-reply" || m.via === "inbox"));
  const body = prospectOwnWords(message.body) || cleanInboundReply(message.body);
  const prompt = buildClassifierPrompt({ settings, contact, lastOutbound, history, subject: message.subject, body, isFirstReply });
  const raw = await ai.generateJSON<RawClassification>(prompt, { maxTokens: 900, temperature: 0.3, meter: { orgId, purpose: "reply" } });
  await addUsage(orgId, "aiCalls");
  if (!raw) return null;

  let cls = String(raw.class ?? "").toLowerCase().trim();
  if (!VALID.has(cls)) cls = "review";
  const own = mentionedEmails(body);
  let referral: Referral | null = null;
  if (raw.referral && (cls === "referral" || cls === "away")) {
    const emails = (raw.referral.emails ?? [])
      .map((e) => normalizeEmail(String(e)).normalized)
      .filter((e) => own.has(e) && e !== contact.emailNormalized);
    const best = raw.referral.best_email ? normalizeEmail(raw.referral.best_email).normalized : null;
    referral = {
      emails,
      best_email: best && own.has(best) && best !== contact.emailNormalized ? best : null,
      name: raw.referral.name ? String(raw.referral.name).slice(0, 120) : null,
      replier_gone: typeof raw.referral.replier_gone === "boolean" ? raw.referral.replier_gone : null,
      same_person: raw.referral.same_person === true,
    };
  }
  const newEmailNorm = raw.new_email ? normalizeEmail(raw.new_email).normalized : null;
  const meta = (message.meta ?? {}) as Record<string, unknown>;
  return {
    class: cls,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0))),
    draft: DRAFT_CLASSES.has(cls) ? greet(sanitizeDraft(raw.draft), contact.firstName, raw.language) : null,
    followUpAt: LATER_CLASSES.has(cls) ? parseReturnDate(raw.return_date) : null,
    referral,
    newEmail: cls === "moved" && newEmailNorm && own.has(newEmailNorm) && !ROLE_ACCOUNT.test(newEmailNorm) ? newEmailNorm : null,
    language: String(raw.language ?? detectLanguage(body) ?? settings.language).slice(0, 8),
    sentiment: String(raw.sentiment ?? "neutral"),
    needsHuman: raw.needs_human === true,
    summary: raw.summary ? String(raw.summary).slice(0, 300) : null,
    hasAttachment: Array.isArray(meta.attachments) && (meta.attachments as unknown[]).length > 0,
  };
}

async function spawnLead(orgId: string, contact: Contact, candidates: string[], name: string | null, source: string): Promise<string | null> {
  const seen = new Set<string>();
  for (const cand of candidates) {
    const norm = normalizeEmail(cand).normalized;
    if (!norm.includes("@") || seen.has(norm) || ROLE_ACCOUNT.test(norm)) continue;
    seen.add(norm);
    const domain = norm.split("@")[1] ?? null;
    const { fresh } = await partitionCandidates(orgId, [{ email: norm, companyDomain: domain }], { skipCompanyCap: true });
    if (!fresh[0]) {
      const exists = await prisma.contact.findFirst({ where: { organizationId: orgId, emailNormalized: norm, source }, select: { id: true } });
      if (exists) return norm;
      continue;
    }
    const sameCompany = !!domain && domain === (contact.companyDomain ?? "").toLowerCase();
    const [first, ...rest] = String(name ?? "").trim().split(/\s+/).filter(Boolean);
    const campaign = contact.campaignId
      ? await prisma.campaign.findFirst({ where: { id: contact.campaignId, organizationId: orgId, status: "ACTIVE" }, select: { id: true } })
      : null;
    try {
      await prisma.contact.create({
        data: {
          organizationId: orgId,
          email: fresh[0]._email,
          emailNormalized: norm,
          domain,
          companyDomain: sameCompany ? contact.companyDomain : domain,
          firstName: first ?? null,
          lastName: rest.join(" ") || null,
          fullName: name,
          company: sameCompany ? contact.company : null,
          website: sameCompany ? contact.website : null,
          industry: sameCompany ? contact.industry : null,
          campaignId: campaign?.id ?? null,
          source,
          fitScore: Math.max(60, contact.fitScore),
          tier: "A",
        },
      });
      return norm;
    } catch {
      return norm;
    }
  }
  return null;
}

export interface AppliedActions {
  class: string;
  urgent: boolean;
  blocked: string | null;
  spawned: string | null;
  emailUpdated: string | null;
}

export async function applyReplyActions(orgId: string, contact: Contact, messageId: string | null, result: Classification, answered = false): Promise<AppliedActions> {
  const cls = result.class;
  const applied: AppliedActions = { class: cls, urgent: false, blocked: null, spawned: null, emailUpdated: null };
  const settings = await getSettings(orgId);
  if (!settings.draftReplies) result = { ...result, draft: null };
  await prisma.contact.update({
    where: { id: contact.id },
    data: { intent: INTENT_OF[cls] ?? "UNCLEAR", intentConfidence: Math.round(result.confidence * 1000) / 1000, intentSetAt: new Date(), customerIntent: null, intentCorrectedAt: null, temperature: temperatureOf(cls) },
  });
  const keepHard = (next: Contact["status"]) => (contact.status === "UNSUBSCRIBED" || contact.status === "BOUNCED" ? contact.status : next);

  if (LEAD_CLASSES.has(cls)) {
    const urgent = !answered && URGENT_CLASSES.has(cls);
    applied.urgent = urgent;
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        replyClass: cls,
        replyUrgent: urgent,
        aiDraft: answered ? null : result.draft,
        aiDraftAt: !answered && result.draft ? new Date() : null,
        followUpAt: LATER_CLASSES.has(cls) ? result.followUpAt : null,
      },
    });
    if (cls === "away" && !answered && result.referral && !result.referral.same_person) {
      const standIns = [result.referral.best_email, ...result.referral.emails].filter((e): e is string => !!e);
      if (standIns.length) applied.spawned = await spawnLead(orgId, contact, standIns, result.referral.name, "referral");
    }
  } else if (cls === "auto") {
    await prisma.contact.update({ where: { id: contact.id }, data: { replyClass: "auto", replyUrgent: false } });
  } else if (cls === "moved") {
    if (result.newEmail) {
      await prisma.contact.update({ where: { id: contact.id }, data: { replyClass: "moved", replyUrgent: false, aiDraft: null } });
      applied.spawned = await spawnLead(orgId, contact, [result.newEmail], contact.fullName, "moved");
      await markNeverAuto(orgId, contact.id, "moved-dead-address");
    } else {
      await prisma.contact.update({ where: { id: contact.id }, data: { status: keepHard("BOUNCED"), replyClass: "moved", replyUrgent: false, aiDraft: null } });
      applied.blocked = "dead-email";
    }
  } else if (cls === "referral") {
    const ref = result.referral;
    let handled = false;
    if (ref?.same_person && ref.best_email && ref.best_email !== contact.emailNormalized) {
      const { fresh } = await partitionCandidates(orgId, [{ email: ref.best_email, companyDomain: ref.best_email.split("@")[1] ?? null }], { skipCompanyCap: true });
      if (fresh[0]) {
        try {
          await prisma.contact.update({
            where: { id: contact.id },
            data: { email: fresh[0]._email, emailNormalized: ref.best_email, domain: ref.best_email.split("@")[1] ?? null, replyClass: "review", replyUrgent: !answered },
          });
          applied.emailUpdated = ref.best_email;
          applied.urgent = !answered;
          handled = true;
        } catch {
          handled = false;
        }
      }
    }
    if (!handled) {
      const candidates = ref ? [ref.best_email, ...ref.emails].filter((e): e is string => !!e) : [];
      const spawned = candidates.length ? await spawnLead(orgId, contact, candidates, ref?.name ?? null, "referral") : null;
      const staying = ref?.replier_gone === false;
      if (spawned && !staying) {
        await prisma.blocklistEntry.upsert({
          where: { organizationId_entryType_value: { organizationId: orgId, entryType: "EMAIL", value: contact.emailNormalized } },
          create: { organizationId: orgId, entryType: "EMAIL", value: contact.emailNormalized, reason: "MANUAL", note: "left company / wrong person (reply)", contactId: contact.id },
          update: { note: "left company / wrong person (reply)" },
        });
        await prisma.contact.update({ where: { id: contact.id }, data: { status: keepHard("BLOCKLISTED"), replyClass: "referral", replyUrgent: false, aiDraft: null } });
        await markNeverAuto(orgId, contact.id, "referral-gone");
        applied.blocked = "email";
        applied.spawned = spawned;
      } else {
        applied.spawned = spawned;
        applied.urgent = !answered;
        await prisma.contact.update({
          where: { id: contact.id },
          data: { replyClass: "referral", replyUrgent: !answered, ...(spawned ? {} : { aiDraft: null }) },
        });
      }
    }
  } else if (cls === "stop" || cls === "frustrated") {
    // Pool-wide and within this cycle: global suppression, this customer's list, and every queued send to the
    // address stopped for every customer. A hostile reply is the one that turns into an abuse complaint against a
    // domain we own, so an operator hears about it.
    await unsubscribeEverywhere(contact.id, "mail", cls === "frustrated" ? "complaint" : "unsubscribe");
    // And nobody else at that company hears from this customer again.
    await blockEmail(orgId, contact.emailNormalized, cls === "frustrated" ? "COMPLAINED" : "UNSUBSCRIBED", contact.id);
    await prisma.contact.update({ where: { id: contact.id }, data: { replyClass: cls, replyUrgent: false, aiDraft: null } });
    await markNeverAuto(orgId, contact.id, `hard-end-${cls}`);
    if (cls === "frustrated") {
      const msg = `Hostile reply from a prospect of this workspace. The address is suppressed across the pool. Check the thread before it turns into an abuse complaint.`;
      await logSystem(null, "CRITICAL", "abuse", msg, { orgId, contactId: contact.id });
      await logSystem(orgId, "WARN", "reply", "Someone replied angrily. They are removed everywhere and will never be emailed again.", { contactId: contact.id });
    }
    applied.blocked = "domain";
  } else {
    const REASON = { not_interested: "MANUAL", deceased: "MANUAL" } as const;
    const STATUS = { not_interested: "BLOCKLISTED", deceased: "BLOCKLISTED" } as const;
    const key = cls as keyof typeof REASON;
    if (REASON[key]) {
      await blockEmail(orgId, contact.emailNormalized, REASON[key], contact.id, { emailOnly: cls === "deceased" });
      await prisma.contact.update({ where: { id: contact.id }, data: { status: keepHard(STATUS[key]), replyClass: cls, replyUrgent: false, aiDraft: null } });
      await markNeverAuto(orgId, contact.id, `hard-end-${cls}`);
      applied.blocked = cls === "deceased" ? "email" : "domain";
    }
  }
  if (messageId) await prisma.message.update({ where: { id: messageId }, data: { intent: cls } });
  return applied;
}

export async function runReplyIntelligence(orgId: string, messageId: string): Promise<Classification | null> {
  const claimed = await prisma.message.updateMany({
    where: {
      id: messageId,
      organizationId: orgId,
      direction: "INBOUND",
      intent: null,
      OR: [{ classifyStartedAt: null }, { classifyStartedAt: { lt: new Date(Date.now() - 10 * 60_000) } }],
      classifyAttempts: { lt: 3 },
    },
    data: { classifyStartedAt: new Date(), classifyAttempts: { increment: 1 } },
  });
  if (!claimed.count) return null;
  const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
  try {
    const result = await classifyReply(orgId, message.contactId, messageId);
    if (!result) {
      await prisma.message.update({ where: { id: messageId }, data: { classifyStartedAt: null } });
      return null;
    }
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: message.contactId } });
    const newer = await prisma.message.count({ where: { organizationId: orgId, contactId: contact.id, direction: "OUTBOUND", createdAt: { gt: message.createdAt } } });
    await applyReplyActions(orgId, contact, messageId, result, newer > 0);
    // Drafted, never sent: the customer sees Send / Edit / Discard. Nothing in the reply path runs on a timer.
    if (newer === 0 && result.draft) {
      const who = [contact.fullName || contact.email, contact.company].filter(Boolean).join(" at ");
      void postToSlack(orgId, `:memo: A reply to *${who}* is drafted and waiting for you in the inbox.`);
    }
    return result;
  } catch (err) {
    logger.error({ orgId, messageId, err: (err as Error).message }, "reply intelligence failed");
    await prisma.message.update({ where: { id: messageId }, data: { classifyStartedAt: null } }).catch(() => undefined);
    return null;
  }
}
