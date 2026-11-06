import type { Request, Response } from "express";
import { logger } from "../../lib/logger.js";
import { verifyWebhookSignature } from "../../integrations/inboxkit.js";
import { inboxKitKey } from "../../domain/pool/inboxkit/settings.js";
import { nudgeSync } from "../../domain/pool/inboxkit/sync.js";

/**
 * InboxKit's status webhooks (domain.status_changed, mailbox.status_changed). InboxKit signs them with a hash of the
 * API key that never changes per request, so the body is never trusted: a valid one only makes Aperture read the
 * current state back from the API a minute later. The body carries mailbox passwords in plain text; it is not stored
 * and not logged.
 */
export async function inboxKitWebhook(req: Request, res: Response) {
  const { key } = await inboxKitKey();
  if (!key) return res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "InboxKit is not set up" } });
  if (!verifyWebhookSignature(key, req.get("x-inboxkit-signature") ?? undefined)) return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Bad signature" } });
  const event = req.get("x-inboxkit-event") ?? (typeof req.body?.event === "string" ? req.body.event : "unknown");
  logger.info({ event }, "inboxkit webhook");
  if (/status_changed$/.test(event)) nudgeSync();
  return res.status(200).json({ ok: true });
}
