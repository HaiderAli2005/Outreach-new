/**
 * The transport layer: the only code that talks to mail servers. Everything above it (routing, warmup, pinning,
 * credits) is ours and transport-agnostic. A mailbox's `transport_ref` ("smtp:name@domain.com") names the
 * transport, so switching a mailbox to another one later is a data change, not a rewrite.
 */

export interface MailboxCreds {
  address: string;
  username: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export interface OutboundMessage {
  from: { name: string; address: string };
  to: string;
  subject: string;
  /** Plain text only. No HTML part, no images, no tracking, no rewritten links. */
  text: string;
  /** "<uuid@sending-domain>", always on the From domain. */
  messageId: string;
  date: Date;
  inReplyTo?: string | null;
  /** The whole thread, oldest first, ending with the parent. */
  references?: string[];
  headers: Record<string, string>;
}

/**
 * What happened when the receiving server was handed the message.
 *  SENT            2xx, accepted
 *  SOFT_BOUNCE     4xx, temporary: retry with backoff, counts against nothing
 *  HARD_BOUNCE     5xx, permanent: never retry
 *  AUTH_FAILURE    SPF/DKIM/DMARC refused (4.7.27/30/31, 5.7.26): OUR fault, counts against the domain only
 *  RATE_LIMITED    4.7.28: lower the mailbox's cap and retry later
 *  DOMAIN_BLOCKED  5.7.233 / 5.1.8, a provider blocked our whole domain: pause the domain
 *  TRANSPORT_ERROR could not reach or sign in to our own mail server: retry, counts against nothing
 */
export type SendOutcome = "SENT" | "SOFT_BOUNCE" | "HARD_BOUNCE" | "AUTH_FAILURE" | "RATE_LIMITED" | "DOMAIN_BLOCKED" | "TRANSPORT_ERROR";

export interface SendResult {
  outcome: SendOutcome;
  smtpCode: string | null;
  enhancedCode: string | null;
  response: string;
}

/** A raw message read over IMAP. Parsing and classification happen above the transport. */
export interface InboundRaw {
  uid: number;
  source: Buffer;
}

export interface MailTransport {
  readonly id: string;
  send(creds: MailboxCreds, m: OutboundMessage): Promise<SendResult>;
  fetchNew(creds: MailboxCreds, sinceUid?: number, limit?: number): Promise<InboundRaw[]>;
  verify(creds: MailboxCreds): Promise<{ smtp: boolean; imap: boolean; error?: string }>;
  /** The last UID already in the inbox before `joined`, so a new mailbox is read from the day it joined, not from its first email ever. */
  startUid?(creds: MailboxCreds, joined: Date): Promise<number>;
  /**
   * Holds one connection open and calls `onNew` as soon as new mail lands (IMAP IDLE, or a push from a sync service),
   * plus once on connect to catch up. Settles when `signal` aborts or the connection drops; the watcher reconnects.
   * A transport without it is left to the 2-minute poll.
   */
  watch?(creds: MailboxCreds, onNew: () => void, signal: AbortSignal): Promise<void>;
}
