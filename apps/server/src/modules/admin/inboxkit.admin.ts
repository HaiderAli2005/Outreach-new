import type { Request, Response } from "express";
import { z } from "zod";
import { created, currentUser, ok } from "../../lib/http.js";
import { parseBody } from "../../middleware/validate.js";
import { PERSONA_SEED } from "../../domain/pool/personaSeed.js";
import { inboxKitStatus, saveInboxKitKey, updateInboxKitSettings } from "../../domain/pool/inboxkit/settings.js";
import { cancelOrder, confirmOrder, getOrder, MAX_PER_QUOTE, orderPlan, quoteOrder } from "../../domain/pool/inboxkit/orders.js";
import { syncInboxKit } from "../../domain/pool/inboxkit/sync.js";
import { pipeline } from "../../domain/pool/inboxkit/view.js";

/** Admin > Domains > InboxKit: setup, "Add new domains" (plan, price check, confirm) and the warmup board. */

const text = (max: number) => z.string().trim().min(1).max(max);
const contact = z
  .object({
    first_name: text(60),
    last_name: text(60),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z.string().trim().regex(/^\+?[0-9 ().-]{6,20}$/, "A phone number with country code, for example +92 300 1234567"),
    organization: z.string().trim().max(120).optional(),
    address_line1: text(200),
    address_line2: z.string().trim().max(200).optional(),
    city: text(100),
    state: text(100),
    country: z.string().trim().length(2, "The two-letter country code, for example PK").toUpperCase(),
    postal_code: text(20),
  })
  .partial();

export async function status(_req: Request, res: Response) {
  return ok(res, await inboxKitStatus());
}

export async function saveKey(req: Request, res: Response) {
  const body = parseBody(req, z.object({ key: z.string().min(16, "Paste the whole API key").max(500) }));
  return ok(res, await saveInboxKitKey(body.key, currentUser(req).id));
}

export async function saveSettings(req: Request, res: Response) {
  const body = parseBody(
    req,
    z
      .object({
        workspaceUid: z.string().trim().min(1).max(100),
        contact,
        redirectUrl: z.string().trim().url("A full web address, for example https://yourcompany.com").startsWith("https://", "It must start with https://").max(300),
        platform: z.enum(["GOOGLE", "MICROSOFT"]),
        warmupDays: z.number().int().min(14, "At least 14 days of warmup").max(90),
        keepWarmupAfterLive: z.boolean(),
        maxDomainPriceUsd: z.number().min(5).max(100),
      })
      .partial()
      .strict(),
  );
  return ok(res, await updateInboxKitSettings(body, currentUser(req).id));
}

export async function plan(_req: Request, res: Response) {
  return ok(res, await orderPlan());
}

const locale = z.enum(Object.keys(PERSONA_SEED) as [string, ...string[]]);

export async function quote(req: Request, res: Response) {
  const body = parseBody(req, z.object({ domains: z.number().int().min(1).max(MAX_PER_QUOTE), region: z.string().trim().min(2).max(10).default("global"), locale: locale.default("en") }));
  return created(res, await quoteOrder(body, currentUser(req).id));
}

export async function order(req: Request, res: Response) {
  return ok(res, await getOrder(String(req.params.id)));
}

export async function confirm(req: Request, res: Response) {
  return ok(res, await confirmOrder(String(req.params.id), currentUser(req).id));
}

export async function cancel(req: Request, res: Response) {
  return ok(res, await cancelOrder(String(req.params.id), currentUser(req).id));
}

export async function board(_req: Request, res: Response) {
  return ok(res, await pipeline());
}

export async function syncNow(_req: Request, res: Response) {
  return ok(res, await syncInboxKit());
}
