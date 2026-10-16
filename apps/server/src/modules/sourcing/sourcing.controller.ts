import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok } from "../../lib/http.js";
import { parseBody } from "../../middleware/validate.js";
import * as service from "./sourcing.service.js";

export async function search(req: Request, res: Response) {
  const body = parseBody(req, z.object({ campaignId: z.string().optional(), filters: z.record(z.string(), z.unknown()).optional(), page: z.number().int().min(1).max(500).default(1) }));
  return ok(res, await service.search(ctx(req).orgId, body));
}

export async function importNow(req: Request, res: Response) {
  const body = parseBody(req, z.object({ campaignId: z.string().min(1), maxEnrich: z.number().int().min(1).max(100).default(25) }));
  return ok(res, await service.importNow(ctx(req).orgId, body.campaignId, body.maxEnrich));
}

export async function usage(req: Request, res: Response) {
  return ok(res, await service.usage(ctx(req).orgId));
}
