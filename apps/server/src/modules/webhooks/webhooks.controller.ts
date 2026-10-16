import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { safeEqual } from "../../lib/crypto.js";
import { unauthorized } from "../../lib/errors.js";
import { ok } from "../../lib/http.js";
import * as service from "./webhooks.service.js";

function platformToken(req: Request): boolean {
  const token = String(req.query.token ?? req.get("x-webhook-secret") ?? "");
  return !!token && safeEqual(token, env.WEBHOOK_SECRET);
}

async function authorize(req: Request): Promise<string | null> {
  const orgToken = typeof req.params.orgToken === "string" ? req.params.orgToken : "";
  if (orgToken) {
    const orgId = await service.orgForWebhookToken(orgToken);
    if (orgId) return orgId;
  }
  if (!platformToken(req)) throw unauthorized("Invalid webhook token");
  return null;
}

const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

export async function calendly(req: Request, res: Response) {
  await authorize(req);
  return ok(res, await service.handleCalendly(String(req.params.orgToken), body(req)));
}

export async function apollo(req: Request, res: Response) {
  await authorize(req);
  return ok(res, await service.handleApollo(String(req.params.orgToken), body(req)));
}
