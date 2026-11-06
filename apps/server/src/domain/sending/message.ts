import { languageInfo } from "../languages.js";
import { randomUUID } from "node:crypto";
import type { OutboundMessage } from "./transport/types.js";

/**
 * The exact message we put on the wire.
 *
 *   Message-ID is on the SENDING domain (<uuid@that-domain>). A Message-ID on another domain than From is a spam
 *   signal.
 *   Follow-ups and replies carry In-Reply-To (the parent) and References (the whole chain, oldest first), so Gmail
 *   and Outlook keep them in one thread. A follow-up that starts a new visible thread reads like impersonation.
 *   List-Unsubscribe with One-Click POST, as Google and Microsoft require of bulk senders.
 *   Plain text only: no HTML part, no images, no tracking pixel, no rewritten links.
 */

export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

export function newMessageId(fromAddress: string): string {
  return `<${randomUUID()}@${domainOf(fromAddress)}>`;
}

/** "Re: subject", without stacking prefixes. */
export function replySubject(original: string | null | undefined): string {
  const base = stripPrefixes(original ?? "");
  return base ? `Re: ${base}` : "Re:";
}

/** Subject with any number of Re:/Fwd:/AW:/SV: prefixes removed, for matching replies to threads. */
export function stripPrefixes(subject: string): string {
  return subject.replace(/^(\s*(re|fw|fwd|aw|sv|vs|antw|r)\s*(\[\d+\])?\s*:\s*)+/i, "").trim();
}

export interface ThreadParent {
  messageId: string;
  references: string[];
}

/** References for a message answering `parent`: the parent's chain, then the parent, oldest first. */
export function referencesFor(parent: ThreadParent | null | undefined): string[] {
  if (!parent) return [];
  const chain = [...parent.references, parent.messageId].filter(Boolean);
  return chain.filter((id, i) => chain.indexOf(id) === i);
}

export function buildOutbound(o: {
  fromName: string;
  fromAddress: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  unsubscribeUrl: string;
  parent?: ThreadParent | null;
  date?: Date;
}): OutboundMessage {
  const references = referencesFor(o.parent);
  return {
    from: { name: o.fromName, address: o.fromAddress },
    to: o.to,
    subject: o.subject,
    text: o.body.replace(/\r\n/g, "\n"),
    messageId: o.messageId,
    date: o.date ?? new Date(),
    inReplyTo: o.parent?.messageId ?? null,
    references,
    headers: {
      // The mailto points at the sending mailbox itself, which we read over IMAP, rather than an address on the
      // domain that nobody reads.
      "List-Unsubscribe": `<${o.unsubscribeUrl}>, <mailto:${o.fromAddress}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** The merge token a written email uses for the sender's first name, filled once the mailbox is known. */
export const SENDER_FIRST_NAME = "{{sender_first_name}}";

/** The first word of a display name: "Madison Reed" signs as "Madison". */
export function firstNameOf(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/**
 * The body of a sequence email, plain text: the written text with the sender's first name filled in, a first-name
 * sign-off, then the footer (opt-out line, postal address when set). The first email carries NO link at all, not even
 * the unsubscribe one: unsubscribing works from the mail app's own button (List-Unsubscribe, one click) or by
 * replying. Follow-ups add the unsubscribe link on the sending domain.
 */
export function composeBody(o: { text: string; senderFirstName: string; footer: string; unsubscribeUrl: string | null; language?: string | null }): string {
  const text = o.text.split(SENDER_FIRST_NAME).join(o.senderFirstName).trim();
  // The sign-off and unsubscribe label match the email's language.
  const l = languageInfo(o.language);
  return [text, `${l.signoff}\n${o.senderFirstName}`, o.footer.trim(), o.unsubscribeUrl ? `${l.unsubscribe}: ${o.unsubscribeUrl}` : ""].filter(Boolean).join("\n\n");
}
