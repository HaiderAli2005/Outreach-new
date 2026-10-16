import type { Request, Response } from "express";
import { z } from "zod";
import { currentUser, ok, paginationSchema, boolish } from "../../lib/http.js";
import { parseBody, parseParams, parseQuery } from "../../middleware/validate.js";
import * as service from "./admin.service.js";

const page = paginationSchema(100, 25);
const idParam = z.object({ id: z.string().min(1) });
const search = z.string().trim().max(120).optional();

export async function overview(_req: Request, res: Response) {
  return ok(res, await service.overview());
}

export async function users(req: Request, res: Response) {
  const q = parseQuery(req, page.extend({ search, status: z.enum(["ACTIVE", "DISABLED"]).optional() }));
  const r = await service.users(q);
  return ok(res, r.rows, { page: q.page, limit: q.limit, total: r.total });
}

export async function updateUser(req: Request, res: Response) {
  const body = parseBody(req, z.object({ status: z.enum(["ACTIVE", "DISABLED"]).optional(), isPlatformAdmin: z.boolean().optional() }));
  return ok(res, await service.updateUser(currentUser(req).id, parseParams(req, idParam).id, body));
}

export async function organizations(req: Request, res: Response) {
  const q = parseQuery(req, page.extend({ search, status: z.enum(["ACTIVE", "SUSPENDED"]).optional() }));
  const r = await service.organizations(q);
  return ok(res, r.rows, { page: q.page, limit: q.limit, total: r.total });
}

export async function organization(req: Request, res: Response) {
  return ok(res, await service.organization(parseParams(req, idParam).id));
}

export async function updateOrganization(req: Request, res: Response) {
  const body = parseBody(req, z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }));
  return ok(res, await service.updateOrganization(parseParams(req, idParam).id, body));
}

export async function payments(req: Request, res: Response) {
  const q = parseQuery(req, page.extend({ status: z.enum(["REQUIRES_PAYMENT", "PROCESSING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"]).optional() }));
  const r = await service.payments(q);
  return ok(res, r.rows, { page: q.page, limit: q.limit, total: r.total });
}

export async function refund(req: Request, res: Response) {
  const body = parseBody(req, z.object({ amountCents: z.number().int().positive().optional(), reason: z.string().trim().max(300).optional() }));
  return ok(res, await service.refund(currentUser(req).id, parseParams(req, idParam).id, body.amountCents, body.reason));
}

export async function webhookEvents(req: Request, res: Response) {
  const q = parseQuery(req, page.extend({ provider: z.enum(["STRIPE", "CALENDLY", "APOLLO"]).optional(), status: z.enum(["RECEIVED", "PROCESSED", "FAILED", "IGNORED"]).optional() }));
  const r = await service.webhookEvents(q);
  return ok(res, r.rows, { page: q.page, limit: q.limit, total: r.total });
}

export async function systemLogs(req: Request, res: Response) {
  const q = parseQuery(req, page.extend({ level: z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]).optional(), open: boolish.optional() }));
  const r = await service.systemLogs(q);
  return ok(res, r.rows, { page: q.page, limit: q.limit, total: r.total });
}
