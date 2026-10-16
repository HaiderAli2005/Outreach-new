import type { Mailbox } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { getSettings } from "../settings.js";
import { SEQUENCE_DAYS } from "../../config/plans.js";
import { stopSequence } from "./stop.js";
import { inWindow, nextSlot, prospectTz, windowFor } from "./schedule.js";
import { releaseForContact } from "../credits/index.js";
import { composeStep, MAX_RETRIES, transmit } from "./delivery.js";
import { processInbound } from "./inbound.js";
import { scheduleNextTouch, sendFollowUp } from "./pipeline.js";
import { credsFor, transportFor } from "./transport/index.js";
import { inboxChanged } from "./inboxEvents.js";
import { withLock } from "../../lib/locks.js";

const MIN = 60_000;
const DAY = 86_400_000;

// ─── read the mailboxes: at once through the IDLE watcher, and every 2 minutes as the safety net ────────────

/** Reads one mailbox from its last seen UID and handles each new message. The UID is kept, so a restart re-reads nothing. */
export async function pollMailbox(m: Mailbox): Promise<{ read: number; kinds: Record<string, number> }> {
  const kinds: Record<string, number> = {};
  const transport = transportFor(m.transportRef);
  const creds = await credsFor(m);
  let since = Number(m.lastImapUid);
  // First read of a mailbox: skip everything that was already in it before it joined the pool.
  if (since === 0 && transport.startUid) {
    since = await transport.startUid(creds, m.createdAt);
    if (since > 0) await prisma.mailbox.update({ where: { id: m.id }, data: { lastImapUid: BigInt(since) } });
  }
  const fresh = await transport.fetchNew(creds, since);
  let last = since;
  for (const msg of fresh) {
    try {
      const k = await processInbound(m, msg);
      kinds[k] = (kinds[k] ?? 0) + 1;
    } catch (e) {
      // One bad message must not block the mailbox: it is skipped and logged, and polling moves on.
      logger.error({ mailboxId: m.id, uid: msg.uid, err: (e as Error).message }, "inbound message failed");
    }
    last = Math.max(last, msg.uid);
  }
  await prisma.mailbox.update({ where: { id: m.id }, data: { lastImapUid: BigInt(last), lastPolledAt: new Date() } });
  if (fresh.length) inboxChanged();
  return { read: fresh.length, kinds };
}

/**
 * The one way a mailbox gets read, by the 2-minute poll and by the IDLE watcher alike. A lock per mailbox means the
 * two never read the same mailbox at once (they would both see the same new UIDs and handle each reply twice), and
 * the row is re-read inside the lock so the last UID is never stale. `ran: false` means another read held it.
 */
export async function readMailbox(mailboxId: string): Promise<{ ran: boolean; read: number }> {
  const r = await withLock(`mailbox-read:${mailboxId}`, 110_000, async () => {
    const m = await prisma.mailbox.findUnique({ where: { id: mailboxId } });
    return m ? (await pollMailbox(m)).read : 0;
  });
  return r.ran ? { ran: true, read: r.result } : { ran: false, read: 0 };
}

/** Every mailbox that sends or still holds conversations, oldest poll first, each at most every 2 minutes. */
export async function pollMailboxes(limit = 200): Promise<{ polled: number; read: number; failed: number }> {
  const due = await prisma.mailbox.findMany({
    where: { status: { in: ["ACTIVE", "WARMING", "REPLIES_ONLY"] }, credentialRef: { not: null }, OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: new Date(Date.now() - 2 * MIN + 10_000) } }] },
    orderBy: [{ lastPolledAt: { sort: "asc", nulls: "first" } }],
    take: limit,
  });
  let read = 0;
  let failed = 0;
  const queue = [...due];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        // A mailbox the watcher is reading right now is skipped: that read already covers it.
        read += (await readMailbox(m.id)).read;
      } catch (e) {
        failed++;
        await prisma.mailbox.update({ where: { id: m.id }, data: { lastError: `IMAP: ${(e as Error).message}`.slice(0, 300), lastPolledAt: new Date() } });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, due.length) }, worker));
  return { polled: due.length, read, failed };
}

// ─── every 5 minutes: soft-bounce retries ─────────────────────────────────────

