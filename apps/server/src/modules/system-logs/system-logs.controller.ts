import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok, boolish } from "../../lib/http.js";
import { parseBody, parseQuery } from "../../middleware/validate.js";
import * as service from "./system-logs.service.js";

export async function list(req: Request, res: Response) {
  const q = parseQuery(req, z.object({ level: z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]).optional(), open: boolish.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }));
  const r = await service.list(ctx(req).orgId, q);
  return ok(res, r.logs, { openByLevel: r.openByLevel });
}

export async function resolve(req: Request, res: Response) {
  const { id } = parseBody(req, z.object({ id: z.string().optional() }));
  return ok(res, await service.resolve(ctx(req).orgId, id));
}
