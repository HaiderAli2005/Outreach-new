import { assertCanEmail } from "../../domain/credits/index.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { conflict, notFound, unprocessable, upstream } from "../../lib/errors.js";
import { fromNameFor, ReplyError, sendReply } from "../../domain/sending/delivery.js";
import { firstNameOf } from "../../domain/sending/message.js";
import { getSettings } from "../../domain/settings.js";
import { activeOnly, leadClassOrUnread, LEAD_CLASSES } from "../../domain/needsReply.js";
import { blockEmail, isOptedOut } from "../../domain/suppression.js";
import { discardDraft as dropDraft, markHandoff, markNeverAuto, VIA_INBOX } from "../../domain/conversation.js";
import { stopSequence } from "../../domain/sending/stop.js";
import { INTENTS, type Intent } from "../../domain/replyIntelligence.js";
import { vocabFor } from "../../domain/leadStatus.js";
import { ctaLine, replySignature } from "../../domain/sequence.js";
import { fixGreeting, splitQuoted, trimQuotedPreview } from "../../domain/replyText.js";

export const INBOX_FILTERS = ["all", "needs", "replied", "sent"] as const;
export const REPLY_FILTERS = ["urgent", "lead", "hot", "question", "review", "curious", "not_now", "away", "moved", "auto"] as const;
const LINKABLE = new Set(["hot", "question", "curious", "review", "not_now"]);

function stateWhere(filter: string, explicitClass: boolean): Prisma.ContactWhereInput {
  switch (filter) {
    case "needs":
      return { AND: [{ lastMessageDirection: "INBOUND" }, ...(explicitClass ? [] : [leadClassOrUnread]), activeOnly] };
    case "replied":
      return { hasInbound: true, OR: [{ lastMessageDirection: { not: "INBOUND" } }, { handledAt: { not: null } }] };
    case "sent":
      return { OR: [{ lastMessageDirection: { not: "INBOUND" } }, { lastMessageDirection: null }] };
    default:
      return {};
  }
}

function replyWhere(reply: string | undefined): Prisma.ContactWhereInput {
  if (!reply) return {};
  if (reply === "urgent") return { replyUrgent: true };
  if (reply === "lead") return { replyClass: { in: LEAD_CLASSES } };
  return { replyClass: reply };
}

export async function list(orgId: string, q: { filter: string; reply?: string; page: number; limit: number }) {
  const base: Prisma.ContactWhereInput = {
    organizationId: orgId,
    messageCount: { gt: 0 },
    OR: [{ status: { notIn: ["BLOCKLISTED", "BOUNCED", "UNSUBSCRIBED", "NO_RESPONSE"] } }, { hasInbound: true }],
  };
  const explicitClass = !!q.reply && !["urgent", "lead"].includes(q.reply);
  const rw = replyWhere(q.reply);
  const where: Prisma.ContactWhereInput = { AND: [base, stateWhere(q.filter, explicitClass), rw] };
  const countState = stateWhere(q.filter, false);

  const [rows, total, all, needs, replied, sent, urgent, byClassRows] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: [{ lastMessageDirection: { sort: "asc", nulls: "last" } }, { replyUrgent: "desc" }, { lastMessageAt: { sort: "desc", nulls: "last" } }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: {
        id: true, fullName: true, email: true, company: true, title: true, photoUrl: true, status: true, tier: true, fitScore: true,
        replyClass: true, replyUrgent: true, followUpAt: true, aiDraft: true, repliedAt: true, lastMessageAt: true, intent: true, customerIntent: true, temperature: true,
        lastMessageDirection: true, lastMessagePreview: true, messageCount: true, hasInbound: true, handledAt: true,
      },
    }),
    prisma.contact.count({ where }),
    prisma.contact.count({ where: { AND: [base, rw] } }),
    prisma.contact.count({ where: { AND: [base, stateWhere("needs", explicitClass), rw] } }),
    prisma.contact.count({ where: { AND: [base, stateWhere("replied", false), rw] } }),
    prisma.contact.count({ where: { AND: [base, stateWhere("sent", false), rw] } }),
    prisma.contact.count({ where: { AND: [base, countState, { replyUrgent: true }] } }),
    prisma.contact.groupBy({ by: ["replyClass"], where: { AND: [base, countState, { replyClass: { not: null } }] }, _count: { _all: true } }),
  ]);
  const byClass: Record<string, number> = {};
  for (const r of byClassRows) if (r.replyClass) byClass[r.replyClass] = r._count._all;
  return {
    rows: rows.map(({ aiDraft, ...r }) => ({
      ...r,
      lastMessagePreview: r.lastMessageDirection === "INBOUND" ? trimQuotedPreview(r.lastMessagePreview) : r.lastMessagePreview,
      hasDraft: !!aiDraft, needsReply: r.lastMessageDirection === "INBOUND" && !r.handledAt, leadStatus: r.customerIntent ?? r.intent })),
    total,
    counts: { all, needs, replied, sent, urgent, byClass },
  };
}

