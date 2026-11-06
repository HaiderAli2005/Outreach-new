import { simpleParser, type ParsedMail } from "mailparser";
import type { Mailbox, Send } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { recordInboundReply } from "../replyIngest.js";
import { runReplyIntelligence } from "../replyIntelligence.js";
import { applyLateOutcome, onConversationStopped } from "./events.js";
import { stopColleagues, stopSequence } from "./stop.js";
import { stripPrefixes } from "./message.js";
import { unsubscribeEverywhere } from "./unsubscribe.js";
import type { InboundRaw } from "./transport/types.js";

/**
 * Reading the pool's mailboxes. Each new message is classified, in this order, and the first match wins:
 *
 *   1 BOUNCE       multipart/report; report-type=delivery-status (RFC 3464), or from MAILER-DAEMON / postmaster
 *   (complaint)    multipart/report; report-type=feedback-report (ARF), a spam complaint relayed by a provider
 *   2 AUTO-REPLY   Auto-Submitted present and not "no", X-Autoreply, X-Autorespond, Precedence auto_reply/bulk/junk
 *                  recorded, never counted as a human reply, never stops the sequence
 *   (unsubscribe)  a reply whose subject is "unsubscribe" (the List-Unsubscribe mailto)
 *   3 HUMAN REPLY  anything else: recorded, and the sequence stops at once
 *
 * An out-of-office counted as a human reply would stop a sequence that should have continued and inflate the
 * customer's reply rate, which is why the auto-reply check comes before the human one.
 */

/** "history" is mail that was already in the inbox before the mailbox joined Aperture: kept for the record, never acted on. */
export type InboundKind = "bounce" | "complaint" | "auto_reply" | "unsubscribe" | "human_reply" | "unmatched" | "history" | "warmup";

/**
 * A mailbox whose supplier still runs warmup on it (InboxKit, kept on after it goes live) receives the warmup network's
 * messages. They answer nothing we sent, so one that matches no conversation is recorded as warmup and nobody has to
 * look at it. A real reply always carries our thread headers and is matched before this applies.
 */
const SUPPLIER_WARMUP_ON = ["active", "paused", "pending_activation", "past_due"];
const underSupplierWarmup = (m: Pick<Mailbox, "supplierWarmupStatus">) => !!m.supplierWarmupStatus && SUPPLIER_WARMUP_ON.includes(m.supplierWarmupStatus);

/** Clocks differ a little between mail servers, so "before the mailbox joined" allows an hour of slack. */
const HISTORY_SLACK_MS = 3_600_000;
const wroteBefore = (date: Date | null | undefined, joined: Date) => !!date && !Number.isNaN(date.getTime()) && date.getTime() < joined.getTime() - HISTORY_SLACK_MS;

// ─── a tiny MIME splitter for delivery and feedback reports ────────────────────
// mailparser folds message/delivery-status into the text, so reports are read part by part here.

interface Part {
  headers: Map<string, string>;
  body: string;
}

function splitHeaders(block: string): { headers: Map<string, string>; body: string } {
  const at = block.search(/\r?\n\r?\n/);
  const head = at < 0 ? block : block.slice(0, at);
  const body = at < 0 ? "" : block.slice(at).replace(/^\r?\n\r?\n/, "");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return { headers, body };
}

function boundaryOf(contentType: string | undefined): string | null {
  const m = (contentType ?? "").match(/boundary="?([^";]+)"?/i);
  return m ? m[1] : null;
}

