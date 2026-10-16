import type { Request, Response } from "express";
import { ctx, ok } from "../../lib/http.js";
import * as service from "./engine.service.js";

export async function stop(req: Request, res: Response) {
  return ok(res, await service.stop(ctx(req).orgId));
}

export async function start(req: Request, res: Response) {
  return ok(res, await service.start(ctx(req).orgId));
}