async function loadContact(orgId: string, contactId: string) {
  const c = await prisma.contact.findFirst({ where: { id: contactId, organizationId: orgId } });
  if (!c) throw notFound("Conversation");
  return c;
}

export async function thread(orgId: string, contactId: string) {
  const contact = await loadContact(orgId, contactId);
  const [messages, settings, campaign, vocab] = await Promise.all([
    prisma.message.findMany({ where: { organizationId: orgId, contactId }, orderBy: { createdAt: "asc" } }),
    getSettings(orgId),
    contact.campaignId ? prisma.campaign.findFirst({ where: { id: contact.campaignId, organizationId: orgId }, select: { id: true, name: true, language: true } }) : null,
    vocabFor(orgId),
  ]);
  const view = messages.map((m) => {
    const meta = (m.meta ?? {}) as Record<string, unknown>;
    const attachments = Array.isArray(meta.attachments)
      ? (meta.attachments as Record<string, unknown>[])
          .filter((a) => a && (a.file_url || a.url))
          .map((a) => ({ url: String(a.file_url ?? a.url), name: String(a.file_name ?? a.name ?? "attachment") }))
      : [];
    // Their own words up front; the quoted history under a reply comes separately so the inbox can fold it.
    const split = m.direction === "INBOUND" ? splitQuoted(m.body) : null;
    return {
      id: m.id,
      direction: m.direction,
      via: m.via,
      subject: m.subject,
      body: split ? split.own || split.quoted || "" : (m.body ?? ""),
      quoted: split?.own ? split.quoted : null,
      intent: m.intent,
      createdAt: m.createdAt,
      attachments,
    };
  });
  const firstOut = messages.find((m) => m.direction === "OUTBOUND");
  const language = campaign?.language ?? settings.language;
  let draft = contact.aiDraft ? fixGreeting(contact.aiDraft, contact.firstName, language) : null;
  if (draft) {
    const includeLink = !!settings.meetingLink && !contact.linkSentAt && LINKABLE.has(contact.replyClass ?? "");
    if (includeLink && settings.meetingLink && !draft.includes(settings.meetingLink)) draft = `${draft}\n\n${ctaLine(language)}\n${settings.meetingLink}`;
  }
  const gate = replyGate(contact);
  // Exactly what a reply from here carries under the text (see sendReply): the sign-off with the mailbox's first
  // name, the company, and the opt-out line only while they have never answered.
  const mailbox = contact.assignedMailboxId ? await prisma.mailbox.findUnique({ where: { id: contact.assignedMailboxId }, select: { fromNameDefault: true, firstName: true, address: true } }) : null;
  const signature = replySignature(settings, { name: mailbox ? firstNameOf(fromNameFor(mailbox)) : null, cold: !contact.repliedAt && !contact.hasInbound });
  return {
    contact: { ...contact, aiDraft: draft, raw: undefined },
    campaign,
    messages: view,
    email: {
      fromCompany: settings.senderCompany,
      fromName: mailbox ? fromNameFor(mailbox) : null,
      subject: firstOut?.subject ?? contact.messageSubject,
      signature,
      sentAt: firstOut?.createdAt ?? contact.firstContactedAt,
    },
    // A draft waits for Send, Edit or Discard. Nothing here is ever sent on a timer.
    draft: draft ? { body: draft, at: contact.aiDraftAt } : null,
    intent: { model: contact.intent, customer: contact.customerIntent, confidence: contact.intentConfidence === null ? null : Number(contact.intentConfidence), temperature: contact.temperature, vocab },
    sequence: { stoppedAt: contact.sequenceStoppedAt, reason: contact.sequenceStopReason, nextAt: contact.nextTouchAt },
    canReply: gate.ok,
    replyBlockedReason: gate.ok ? null : gate.reason,
    coldMessageLeft: gate.ok && !contact.repliedAt ? 1 : null,
  };
}

/**
 * Manual messages: unlimited once the prospect has replied. Before that, ONE message may go into the cold thread,
 * and then it locks until they answer: extra messages to someone who never replied are what earn complaints on
 * domains we own.
 */
export function replyGate(c: { repliedAt: Date | null; hasInbound: boolean; manualColdMessageAt: Date | null; assignedMailboxId: string | null; status: string }): { ok: true } | { ok: false; reason: string } {
  if (c.status === "UNSUBSCRIBED") return { ok: false, reason: "unsubscribed" };
  if (!c.assignedMailboxId) return { ok: false, reason: "no_thread" };
  if (c.repliedAt || c.hasInbound) return { ok: true };
  if (c.manualColdMessageAt) return { ok: false, reason: "awaiting_their_reply" };
  return { ok: true };
}

