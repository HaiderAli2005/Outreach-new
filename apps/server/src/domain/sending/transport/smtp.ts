import nodemailer, { type Transporter } from "nodemailer";
import { ImapFlow } from "imapflow";
import { logger } from "../../../lib/logger.js";
import { classifySmtp, enhancedCodeOf, smtpCodeOf } from "./codes.js";
import type { InboundRaw, MailTransport, MailboxCreds, OutboundMessage, SendResult } from "./types.js";

/** How long a sign-in check waits to connect, and then for each reply while signing in. */
const VERIFY_CONNECT_MS = 15_000;
const VERIFY_REPLY_MS = 30_000;
/** A network timeout (not a refused password) is tried once more: the first sign-in with a new app password is often slow. */
const isTimeout = (msg: string) => /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg);

export async function twice(check: () => Promise<string | null>): Promise<string | null> {
  const first = await check();
  if (!first || !isTimeout(first)) return first;
  const second = await check();
  return second && isTimeout(second) ? `${second} (twice). The mail server did not answer in time: check this computer's network, firewall or antivirus email scanning.` : second;
}

const IDLE_MS = 60_000;
/** How often the watcher's IDLE connection asks the server for news, because Gmail's own push can lag by a minute. */
const WATCH_NUDGE_MS = 10_000;
const MAX_CONNECTIONS = 3;

interface Pooled {
  transport: Transporter;
  lastUsed: number;
}

/**
 * Direct SMTP out (nodemailer) and IMAP in (imapflow), against any mail host (Google Workspace, Microsoft 365, Zoho...).
 *
 * One pooled SMTP connection set per mailbox, at most 3 at once, closed after 60 seconds idle. IMAP is read on short
 * connections (fetchNew), and the mailbox watcher (domain/sending/watch.ts) holds one more per mailbox in IDLE so a
 * reply is read seconds after it lands. Past a few hundred mailboxes per process, holding those sockets is the
 * problem EmailEngine exists to solve (see emailengine.ts); the watcher shards across processes until then.
 */
export class SmtpTransport implements MailTransport {
  readonly id = "smtp";
  private pools = new Map<string, Pooled>();
  private sweeper: NodeJS.Timeout | null = null;

  private transportFor(c: MailboxCreds): Transporter {
    const key = `${c.address}|${c.smtpHost}:${c.smtpPort}`;
    const hit = this.pools.get(key);
    if (hit) {
      hit.lastUsed = Date.now();
      return hit.transport;
    }
    const transport = nodemailer.createTransport({
      host: c.smtpHost,
      port: c.smtpPort,
      secure: c.smtpPort === 465,
      requireTLS: c.smtpPort !== 465 && c.smtpPort !== 25,
      auth: { user: c.username, pass: c.password },
      pool: true,
      maxConnections: MAX_CONNECTIONS,
      maxMessages: 100,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    this.pools.set(key, { transport, lastUsed: Date.now() });
    this.startSweeper();
    return transport;
  }

  private startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [k, p] of this.pools) {
        if (now - p.lastUsed > IDLE_MS) {
          p.transport.close();
          this.pools.delete(k);
        }
      }
      if (!this.pools.size && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, 15_000);
    this.sweeper.unref();
  }

  async send(c: MailboxCreds, m: OutboundMessage): Promise<SendResult> {
    try {
      const info = await this.transportFor(c).sendMail({
        from: { name: m.from.name, address: m.from.address },
        to: m.to,
        subject: m.subject,
        text: m.text,
        messageId: m.messageId,
        date: m.date,
        inReplyTo: m.inReplyTo ?? undefined,
        references: m.references?.length ? m.references : undefined,
        headers: m.headers,
        textEncoding: "quoted-printable",
      });
      const response = String(info.response ?? "250 OK");
      const rejected = (info.rejected ?? []).length > 0;
      const enhancedCode = enhancedCodeOf(response);
      const smtpCode = smtpCodeOf(response) ?? (rejected ? null : "250");
      return { outcome: rejected ? classifySmtp(smtpCode, enhancedCode) : "SENT", smtpCode, enhancedCode, response: response.slice(0, 500) };
    } catch (e) {
      const err = e as { code?: string; responseCode?: number; response?: string; message?: string };
      const response = String(err.response ?? err.message ?? "unknown error");
      const smtpCode = smtpCodeOf(response, err.responseCode);
      const enhancedCode = enhancedCodeOf(response);
      // No reply code means we never got as far as the recipient's server: our side, retry later.
      if (!smtpCode) return { outcome: "TRANSPORT_ERROR", smtpCode: null, enhancedCode: null, response: `${err.code ?? "ERROR"}: ${response}`.slice(0, 500) };
      if (err.code === "EAUTH") return { outcome: "TRANSPORT_ERROR", smtpCode, enhancedCode, response: `EAUTH: ${response}`.slice(0, 500) };
      return { outcome: classifySmtp(smtpCode, enhancedCode), smtpCode, enhancedCode, response: response.slice(0, 500) };
    }
  }

  private imap(c: MailboxCreds) {
    return new ImapFlow({ host: c.imapHost, port: c.imapPort, secure: c.imapPort === 993, auth: { user: c.username, pass: c.password }, logger: false, socketTimeout: 60_000 });
  }

