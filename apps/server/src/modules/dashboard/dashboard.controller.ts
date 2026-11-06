import { budgetCard } from "../../domain/budget.js";
import type { Request, Response } from "express";
import { ctx, ok } from "../../lib/http.js";
import * as service from "./dashboard.service.js";
import { performance as performanceOf } from "./performance.js";
import { campaignNav, campaignWorkspace } from "./campaign.js";

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
  // ?period=today|7d|30d|all (the older ?days=30 still works), and ?campaign=<id> or "own" to narrow it.
  const q = String(req.query.period ?? (req.query.days === "30" ? "30d" : "7d"));
  const period = (["today", "7d", "30d", "all"] as const).find((p) => p === q) ?? "7d";
  const campaign = typeof req.query.campaign === "string" && req.query.campaign.trim() ? req.query.campaign.trim().slice(0, 64) : null;
  return ok(res, await performanceOf(ctx(req).orgId, period, campaign));
}

/** The campaigns listed in the sidebar: each audience with whether it is sending, paused or off. */
export async function campaigns(req: Request, res: Response) {
  return ok(res, await campaignNav(ctx(req).orgId));
}

/** One campaign's workspace: brief, leads, progress and what happened. */
export async function campaign(req: Request, res: Response) {
  return ok(res, await campaignWorkspace(ctx(req).orgId, String(req.params.id).slice(0, 64)));
}
