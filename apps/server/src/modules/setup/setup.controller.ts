import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok } from "../../lib/http.js";
import { parseBody } from "../../middleware/validate.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { businessProfileView, saveBusinessProfile } from "../../domain/businessProfile.js";
import { activeCampaign, saveSequence, sequenceErrors, sequenceView } from "../../domain/campaignSequence.js";
import { saveTargeting, targetingImpact, targetingView } from "../onboarding/onboarding.service.js";

const line = (n: number) => z.string().trim().max(n);
const list = (n: number, len = 200) => z.array(z.string().trim().min(1).max(len)).max(n);

const profileSchema = z.object({
  company: line(160),
  sell: line(700),
  who: line(500),
  where: line(300),
  offerings: list(12),
  differentiators: list(12),
  tone: line(500),
  proofPoints: z.array(z.object({ claim: z.string().trim().min(3).max(300), source: z.string().trim().min(3).max(300) })).max(20),
});

export async function profile(req: Request, res: Response) {
  return ok(res, await businessProfileView(ctx(req).orgId));
}

export async function saveProfile(req: Request, res: Response) {
  const body = parseBody(req, profileSchema);
  if (!body.sell) throw unprocessable("Say what you sell. Every email is built on it.");
  return ok(res, await saveBusinessProfile(ctx(req).orgId, body));
}

export async function sequence(req: Request, res: Response) {
  return ok(res, await sequenceView(ctx(req).orgId));
}

export async function saveSequenceHandler(req: Request, res: Response) {
  const { touches } = parseBody(req, z.object({ touches: z.array(z.object({ subject: z.string().max(120).nullable(), body: z.string().max(4000) })).length(4) }));
  const campaign = await activeCampaign(ctx(req).orgId);
  if (!campaign) throw notFound("Campaign");
  const shaped = touches.map((t, i) => ({ step: i + 1, day: 0, subject: i === 0 ? (t.subject ?? "") : null, body: t.body }));
  const errors = sequenceErrors(shaped);
  if (errors.length) throw unprocessable(errors[0].message, { errors });
  await saveSequence(campaign.id, shaped);
  return ok(res, await sequenceView(ctx(req).orgId));
}

const editSchema = z.object({
  groups: z.array(z.object({ id: z.string().max(40), on: z.boolean(), titles: list(25, 80), keywords: list(25, 80), sizes: list(7, 20), regions: list(25, 80) })).min(1).max(12),
});

export async function targeting(req: Request, res: Response) {
  return ok(res, await targetingView(ctx(req).orgId));
}

export async function targetingCheck(req: Request, res: Response) {
  const { groups } = parseBody(req, editSchema);
  return ok(res, await targetingImpact(ctx(req).orgId, groups));
}

export async function saveTargetingHandler(req: Request, res: Response) {
  const { groups, dropQueued } = parseBody(req, editSchema.extend({ dropQueued: z.boolean().default(false) }));
  return ok(res, await saveTargeting(ctx(req).orgId, groups, dropQueued));
}
