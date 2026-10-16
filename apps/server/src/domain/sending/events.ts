import type { Send } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { releaseForContact } from "../credits/index.js";
import { recomputeCustomerHealth } from "./health.js";
import { bumpDomainDay, MAX_RETRIES, onDeadAddress, RETRY_BACKOFF_MS } from "./delivery.js";

/**
 * What arrives after an email went out: a bounce report (DSN) or a spam complaint (ARF) read from the sending
 * mailbox. Soft bounces are retried and count against nothing; hard bounces and complaints count, complaints ten
 * times over.
 */

/** 4xx codes and "soft"/"temporary" wording are soft bounces. Everything else is hard. */
export function isSoftBounce(code: string | null, reason: string | null, type: string | null): boolean {
  if (type && /soft|temporar|transient/i.test(type)) return true;
  if (type && /hard|permanent/i.test(type)) return false;
  if (code && /^4\d\d$|^4\.\d/.test(code.trim())) return true;
  if (reason && /\b4\d\d\b|\b4\.\d\.\d\b|mailbox full|try again later|temporar/i.test(reason) && !/\b5\d\d\b|\b5\.\d\.\d\b/.test(reason)) return true;
  return false;
}

export type LateOutcome = "HARD_BOUNCE" | "SOFT_BOUNCE" | "COMPLAINT";

/** Applies a late bounce or a complaint to the send it is about. Safe to receive twice. */
export async function applyLateOutcome(send: Send, outcome: LateOutcome, b: { code?: string | null; reason?: string | null; parse: "dsn" | "heuristic" | "arf" }): Promise<void> {
  if (send.status === outcome || (send.status === "COMPLAINT" && outcome !== "COMPLAINT")) return;
  const now = new Date();
  if (outcome === "SOFT_BOUNCE") {
    // Accepted, then refused for now by the far end. Try again on the backoff ladder; nothing counts.
    if (send.status === "HARD_BOUNCE") return;
    const giveUp = send.retryCount >= MAX_RETRIES;
    await prisma.send.update({
      where: { id: send.id },
      data: { status: "SOFT_BOUNCE", bounceCode: b.code?.slice(0, 40) ?? null, bounceReason: b.reason?.slice(0, 500) ?? null, bounceParse: b.parse === "arf" ? "dsn" : b.parse, nextRetryAt: giveUp ? null : new Date(now.getTime() + RETRY_BACKOFF_MS[Math.min(send.retryCount, MAX_RETRIES - 1)]), resolvedAt: giveUp ? now : null },
    });
    if (giveUp) await releaseForContact(send.contactId, "Could not be delivered");
    return;
  }
  await prisma.send.update({
    where: { id: send.id },
    data: { status: outcome, bounceCode: b.code?.slice(0, 40) ?? null, bounceReason: b.reason?.slice(0, 500) ?? null, bounceParse: b.parse === "arf" ? null : b.parse, nextRetryAt: null, resolvedAt: now },
  });
  await bumpDomainDay(send.domainId, outcome === "COMPLAINT" ? "complaints" : "hardBounces");
  const contact = await prisma.contact.findUnique({ where: { id: send.contactId }, select: { id: true, emailNormalized: true } });
  if (contact) await onDeadAddress(send.organizationId, contact, outcome === "COMPLAINT" ? "complaint" : "hard_bounce");
  if (send.isFirstTouch || outcome === "COMPLAINT") await recomputeCustomerHealth(send.organizationId);
}

/** They replied, unsubscribed or the sequence finished: nothing more will be sent, so the rest of the hold goes back. */
export function onConversationStopped(contactId: string, why: string) {
  return releaseForContact(contactId, why);
}
