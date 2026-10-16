import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok, paginationSchema } from "../../lib/http.js";
import { parseBody, parseParams, parseQuery } from "../../middleware/validate.js";
import * as service from "./inbox.service.js";

const idParam = z.object({ contactId: z.string().min(1) });
const listQuery = paginationSchema(50, 50).extend({
  filter: z.enum(service.INBOX_FILTERS).default("all"),
  reply: z.enum(service.REPLY_FILTERS).optional(),
});

export async function list(req: Request, res: Response) {
  const q = parseQuery(req, listQuery);
  const r = await service.list(ctx(req).orgId, q);
  return ok(res, r.rows, { page: q.page, limit: q.limit, total: r.total, counts: r.counts });
}

export async function thread(req: Request, res: Response) {
  const { contactId } = parseParams(req, idParam);
  return ok(res, await service.thread(ctx(req).orgId, contactId));
}

export async function reply(req: Request, res: Response) {
  const { contactId } = parseParams(req, idParam);
  const { body } = parseBody(req, z.object({ body: z.string().trim().min(1, "Write a reply first").max(10_000) }));
  return ok(res, await service.reply(ctx(req).orgId, contactId, body));
}

export async function dealClosed(req: Request, res: Response) {
  const { contactId } = parseParams(req, idParam);
  return ok(res, await service.dealClosed(ctx(req).orgId, contactId));
}

export async function handled(req: Request, res: Response) {
  const { contactId } = parseParams(req, idParam);
  return ok(res, await service.handled(ctx(req).orgId, contactId));
}

export async function remove(req: Request, res: Response) {
  const { contactId } = parseParams(req, idParam);
  return ok(res, await service.remove(ctx(req).orgId, contactId));
}

export async function discardDraft(req: Request, res: Response) {
  const { contactId } = parseParams(req, idParam);
  return ok(res, await service.discardDraft(ctx(req).orgId, contactId));
}

export async function correctIntent(req: Request, res: Response) {
  const { contactId } = parseParams(req, idParam);
  const { intent } = parseBody(req, z.object({ intent: z.string().trim().min(2).max(40) }));
  return ok(res, await service.correctIntent(ctx(req).orgId, contactId, intent));
}