export async function reply(orgId: string, contactId: string, bodyRaw: string) {
  const body = bodyRaw.trim();
  const c = await loadContact(orgId, contactId);
  if (c.status === "UNSUBSCRIBED" || (await isOptedOut(orgId, c.emailNormalized, c.companyDomain ?? c.domain))) {
    throw conflict("This person opted out. Their thread stays visible for reference, but we do not email them again.");
  }
  if (!c.assignedMailboxId) throw unprocessable("There is no email thread with this person yet.");
  const gate = replyGate(c);
  if (!gate.ok) throw conflict("You've sent your one message into this thread. It unlocks as soon as they reply.");
  const cold = !c.repliedAt && !c.hasInbound;
  const settings = await getSettings(orgId);
  // Checked before anything changes: a reply to someone who wrote back may spend to zero, a cold message keeps the
  // reply reserve. Every email costs the same $0.04.
  await assertCanEmail(orgId, c.id);

  await markHandoff(orgId, c.id, "inbox-reply");
  // Writing to them yourself takes over from the sequence: no automatic follow-up lands on top of your message.
  await stopSequence(c.id, "manual");

  // From the mailbox this person is pinned to, threaded under their last message, at the flat price.
  try {
    await sendReply(orgId, c.id, body, VIA_INBOX);
  } catch (err) {
    if (err instanceof ReplyError) throw err.retryable ? upstream("Mail server", err.message) : unprocessable(err.message);
    throw err;
  }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.contact.update({
        where: { id: c.id },
        data: {
          aiDraft: null,
          aiDraftAt: null,
          replyUrgent: false,
          followUpAt: null,
          ...(cold ? { manualColdMessageAt: new Date() } : {}),
          ...(settings.meetingLink && body.includes(settings.meetingLink) && !c.linkSentAt ? { linkSentAt: new Date() } : {}),
        },
      });
    });
  } catch {
    // The email is delivered; bookkeeping failure must not be reported as a failed send.
  }
  return { sent: true };
}

export async function dealClosed(orgId: string, contactId: string) {
  const c = await loadContact(orgId, contactId);
  await blockEmail(orgId, c.emailNormalized, "DEAL_CLOSED", c.id);
  await prisma.contact.update({ where: { id: c.id }, data: { status: "BLOCKLISTED", aiDraft: null, aiDraftAt: null, replyUrgent: false, followUpAt: null } });
  await markNeverAuto(orgId, c.id, "deal-closed");
  await dropDraft(orgId, c.id);
  await stopSequence(c.id, "manual");
  return { closed: true, name: c.fullName ?? c.email };
}

export async function handled(orgId: string, contactId: string) {
  const r = await prisma.contact.updateMany({ where: { id: contactId, organizationId: orgId }, data: { handledAt: new Date() } });
  if (!r.count) throw notFound("Conversation");
  return { handled: true };
}

export async function remove(orgId: string, contactId: string) {
  const c = await loadContact(orgId, contactId);
  await blockEmail(orgId, c.emailNormalized, "REMOVED", c.id, { emailOnly: true });
  await prisma.contact.update({
    where: { id: c.id },
    data: { status: "BLOCKLISTED", aiDraft: null, aiDraftAt: null, replyUrgent: false, followUpAt: null, handledAt: new Date() },
  });
  await markNeverAuto(orgId, c.id, "removed");
  await dropDraft(orgId, c.id);
  await stopSequence(c.id, "manual");
  return { removed: true, blocked: c.emailNormalized, name: c.fullName ?? c.email };
}

/** Discard a drafted reply. */
export async function discardDraft(orgId: string, contactId: string) {
  await loadContact(orgId, contactId);
  await dropDraft(orgId, contactId);
  return { discarded: true };
}

/** The customer's one-click correction of a reply's intent. Stored next to the model's call; reviewed weekly. */
export async function correctIntent(orgId: string, contactId: string, intent: string) {
  const c = await loadContact(orgId, contactId);
  const vocab = await vocabFor(orgId);
  if (!vocab.some((v) => v.key === intent)) throw unprocessable("That status isn't in your list.");
  await prisma.contact.update({ where: { id: c.id }, data: { customerIntent: intent, intentCorrectedAt: new Date() } });
  // A correction to UNSUBSCRIBE or HOSTILE is acted on like the real thing.
  if ((INTENTS as readonly string[]).includes(intent) && ["UNSUBSCRIBE", "HOSTILE"].includes(intent as Intent)) {
    const { unsubscribeEverywhere } = await import("../../domain/sending/unsubscribe.js");
    await unsubscribeEverywhere(c.id, "mail", intent === "HOSTILE" ? "complaint" : "unsubscribe");
  }
  return { intent: c.intent, customerIntent: intent };
}
