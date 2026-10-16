import { budgetCard } from "../../domain/budget.js";
import type { Request, Response } from "express";
import { ctx, ok } from "../../lib/http.js";
import * as service from "./dashboard.service.js";
import { performance as performanceOf } from "./performance.js";

export async function cockpit(req: Request, res: Response) {
  return ok(res, await service.cockpit(ctx(req).orgId));
}

export async function navCounts(req: Request, res: Response) {
  return ok(res, await service.navCounts(ctx(req).orgId));
}

export async function budget(req: Request, res: Response) {
  return ok(res, await budgetCard(ctx(req).orgId));
}

export async function performance(req: Request, res: Response) {
  const days = req.query.days === "30" ? 30 : 7;
  return ok(res, await performanceOf(ctx(req).orgId, days));
}