/** The direct parts of a multipart message. */
export function mimeParts(raw: string): { top: Map<string, string>; parts: Part[] } {
  const { headers: top, body } = splitHeaders(raw);
  const boundary = boundaryOf(top.get("content-type"));
  if (!boundary) return { top, parts: [] };
  const chunks = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\r?\\n?`));
  const parts = chunks.map((c) => c.trim() && splitHeaders(c)).filter((p): p is Part => !!p && p.headers.size > 0);
  return { top, parts };
}

/** RFC 3464 fields of a message/delivery-status part, per recipient (the first one is enough for one recipient). */
export function parseDeliveryStatus(body: string): { action: string | null; status: string | null; diagnostic: string | null; recipient: string | null } {
  const groups = body.split(/\r?\n\r?\n/).map((g) => splitHeaders(`${g}\n\n`).headers);
  const r = groups.find((g) => g.has("action") || g.has("status")) ?? new Map();
  const recipient = (r.get("final-recipient") ?? r.get("original-recipient") ?? "").replace(/^rfc822;\s*/i, "").trim() || null;
  return { action: r.get("action")?.toLowerCase() ?? null, status: r.get("status")?.match(/[245]\.\d{1,3}\.\d{1,3}/)?.[0] ?? null, diagnostic: r.get("diagnostic-code") ?? null, recipient };
}

const MSGID = /<[^<>\s@]+@[^<>\s]+>/g;

/** The Message-ID of OUR original email, from the returned headers (message/rfc822 or text/rfc822-headers). */
export function originalMessageId(parts: Part[]): string | null {
  for (const p of parts) {
    const ct = (p.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.startsWith("message/rfc822") && !ct.startsWith("text/rfc822-headers")) continue;
    const m = p.body.match(/^message-id:\s*(<[^>]+>)/im);
    if (m) return m[1];
  }
  return null;
}

export interface Parsed {
  mail: ParsedMail;
  raw: string;
  from: string;
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string;
  header: (name: string) => string;
}

export async function parseInbound(source: Buffer): Promise<Parsed> {
  const mail = await simpleParser(source, { skipHtmlToText: false });
  const raw = source.toString("utf8");
  const header = (name: string) => {
    const v = mail.headers.get(name.toLowerCase());
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object" && "value" in (v as object)) return String((v as { value: unknown }).value);
    return String(v);
  };
  const from = (mail.from?.value?.[0]?.address ?? "").toLowerCase();
  const refs = mail.references ? (Array.isArray(mail.references) ? mail.references : [mail.references]) : [];
  return {
    mail,
    raw,
    from,
    subject: mail.subject ?? "",
    messageId: mail.messageId ?? null,
    inReplyTo: (mail.inReplyTo ?? "").match(MSGID)?.[0] ?? null,
    references: refs.flatMap((r) => r.match(MSGID) ?? []),
    text: mail.text ?? "",
    header,
  };
}

const DAEMON = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i;

export function classify(p: Parsed): "bounce" | "complaint" | "auto_reply" | "unsubscribe" | "human_reply" {
  const ct = p.header("content-type").toLowerCase() + " " + (p.raw.match(/^content-type:[^\n]*(\n[ \t][^\n]*)*/im)?.[0] ?? "").toLowerCase();
  if (/multipart\/report/.test(ct) && /report-type="?feedback-report/.test(ct)) return "complaint";
  if ((/multipart\/report/.test(ct) && /report-type="?delivery-status/.test(ct)) || DAEMON.test(p.from)) return "bounce";
  const auto = p.header("auto-submitted").toLowerCase();
  if ((auto && auto !== "no") || p.header("x-autoreply") || p.header("x-autorespond") || /^(auto_reply|bulk|junk)$/i.test(p.header("precedence").trim())) return "auto_reply";
  if (/^\s*unsubscribe\s*$/i.test(stripPrefixes(p.subject))) return "unsubscribe";
  return "human_reply";
}

/**
 * Finds the email this message answers, most reliable first:
 *   1 In-Reply-To is a Message-ID we issued
 *   2 any id in References is one we issued
 *   3 the sender is someone we emailed from THIS mailbox and the subject matches once Re:/Fwd: are stripped
 */
export async function matchThread(p: Parsed, mailbox: Pick<Mailbox, "id">): Promise<Send | null> {
  if (p.inReplyTo) {
    const s = await prisma.send.findUnique({ where: { messageId: p.inReplyTo } });
    if (s) return s;
  }
  if (p.references.length) {
    const s = await prisma.send.findFirst({ where: { messageId: { in: p.references } }, orderBy: { sentAt: "desc" } });
    if (s) return s;
  }
  if (p.from) {
    const subject = stripPrefixes(p.subject).toLowerCase();
    const candidates = await prisma.send.findMany({
      where: { mailboxId: mailbox.id, messageId: { not: null }, contact: { emailNormalized: normalizeEmail(p.from).normalized } },
      orderBy: { sentAt: "desc" },
      take: 10,
    });
    const s = candidates.find((c) => stripPrefixes(c.subject ?? "").toLowerCase() === subject) ?? null;
    if (s) return s;
  }
  return null;
}

/** Bounce reports: matched by OUR Message-ID in the returned headers, classified by the Status field. */
async function handleBounce(p: Parsed): Promise<{ kind: InboundKind; send: Send | null }> {
  const { parts } = mimeParts(p.raw);
  const dsnPart = parts.find((x) => (x.headers.get("content-type") ?? "").toLowerCase().startsWith("message/delivery-status"));
  const original = originalMessageId(parts);
  if (dsnPart) {
    const d = parseDeliveryStatus(dsnPart.body);
    const send = original ? await prisma.send.findUnique({ where: { messageId: original } }) : null;
    if (!send) return { kind: "unmatched", send: null };
    // delayed and delivered are not bounces at all.
    if (d.action !== "failed") return { kind: "bounce", send };
    const permanent = (d.status ?? "").startsWith("5");
    await applyLateOutcome(send, permanent ? "HARD_BOUNCE" : "SOFT_BOUNCE", { code: d.status, reason: d.diagnostic, parse: "dsn" });
    return { kind: "bounce", send };
  }
  // No report structure: look for one of our Message-IDs and a 55x code in the body. Only a confident match is
  // taken as a hard bounce; anything less waits for an operator.
  const ids = [...new Set(p.raw.match(MSGID) ?? [])];
  const send = ids.length ? await prisma.send.findFirst({ where: { messageId: { in: ids } }, orderBy: { sentAt: "desc" } }) : null;
  const hard = /\b55\d\b|\b5\.\d{1,3}\.\d{1,3}\b/.test(p.text);
  if (send && hard) {
    await applyLateOutcome(send, "HARD_BOUNCE", { code: p.text.match(/\b5\.\d{1,3}\.\d{1,3}\b/)?.[0] ?? p.text.match(/\b55\d\b/)?.[0] ?? null, reason: p.text.slice(0, 300), parse: "heuristic" });
    return { kind: "bounce", send };
  }
  return { kind: "unmatched", send };
}

/** ARF feedback reports: a recipient marked our email as spam. */
async function handleComplaint(p: Parsed): Promise<{ kind: InboundKind; send: Send | null }> {
  const { parts } = mimeParts(p.raw);
  const original = originalMessageId(parts);
  const send = original ? await prisma.send.findUnique({ where: { messageId: original } }) : null;
  if (!send) return { kind: "unmatched", send: null };
  await applyLateOutcome(send, "COMPLAINT", { parse: "arf", reason: "Marked as spam (feedback report)" });
  return { kind: "complaint", send };
}

/** Handles one message from a mailbox and records it. Idempotent on (mailbox, uid). */
export async function processInbound(mailbox: Mailbox, msg: InboundRaw): Promise<InboundKind> {
  const seen = await prisma.inboundMessage.findUnique({ where: { mailboxId_imapUid: { mailboxId: mailbox.id, imapUid: BigInt(msg.uid) } }, select: { kind: true } });
  if (seen) return seen.kind as InboundKind;
  const p = await parseInbound(msg.source);
  let kind: InboundKind = classify(p);
  let send: Send | null = null;

  // Mail written before this mailbox joined the pool cannot answer anything we sent: the agency's warmup traffic,
  // welcome emails, old threads. It is recorded as history and nobody has to look at it.
  if (wroteBefore(p.mail.date, mailbox.createdAt)) kind = "history";
  else if (kind === "bounce") ({ kind, send } = await handleBounce(p));
  else if (kind === "complaint") ({ kind, send } = await handleComplaint(p));
  else {
    send = await matchThread(p, mailbox);
    if (!send) kind = underSupplierWarmup(mailbox) ? "warmup" : "unmatched";
    else if (kind === "unsubscribe") await unsubscribeEverywhere(send.contactId, "mail");
    else if (kind === "human_reply") {
      const contact = await prisma.contact.findUnique({ where: { id: send.contactId } });
      if (contact) {
        await onHumanReply(send.organizationId, contact, { subject: p.subject, body: p.text, emailMessageId: p.messageId, receivedAt: p.mail.date ?? new Date() });
      }
    }
  }

  const headers = p.raw.slice(0, Math.max(0, p.raw.search(/\r?\n\r?\n/))).slice(0, 8000);
  await prisma.inboundMessage.create({
    data: {
      mailboxId: mailbox.id,
      imapUid: BigInt(msg.uid),
      kind,
      matchedSendId: send?.id ?? null,
      fromEmail: p.from || "unknown",
      subject: p.subject.slice(0, 500) || null,
      bodyText: p.text.slice(0, 20_000) || null,
      rawHeaders: headers || null,
      messageId: p.messageId,
      ...(kind === "history" || kind === "warmup" ? { handledAt: new Date() } : {}),
    },
  }).catch((e: Error) => logger.warn({ err: e.message, mailboxId: mailbox.id, uid: msg.uid }, "inbound already recorded"));
  return kind;
}

/**
 * A person wrote back. Within this polling cycle: the reply is recorded, their sequence stops for good, every
 * colleague at the same company domain stops too (free providers excluded), the rest of the hold goes back, and the
 * reply is classified. Nothing is sent back automatically.
 */
export async function onHumanReply(orgId: string, contact: NonNullable<Awaited<ReturnType<typeof prisma.contact.findUnique>>>, m: { subject: string | null; body: string; emailMessageId: string | null; receivedAt: Date }) {
  const r = await recordInboundReply({ orgId, contact, subject: m.subject ?? "", body: m.body, emailMessageId: m.emailMessageId, receivedAt: m.receivedAt });
  await stopSequence(contact.id, "replied");
  await stopColleagues(orgId, contact);
  await onConversationStopped(contact.id, "Replied");
  if (!r.duplicate) void runReplyIntelligence(orgId, r.messageId).catch((err: Error) => logger.error({ err: err.message }, "reply classification failed"));
  return r;
}

/** Conversations an unmatched message could belong to: the same address anywhere, then the same company domain. */
export async function unmatchedCandidates(inboundId: string) {
  const m = await prisma.inboundMessage.findUnique({ where: { id: inboundId } });
  if (!m) return [];
  const from = normalizeEmail(m.fromEmail).normalized;
  const domain = from.split("@")[1] ?? "";
  const rows = await prisma.contact.findMany({
    where: { OR: [{ emailNormalized: from }, ...(domain ? [{ domain, assignedMailboxId: m.mailboxId }] : [])] },
    take: 20,
    orderBy: { lastContactedAt: { sort: "desc", nulls: "last" } },
    select: { id: true, email: true, fullName: true, company: true, status: true, lastContactedAt: true, organization: { select: { id: true, name: true } } },
  });
  return rows;
}

/** An operator attaches an unmatched message to a conversation; it is then handled exactly like a matched reply. */
export async function assignUnmatched(inboundId: string, contactId: string, operatorId: string) {
  const m = await prisma.inboundMessage.findUnique({ where: { id: inboundId } });
  if (!m || m.kind !== "unmatched") return null;
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return null;
  await prisma.inboundMessage.update({ where: { id: m.id }, data: { handledAt: new Date(), assignedContactId: contact.id, assignedById: operatorId } });
  await onHumanReply(contact.organizationId, contact, { subject: m.subject, body: m.bodyText ?? "", emailMessageId: m.messageId, receivedAt: m.receivedAt });
  return { assigned: true, organizationId: contact.organizationId };
}

/**
 * Unmatched mail that turns out to predate its mailbox (read before history was recognised) is moved to history,
 * so the operator queue only ever holds real replies. Safe to run any number of times.
 */
export async function archiveMailboxHistory(): Promise<number> {
  const open = await prisma.inboundMessage.findMany({ where: { kind: "unmatched", handledAt: null }, select: { id: true, rawHeaders: true, mailbox: { select: { createdAt: true } } } });
  const old = open.filter((m) => {
    const header = m.rawHeaders?.match(/^date:[ \t]*(.+(?:\r?\n[ \t].+)*)/im)?.[1]?.replace(/\s+/g, " ");
    return header ? wroteBefore(new Date(header), m.mailbox.createdAt) : false;
  });
  if (!old.length) return 0;
  await prisma.inboundMessage.updateMany({ where: { id: { in: old.map((m) => m.id) } }, data: { kind: "history", handledAt: new Date() } });
  return old.length;
}