/** Tries soft-bounced emails again at 15 minutes, 2 hours and 12 hours. They never count against anyone. */
export async function retrySoftBounces(limit = 100): Promise<{ retried: number; sent: number }> {
  const due = await prisma.send.findMany({ where: { status: "SOFT_BOUNCE", nextRetryAt: { lte: new Date() }, retryCount: { lt: MAX_RETRIES }, mailboxId: { not: null } }, orderBy: { nextRetryAt: "asc" }, take: limit });
  let sent = 0;
  for (const s of due) {
    const [contact, mailbox] = await Promise.all([prisma.contact.findUnique({ where: { id: s.contactId } }), prisma.mailbox.findUnique({ where: { id: s.mailboxId! }, include: { sendingDomain: true } })]);
    const stopped = !contact || ["UNSUBSCRIBED", "BOUNCED", "BLOCKLISTED"].includes(contact.status) || (s.step >= 1 && (contact.status === "REPLIED" || !!contact.sequenceStoppedAt));
    if (!contact || !mailbox || stopped || mailbox.status === "RETIRED") {
      await prisma.send.update({ where: { id: s.id }, data: { nextRetryAt: null, resolvedAt: new Date() } });
      if (contact && s.step >= 1) await releaseForContact(contact.id, "Sequence stopped");
      continue;
    }
    if (mailbox.sendingDomain?.pausedAt) {
      await prisma.send.update({ where: { id: s.id }, data: { nextRetryAt: new Date(Date.now() + 60 * MIN) } });
      continue;
    }
    let subject = s.subject ?? "";
    let body: string;
    if (s.step >= 1) {
      const first = await prisma.send.findFirst({ where: { contactId: contact.id, step: 1, messageId: { not: null } }, orderBy: { sentAt: "asc" }, select: { subject: true } });
      const c = composeStep(contact, s.step, await getSettings(s.organizationId), mailbox, first?.subject ?? null);
      subject = s.subject ?? c.subject;
      body = c.body;
    } else {
      const m = await prisma.message.findFirst({ where: { contactId: contact.id, direction: "OUTBOUND", emailMessageId: s.messageId }, select: { body: true } });
      if (!m?.body) {
        await prisma.send.update({ where: { id: s.id }, data: { nextRetryAt: null, resolvedAt: new Date() } });
        continue;
      }
      body = m.body;
    }
    const parent = s.inReplyTo ? { messageId: s.inReplyTo, references: s.referencesChain.slice(0, -1) } : null;
    const r = await transmit({ orgId: s.organizationId, contact, mailbox, campaignId: s.campaignId, step: s.step, isFirstTouch: s.isFirstTouch, subject, body, parent, via: s.step >= 1 ? "sequence" : "inbox", existing: s, recordTransportErrors: true });
    if (r.outcome === "SENT") {
      sent++;
      // The email finally went: the next one in the sequence gets its slot now.
      if (s.step >= 1) await scheduleNextTouch(s.organizationId, contact.id, s.step, contact.firstContactedAt ?? s.sentAt);
    }
  }
  return { retried: due.length, sent };
}

// ─── every 5 minutes: follow-ups at their scheduled minute ─────────────────────

/**
 * Sequence emails 2, 3 and 4. Each goes from the mailbox the person is pinned to, threaded under the one before, at
 * the random minute picked for it inside the prospect's own window on day 3, 7 or 14, and only while the sequence
 * is still running (no reply from them or a colleague, no unsubscribe, no bounce, not marked done).
 */
export async function runFollowUps(orgId: string, now = new Date()): Promise<{ sent: number; waiting: number; finished: number; rescheduled: number }> {
  const out = { sent: 0, waiting: 0, finished: 0, rescheduled: 0 };
  const settings = await getSettings(orgId);
  if (!settings.autopilotEnabled) return out;
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { region: true } });
  const due = await prisma.contact.findMany({
    where: {
      organizationId: orgId,
      status: "CONTACTED",
      sequenceStoppedAt: null,
      assignedMailboxId: { not: null },
      OR: [{ nextTouchAt: { lte: now } }, { nextTouchAt: null, lastContactedAt: { lte: new Date(now.getTime() - SEQUENCE_DAYS[1] * DAY) } }],
    },
    select: { id: true, campaignId: true, nextTouchAt: true, firstContactedAt: true, lastContactedAt: true, timezone: true, country: true, city: true, location: true },
    orderBy: { nextTouchAt: { sort: "asc", nulls: "first" } },
    take: 500,
  });
  for (const c of due) {
    const sends = await prisma.send.findMany({ where: { contactId: c.id, step: { gte: 1 } }, orderBy: { step: "asc" }, select: { step: true, status: true, sentAt: true } });
    if (sends.some((s) => s.status === "SOFT_BOUNCE")) {
      out.waiting++;
      continue;
    }
    const last = sends.filter((s) => s.status === "SENT" || s.status === "DELIVERED").at(-1);
    if (!last) continue;
    if (last.step >= SEQUENCE_DAYS.length) {
      await stopSequence(c.id, "finished");
      out.finished++;
      continue;
    }
    const firstSentAt = c.firstContactedAt ?? sends[0]?.sentAt ?? now;
    // Older sequences (or a missed slot): pick the slot now rather than send at once.
    if (!c.nextTouchAt) {
      await scheduleNextTouch(orgId, c.id, last.step, firstSentAt);
      out.rescheduled++;
      continue;
    }
    // A slot that came due while sending was held back (paused, out of budget) waits for the next window.
    const w = windowFor(settings, prospectTz(c, settings, org?.region));
    if (!inWindow(w, now)) {
      await prisma.contact.update({ where: { id: c.id }, data: { nextTouchAt: nextSlot(w, now) } });
      out.rescheduled++;
      continue;
    }
    const r = await sendFollowUp(orgId, c.id, c.campaignId, (last.step + 1) as 2 | 3 | 4);
    if (r.ok) out.sent++;
    else if (r.wait) out.waiting++;
  }
  return out;
}
