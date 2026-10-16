import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { keepAlive, sseHeaders, sseWrite } from "../analyses/events.js";
import { onInboxChanged } from "../../domain/sending/inboxEvents.js";

/**
 * The live inbox: one long-lived response per open app tab that says "the inbox changed" the moment a reply is read,
 * so the browser refetches then instead of on a timer. It sends a signal, never the inbox itself: what the customer
 * may see is still decided by the normal inbox endpoints.
 *
 * Woken at once by the watcher's nudge (inboxEvents.ts), and it also looks every few seconds on its own, so it stays
 * correct when the watcher runs in another process without Redis, or a nudge is lost. Each look is one count on the
 * (organizationId, direction, createdAt) index.
 */
const CHECK_MS = 5_000;
const open = new Set<Response>();

async function inboundCount(orgId: string): Promise<number> {
  return prisma.message.count({ where: { organizationId: orgId, direction: "INBOUND" } });
}

async function latestInbound(orgId: string) {
  const m = await prisma.message.findFirst({
    where: { organizationId: orgId, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    select: { intent: true, contact: { select: { id: true, firstName: true, lastName: true, email: true, company: true } } },
  });
  if (!m?.contact) return null;
  const name = [m.contact.firstName, m.contact.lastName].filter(Boolean).join(" ").trim();
  return { contactId: m.contact.id, name: name || m.contact.email, company: m.contact.company, intent: m.intent };
}

export async function streamInbox(req: Request, res: Response, orgId: string): Promise<void> {
  let seen = await inboundCount(orgId);
  sseHeaders(res);
  sseWrite(res, { type: "ready" });
  open.add(res);
  let busy = false;
  let again = false;
  let ended = false;

  async function look(): Promise<void> {
    if (ended) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        const now = await inboundCount(orgId);
        if (ended) return;
        if (now > seen) sseWrite(res, { type: "inbox", replies: now - seen, latest: await latestInbound(orgId) });
        // A deleted conversation lowers the count: nothing to announce, but the next reply must still count.
        seen = now;
      } while (again && !ended);
    } catch {
      /* the next look tries again; a stream never fails the request over a missed count */
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void look(), CHECK_MS);
  const unsubscribe = onInboxChanged(() => void look());
  keepAlive(req, res, () => {
    ended = true;
    open.delete(res);
    clearInterval(timer);
    unsubscribe();
  });
}

/** Ends every open stream (on shutdown); the browser reconnects to whichever instance is up. */
export function endInboxStreams(): void {
  for (const res of open) res.end();
  open.clear();
}
