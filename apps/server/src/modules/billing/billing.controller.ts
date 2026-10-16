import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, currentUser, ok, paginationSchema, skipTake } from "../../lib/http.js";
import { badRequest } from "../../lib/errors.js";
import { parseBody, parseParams, parseQuery } from "../../middleware/validate.js";
import * as service from "./billing.service.js";
import { catalogue } from "./plans.service.js";
import { parseDeciCents } from "../../domain/money.js";
import { reverifyAndUnpause } from "../../domain/sending/health.js";
import { handleStripeWebhook, verifyStripeEvent } from "./webhook.service.js";

export async function plans(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "public, max-age=300");
  return ok(res, catalogue());
}

export function config(_req: Request, res: Response) {
  return ok(res, service.billingConfig());
}

/** Balance, runway, sending health and activity. Always fresh from the server; the client never computes money. */
export async function credits(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  return ok(res, await service.creditsPanel(ctx(req).orgId));
}

export async function topup(req: Request, res: Response) {
  const key = req.get("idempotency-key") ?? "";
  if (!/^[\w-]{8,100}$/.test(key)) throw badRequest("An Idempotency-Key header is required");
  const amount = parseDeciCents((req.body as { amount?: unknown })?.amount);
  if (amount === null) throw badRequest("amount must be a whole number of deci-cents, as a string");
  const savedCard = (req.body as { savedCard?: unknown })?.savedCard === true;
  return ok(res, await service.startTopup(ctx(req).orgId, currentUser(req).email, amount, key, { savedCard }));
}

/** Saves a card without charging it (SetupIntent). `purpose: "auto_reload"` asks for off-session consent instead. */
export async function setup(req: Request, res: Response) {
  const key = req.get("idempotency-key") ?? "";
  if (!/^[\w-]{8,100}$/.test(key)) throw badRequest("An Idempotency-Key header is required");
  const { purpose } = parseBody(req, z.object({ purpose: z.enum(["card", "auto_reload"]) }));
  return ok(res, await service.startSetup(ctx(req).orgId, currentUser(req).email, purpose, key));
}

export async function removeCard(req: Request, res: Response) {
  return ok(res, await service.removeCard(ctx(req).orgId));
}

export async function close(req: Request, res: Response) {
  const confirm = String((req.body as { confirm?: unknown })?.confirm ?? "");
  return ok(res, await service.closeAccount(ctx(req).orgId, currentUser(req).id, confirm));
}

/** A paused customer re-verifies their queued list, and new emails start again. */
export async function reverify(req: Request, res: Response) {
  return ok(res, await reverifyAndUnpause(ctx(req).orgId, currentUser(req).id));
}

/** Suggested top-ups for the daily budget (or a budget being chosen in setup, as ?budget=deci-cents). */
export async function topupOptions(req: Request, res: Response) {
  const { budget } = parseQuery(req, z.object({ budget: z.string().regex(/^\d{1,9}$/).optional() }));
  res.setHeader("Cache-Control", "no-store");
  return ok(res, await service.topupOptionsFor(ctx(req).orgId, budget ? BigInt(budget) : null));
}

/** An auto-reload waiting for the customer to approve it with their bank. */
export async function confirmPayment(req: Request, res: Response) {
  const { id } = parseParams(req, z.object({ id: z.string().max(100) }));
  res.setHeader("Cache-Control", "no-store");
  return ok(res, await service.paymentToConfirm(ctx(req).orgId, id));
}

export async function payments(req: Request, res: Response) {
  const p = parseQuery(req, paginationSchema(100, 20));
  const [rows, total] = await service.listPayments(ctx(req).orgId, skipTake(p));
  return ok(res, rows, { ...p, total });
}

export async function webhook(req: Request, res: Response) {
  const event = verifyStripeEvent(req.rawBody, req.get("stripe-signature"));
  const result = await handleStripeWebhook(event);
  return ok(res, { received: true, duplicate: result.duplicate });
}

export const refundSchema = z.object({ amountCents: z.number().int().positive().optional(), reason: z.string().max(300).optional() });
