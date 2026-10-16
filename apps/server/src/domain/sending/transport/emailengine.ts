import type { InboundRaw, MailTransport, MailboxCreds, OutboundMessage, SendResult } from "./types.js";

/**
 * EmailEngine (self-hosted, about $1,450 a year flat for unlimited mailboxes). Not bought yet: at 20 mailboxes it
 * costs about $6 a mailbox a month, at 500 about $0.24. Fill this in when the pool passes roughly 100 mailboxes
 * and holding SMTP/IMAP connections ourselves starts to hurt; mailboxes then move by changing their
 * transport_ref from "smtp:" to "emailengine:".
 */
export class EmailEngineTransport implements MailTransport {
  readonly id = "emailengine";
  async send(_c: MailboxCreds, _m: OutboundMessage): Promise<SendResult> {
    throw new Error("EmailEngineTransport is not implemented yet");
  }
  async fetchNew(_c: MailboxCreds, _since?: number): Promise<InboundRaw[]> {
    throw new Error("EmailEngineTransport is not implemented yet");
  }
  async startUid(_c: MailboxCreds, _joined: Date): Promise<number> {
    throw new Error("EmailEngineTransport is not implemented yet");
  }
  async verify(_c: MailboxCreds): Promise<{ smtp: boolean; imap: boolean; error?: string }> {
    throw new Error("EmailEngineTransport is not implemented yet");
  }
}