  async fetchNew(c: MailboxCreds, sinceUid = 0, limit = 200): Promise<InboundRaw[]> {
    const client = this.imap(c);
    const out: InboundRaw[] = [];
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        // "n:*" always returns the newest message even when it is older than n, so filter on the uid.
        for await (const msg of client.fetch(`${sinceUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (msg.uid > sinceUid && msg.source) out.push({ uid: msg.uid, source: msg.source });
          if (out.length >= limit) break;
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return out.sort((a, b) => a.uid - b.uid);
  }

  async startUid(c: MailboxCreds, joined: Date): Promise<number> {
    const client = this.imap(c);
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uidNext = client.mailbox && typeof client.mailbox === "object" ? Number(client.mailbox.uidNext ?? 1) : 1;
        // SEARCH SINCE works in whole days, so the exact time is checked on that day's messages.
        const sameDayOrLater = (await client.search({ since: joined }, { uid: true })) || [];
        let first: number | null = null;
        if (sameDayOrLater.length) {
          for await (const msg of client.fetch(sameDayOrLater.join(","), { uid: true, internalDate: true }, { uid: true })) {
            const at = msg.internalDate ? new Date(msg.internalDate) : null;
            if (at && at.getTime() >= joined.getTime() && (first === null || msg.uid < first)) first = msg.uid;
          }
        }
        return first !== null ? first - 1 : Math.max(0, uidNext - 1);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  /**
   * One IMAP connection parked in IDLE on the inbox: the server says "EXISTS" the moment mail lands and `onNew` fires.
   * IDLE is restarted every 4 minutes, well inside the 29 minutes RFC 2177 allows, which also keeps NAT and load
   * balancers from dropping a quiet socket. Reading the mail is left to fetchNew, on its own short connection.
   */
  async watch(c: MailboxCreds, onNew: () => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const client = new ImapFlow({
      host: c.imapHost,
      port: c.imapPort,
      secure: c.imapPort === 993,
      auth: { user: c.username, pass: c.password },
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      // This connection does nothing but wait, so IDLE starts at once instead of after the default 15 seconds.
      autoIdleDelay: 1_000,
      maxIdleTime: 4 * 60_000,
      socketTimeout: 10 * 60_000,
    });
    const closed = new Promise<void>((resolve) => {
      client.on("close", () => resolve());
      // Without a listener an IMAP error would crash the process; the drop is handled by reconnecting.
      client.on("error", () => resolve());
    });
    const stop = () => void client.logout().catch(() => client.close());
    signal.addEventListener("abort", stop, { once: true });
    let nudge: NodeJS.Timeout | null = null;
    try {
      await client.connect();
      await client.mailboxOpen("INBOX");
      client.on("exists", () => onNew());
      // Anything that arrived while this mailbox had no connection is read now, not at the next poll.
      onNew();
      // Gmail's IDLE push often trails the mail by 15 to 60 seconds (measured on our own pool). A NOOP makes the server
      // report new mail at once, so one every few seconds bounds the wait; it is a one-line command on a socket that is
      // already open, cheap enough for hundreds of mailboxes.
      nudge = setInterval(() => void client.noop().catch(() => undefined), WATCH_NUDGE_MS);
      await closed;
    } finally {
      if (nudge) clearInterval(nudge);
      signal.removeEventListener("abort", stop);
      if (client.usable) await client.logout().catch(() => client.close());
    }
  }

  /** Signs in over SMTP and IMAP at the same time, each with a firm time limit, and says why when it fails. */
  async verify(c: MailboxCreds): Promise<{ smtp: boolean; imap: boolean; error?: string }> {
    const smtpCheck = async (): Promise<string | null> => {
      const t = nodemailer.createTransport({ host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465, auth: { user: c.username, pass: c.password }, connectionTimeout: VERIFY_CONNECT_MS, greetingTimeout: VERIFY_REPLY_MS, socketTimeout: VERIFY_REPLY_MS });
      try {
        await t.verify();
        return null;
      } catch (e) {
        return `SMTP: ${(e as Error).message}`;
      } finally {
        t.close();
      }
    };
    const imapCheck = async (): Promise<string | null> => {
      const client = new ImapFlow({ host: c.imapHost, port: c.imapPort, secure: c.imapPort === 993, auth: { user: c.username, pass: c.password }, logger: false, connectionTimeout: VERIFY_CONNECT_MS, greetingTimeout: VERIFY_REPLY_MS, socketTimeout: VERIFY_REPLY_MS });
      try {
        await client.connect();
        return null;
      } catch (e) {
        const err = e as Error & { responseText?: string };
        return `IMAP: ${err.responseText || err.message}`;
      } finally {
        await client.logout().catch(() => undefined);
      }
    };
    const [smtpError, imapError] = await Promise.all([twice(smtpCheck), twice(imapCheck)]);
    const smtp = !smtpError;
    const imap = !imapError;
    const error = smtpError ?? imapError ?? undefined;
    if (error) logger.warn({ mailbox: c.address, smtpHost: c.smtpHost, imapHost: c.imapHost, reason: error.slice(0, 300) }, "mailbox sign-in check failed");
    return { smtp, imap, error };
  }
}
