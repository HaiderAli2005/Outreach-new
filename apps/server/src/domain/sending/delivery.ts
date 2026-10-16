import type { Contact, Mailbox, OrgSettings, Send, SendingDomain, SendStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { dateOnly, dayKeyOf } from "../../lib/time.js";
import { logSystem } from "../systemLog.js";
import { getSettings } from "../settings.js";
import { recordMessage } from "../messages.js";
import { blockEmail } from "../suppression.js";
import { assertCanEmail, chargeSend, releaseForContact } from "../credits/index.js";
import { optOutLine, replySignature } from "../sequence.js";
import { recomputeCustomerHealth } from "./health.js";
import { globalSuppress } from "./dedup.js";
import { buildOutbound, composeBody, domainOf, firstNameOf, newMessageId, replySubject, type ThreadParent } from "./message.js";
import { PRICE_PER_EMAIL } from "../money.js";
import { stopSequence } from "./stop.js";
import { countSend } from "./pool.js";
import { credsFor, transportFor, type SendOutcome, type SendResult } from "./transport/index.js";
import { unsubscribeUrl } from "./unsubscribe.js";

/**
 * Putting one email on the wire and recording exactly what the receiving server said. Every outbound email goes
 * through transmit(): first touches (from the pipeline), follow-ups, soft-bounce retries and replies.
 *
 *   SENT            charged $0.04 for every sequence email, first or follow-up; nothing for a reply
 *   HARD_BOUNCE     the address is dead: global suppression, the customer's blocklist, the sequence stops
 *   SOFT_BOUNCE     retried at 15 minutes, 2 hours and 12 hours, then given up. Counts against nothing.
 *   AUTH_FAILURE    our SPF/DKIM/DMARC, or a provider blocking our domain: the domain is paused and an operator is
 *                   alerted. Never counted against the customer.
 */

export type MailboxWithDomain = Mailbox & { sendingDomain: SendingDomain | null };

export const RETRY_BACKOFF_MS = [15 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;
export const MAX_RETRIES = RETRY_BACKOFF_MS.length;

const STATUS_OF: Record<SendOutcome, SendStatus> = {
  SENT: "SENT",
  HARD_BOUNCE: "HARD_BOUNCE",
  SOFT_BOUNCE: "SOFT_BOUNCE",
  RATE_LIMITED: "SOFT_BOUNCE",
  TRANSPORT_ERROR: "SOFT_BOUNCE",
  AUTH_FAILURE: "AUTH_FAILURE",
  DOMAIN_BLOCKED: "AUTH_FAILURE",
};

/**
 * The display name on the From line: always the mailbox's own persona, so the name matches the address
 * (Madison Reed <madison@...>). A name that does not match its address reads as spoofed to people and filters.
 */
export function fromNameFor(mailbox: Pick<Mailbox, "fromNameDefault" | "firstName" | "address">): string {
  return mailbox.fromNameDefault?.trim() || mailbox.firstName?.trim() || mailbox.address.split("@")[0];
}

/** Footer under the sign-off: the opt-out line, and the postal address when the customer set one. */
export function footerFor(settings: Pick<OrgSettings, "senderCompany" | "senderAddress" | "optOutLine" | "language">): string {
  const address = settings.senderAddress?.trim() ? [settings.senderCompany, settings.senderAddress].filter(Boolean).join(", ") : "";
  return [optOutLine(settings), address].filter(Boolean).join("\n");
}

/** Which written text goes out as sequence email 1 to 4. */
export function textForStep(contact: Pick<Contact, "personalization" | "followup2" | "followup3" | "followup4">, step: number): string | null {
  return step === 1 ? contact.personalization : step === 2 ? contact.followup2 : step === 3 ? contact.followup3 : contact.followup4;
}

/** The subject and body of sequence email 1 to 4 for this person, signed with the sender's first name. */
export function composeStep(contact: Contact, step: number, settings: OrgSettings, mailbox: Mailbox, firstSubject: string | null): { subject: string; body: string } {
  const subject = step === 1 ? (contact.messageSubject ?? "") : replySubject(firstSubject ?? contact.messageSubject);
  const body = composeBody({
    text: textForStep(contact, step) ?? "",
    senderFirstName: firstNameOf(fromNameFor(mailbox)),
    footer: footerFor(settings),
    unsubscribeUrl: step === 1 ? null : unsubscribeUrl(contact.id, domainOf(mailbox.address)),
  });
  return { subject, body };
}

/** Pauses a domain for an authentication failure or a provider block on our side, and alerts an operator once. */
export async function pauseDomain(domainId: string, reason: string): Promise<void> {
  const r = await prisma.sendingDomain.updateMany({ where: { id: domainId, pausedAt: null }, data: { pausedAt: new Date(), pauseReason: reason.slice(0, 300) } });
  if (r.count) {
    const d = await prisma.sendingDomain.findUnique({ where: { id: domainId }, select: { name: true } });
    await logSystem(null, "CRITICAL", "pool", `${d?.name ?? "A pool domain"} is paused: ${reason}. This is our own configuration, not a customer's list. Check its SPF, DKIM and DMARC, then resume it in /admin/pool.`, { domainId });
  }
}

/** A rate-limited mailbox takes no more cold email today. */
async function lowerCap(mailboxId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "Mailbox" m SET "sendCapToday" = GREATEST(0, LEAST(m."sendCapToday", CASE WHEN m."sentTodayOn" = (now() AT TIME ZONE m."timezone")::date THEN m."sentToday" ELSE 0 END)) WHERE m.id = $1`,
    mailboxId,
  );
}

export async function bumpDomainDay(domainId: string | null, field: "sends" | "hardBounces" | "complaints", at = new Date()): Promise<void> {
  if (!domainId) return;
  const day = dateOnly(dayKeyOf(at));
  await prisma.domainHealthDaily.upsert({ where: { domainId_day: { domainId, day } }, create: { domainId, day, [field]: 1 }, update: { [field]: { increment: 1 } } });
}

/** The address is dead: nobody in the pool emails it again, and this person's sequence ends. */
export async function onDeadAddress(orgId: string, contact: Pick<Contact, "id" | "emailNormalized">, reason: "hard_bounce" | "complaint"): Promise<void> {
  await globalSuppress(contact.emailNormalized, reason);
  await blockEmail(orgId, contact.emailNormalized, reason === "complaint" ? "COMPLAINED" : "BOUNCED", contact.id, { emailOnly: true });
  await prisma.contact.update({ where: { id: contact.id }, data: { status: reason === "complaint" ? "UNSUBSCRIBED" : "BOUNCED" } });
  await stopSequence(contact.id, reason === "complaint" ? "complained" : "bounced");
  await releaseForContact(contact.id, reason === "complaint" ? "Marked as spam" : "Bounced");
}

export interface TransmitInput {
  orgId: string;
  contact: Contact;
  mailbox: MailboxWithDomain;
  campaignId: string | null;
  /** 1 to 3 for the sequence, 0 for a reply in a conversation. */
  step: number;
  isFirstTouch: boolean;
  subject: string;
  body: string;
  parent?: ThreadParent | null;
  via: "sequence" | "inbox" | "auto-reply";
  /** A soft-bounced send being tried again: same row, same Message-ID. */
  existing?: Send | null;
  reroutedFromId?: string | null;
  /** First touches and replies wait and try again whole when our own server can't be reached; nothing is recorded. */
  recordTransportErrors?: boolean;
  /** The first touch already took today's slot when its mailbox was picked. */
  slotTaken?: boolean;
}

export interface TransmitResult {
  outcome: SendOutcome;
  result: SendResult;
  send: Send | null;
}

export async function transmit(i: TransmitInput): Promise<TransmitResult> {
  const m = i.mailbox;
  const settings = await getSettings(i.orgId);
  const messageId = i.existing?.messageId ?? newMessageId(m.address);
  const outbound = buildOutbound({
    fromName: fromNameFor(m),
    fromAddress: m.address,
    to: i.contact.email,
    subject: i.subject,
    body: i.body,
    messageId,
    unsubscribeUrl: unsubscribeUrl(i.contact.id, domainOf(m.address)),
    parent: i.parent ?? null,
  });

  let result: SendResult;
  try {
    result = await transportFor(m.transportRef).send(await credsFor(m), outbound);
  } catch (e) {
    result = { outcome: "TRANSPORT_ERROR", smtpCode: null, enhancedCode: null, response: (e as Error).message.slice(0, 300) };
  }
  const outcome = result.outcome;

  if (outcome === "TRANSPORT_ERROR") {
    await prisma.mailbox.update({ where: { id: m.id }, data: { lastError: result.response.slice(0, 300) } });
    logger.warn({ mailboxId: m.id, response: result.response }, "mail server not reachable");
    if (!i.recordTransportErrors && !i.existing) return { outcome, result, send: null };
  }
  if (!i.slotTaken && outcome !== "TRANSPORT_ERROR") await countSend(m.id);

  const status = STATUS_OF[outcome];
  const now = new Date();
  const retryCount = i.existing ? i.existing.retryCount + 1 : 0;
  const soft = status === "SOFT_BOUNCE";
  const giveUp = soft && retryCount >= MAX_RETRIES;
  const data = {
    status,
    smtpCode: result.smtpCode,
    enhancedCode: result.enhancedCode,
    bounceReason: status === "SENT" ? null : result.response.slice(0, 500),
    bounceCode: status === "SENT" ? null : (result.enhancedCode ?? result.smtpCode),
    bounceParse: status === "HARD_BOUNCE" || status === "SOFT_BOUNCE" ? "smtp" : null,
    nextRetryAt: soft && !giveUp ? new Date(now.getTime() + RETRY_BACKOFF_MS[Math.min(retryCount, MAX_RETRIES - 1)]) : null,
    resolvedAt: status === "SENT" || (soft && !giveUp) ? null : now,
    sentAt: now,
  };
  const send = i.existing
    ? await prisma.send.update({ where: { id: i.existing.id }, data: { ...data, retryCount } })
    : await prisma.send.create({
        data: {
          ...data,
          organizationId: i.orgId,
          campaignId: i.campaignId,
          contactId: i.contact.id,
          mailboxId: m.id,
          domainId: m.sendingDomainId,
          isFirstTouch: i.isFirstTouch,
          step: i.step,
          messageId,
          inReplyTo: outbound.inReplyTo ?? null,
          referencesChain: outbound.references ?? [],
          subject: i.subject.slice(0, 500),
          reroutedFromId: i.reroutedFromId ?? null,
        },
      });

  // What each outcome means beyond this row.
  if (status === "SENT") {
    // Every email that goes out is charged the same, a reply included.
    await chargeSend(i.orgId, send.id, i.contact.id, PRICE_PER_EMAIL);
    await bumpDomainDay(m.sendingDomainId, "sends", now);
    if (i.via === "sequence") await recordOnce(i.orgId, i.contact.id, i.campaignId, i.via, i.subject, i.body, messageId, now);
    await prisma.contact.update({ where: { id: i.contact.id }, data: { lastContactedAt: now } });
  } else if (status === "HARD_BOUNCE") {
    await bumpDomainDay(m.sendingDomainId, "sends", now);
    await bumpDomainDay(m.sendingDomainId, "hardBounces", now);
    await onDeadAddress(i.orgId, i.contact, "hard_bounce");
    if (i.isFirstTouch) await recomputeCustomerHealth(i.orgId);
  } else if (status === "AUTH_FAILURE") {
    if (m.sendingDomainId) await pauseDomain(m.sendingDomainId, `${outcome === "DOMAIN_BLOCKED" ? "a provider blocked the domain" : "receiving servers rejected our authentication"} (${result.enhancedCode ?? result.smtpCode ?? "no code"})`);
  } else if (soft) {
    if (outcome === "RATE_LIMITED") await lowerCap(m.id);
    if (giveUp) {
      // Three tries over a day and still refused for now: this email is not going. Nothing counts against anyone.
      if (i.step >= 1) await releaseForContact(i.contact.id, "Could not be delivered");
      if (i.isFirstTouch) await prisma.contact.update({ where: { id: i.contact.id }, data: { status: "BOUNCED" } });
    }
  }
  return { outcome, result, send };
}

/** The conversation shows each email once, however many delivery attempts it took. */
async function recordOnce(orgId: string, contactId: string, campaignId: string | null, via: string, subject: string, body: string, emailMessageId: string, at = new Date()): Promise<void> {
  const seen = await prisma.message.findFirst({ where: { contactId, direction: "OUTBOUND", emailMessageId }, select: { id: true } });
  if (!seen) await recordMessage(prisma, { organizationId: orgId, contactId, campaignId, direction: "OUTBOUND", via, subject, body, emailMessageId, createdAt: at });
}

/** The newest message in this person's thread that a reply should answer: their own last email, else ours. */
async function threadParent(contactId: string): Promise<{ parent: ThreadParent | null; subject: string | null }> {
  const lastSend = await prisma.send.findFirst({ where: { contactId, messageId: { not: null }, status: { in: ["SENT", "DELIVERED", "SOFT_BOUNCE"] } }, orderBy: { sentAt: "desc" } });
  const lastIn = await prisma.message.findFirst({ where: { contactId, direction: "INBOUND", emailMessageId: { not: null } }, orderBy: { createdAt: "desc" } });
  const firstSend = await prisma.send.findFirst({ where: { contactId, step: 1, messageId: { not: null } }, orderBy: { sentAt: "asc" }, select: { subject: true } });
  const chain = lastSend ? [...lastSend.referencesChain, lastSend.messageId!] : [];
  if (lastIn?.emailMessageId && (!lastSend || lastIn.createdAt >= lastSend.sentAt)) return { parent: { messageId: lastIn.emailMessageId, references: chain }, subject: firstSend?.subject ?? lastIn.subject };
  if (lastSend) return { parent: { messageId: lastSend.messageId!, references: lastSend.referencesChain }, subject: firstSend?.subject ?? lastSend.subject };
  return { parent: null, subject: firstSend?.subject ?? null };
}

export class ReplyError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * A reply in a conversation, written by the customer in the inbox or by the automatic replies. Always from the
 * mailbox the person is pinned to, threaded under their last email, free of charge, and never blocked by the
 * balance, the customer's health or the mailbox's state: conversations always continue.
 */
export async function sendReply(orgId: string, contactId: string, text: string, via: "inbox" | "auto-reply"): Promise<{ sendId: string; messageId: string }> {
  const contact = await prisma.contact.findFirstOrThrow({ where: { id: contactId, organizationId: orgId } });
  if (!contact.assignedMailboxId) throw new ReplyError("There is no email thread with this person yet.", false);
  await assertCanEmail(orgId, contactId);
  const mailbox = await prisma.mailbox.findUniqueOrThrow({ where: { id: contact.assignedMailboxId }, include: { sendingDomain: true } });
  if (mailbox.status === "RETIRED") throw new ReplyError("The mailbox this conversation used has been retired.", false);
  const settings = await getSettings(orgId);
  const { parent, subject } = await threadParent(contact.id);
  const cold = !contact.repliedAt && !contact.hasInbound;
  const body = `${text.trim()}\n\n${replySignature(settings, { name: firstNameOf(fromNameFor(mailbox)), cold })}`;
  const r = await transmit({ orgId, contact, mailbox, campaignId: contact.campaignId, step: 0, isFirstTouch: false, subject: replySubject(subject), body, parent, via });
  if (r.outcome === "TRANSPORT_ERROR" || !r.send) throw new ReplyError(`The mail server could not be reached: ${r.result.response}`, true);
  if (r.outcome !== "SENT" && r.outcome !== "SOFT_BOUNCE" && r.outcome !== "RATE_LIMITED") throw new ReplyError(`The reply was refused: ${r.result.response}`, false);
  await recordOnce(orgId, contactId, contact.campaignId, via, r.send.subject ?? "", body, r.send.messageId!);
  return { sendId: r.send.id, messageId: r.send.messageId! };
}
