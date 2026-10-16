import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok, boolish } from "../../lib/http.js";
import { parseBody, parseQuery } from "../../middleware/validate.js";
import * as service from "./onboarding.service.js";
import { features } from "../../config/env.js";
import { startAnalysisRun } from "../analyses/analyses.service.js";

export async function state(req: Request, res: Response) {
  return ok(res, await service.getState(ctx(req).orgId));
}

export async function start(req: Request, res: Response) {
  const { domain } = parseBody(req, z.object({ domain: z.string().trim().min(3).max(253) }));
  return ok(res, await service.start(ctx(req).orgId, domain));
}

const patchSchema = z
  .object({
    facts: z.array(z.object({ key: z.enum(["company", "sell", "who", "where", "proof"]), value: z.string().max(400) })).max(5),
    groups: z
      .array(z.object({ id: z.string().max(10), on: z.boolean().optional(), keywords: z.array(z.string().max(60)).max(10).optional() }))
      .max(6),
    emailsPerDay: z.number().int().min(1).max(100_000),
    warmupDays: z.number().int(),
    inboxesPerDomain: z.number().int().min(1).max(5),
    provider: z.enum(["google", "microsoft", "mixed"]),
    fastStart: z.boolean(),
  })
  .partial()
  .strict();

export async function update(req: Request, res: Response) {
  return ok(res, await service.update(ctx(req).orgId, parseBody(req, patchSchema)));
}

/** Step 5: how many emails a day the pool can take for this customer, with every price worked out here. */
export async function volume(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  return ok(res, await service.volume(ctx(req).orgId));
}

export async function skipCard(req: Request, res: Response) {
  return ok(res, await service.skipCard(ctx(req).orgId));
}

export async function notifyCapacity(req: Request, res: Response) {
  return ok(res, await service.notifyWhenReady(ctx(req).orgId));
}

export async function analyze(req: Request, res: Response) {
  const { orgId } = ctx(req);
  if (!features.analysisStream) return ok(res, await service.analyze(orgId));
  await startAnalysisRun(orgId);
  return ok(res, await service.getState(orgId));
}

export async function answers(req: Request, res: Response) {
  const body = parseBody(
    req,
    z.object({
      sell: z.string().trim().min(3, "Tell us what you sell").max(400),
      who: z.string().trim().min(3, "Tell us who buys it").max(400),
      regions: z.array(z.string().trim().min(2).max(60)).min(1, "Pick at least one country").max(9),
    }),
  );
  return ok(res, await service.answers(ctx(req).orgId, body));
}

export async function market(req: Request, res: Response) {
  const q = parseQuery(req, z.object({ refresh: boolish.optional() }));
  return ok(res, await service.market(ctx(req).orgId, !!q.refresh));
}

export async function keywords(req: Request, res: Response) {
  const q = parseQuery(req, z.object({ group: z.string().min(1).max(10) }));
  return ok(res, await service.keywordCounts(ctx(req).orgId, q.group));
}

export async function preview(req: Request, res: Response) {
  return ok(res, await service.preview(ctx(req).orgId));
}

export async function launch(req: Request, res: Response) {
  return ok(res, await service.launch(ctx(req).orgId));
}

export async function firstRun(req: Request, res: Response) {
  return ok(res, await service.retryFirstRun(ctx(req).orgId));
}
