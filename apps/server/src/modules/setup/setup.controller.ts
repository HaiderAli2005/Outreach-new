import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok } from "../../lib/http.js";
import { parseBody } from "../../middleware/validate.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { businessProfileView, saveBusinessProfile } from "../../domain/businessProfile.js";
import { activeCampaign, saveSequence, sequenceErrors, sequenceView } from "../../domain/campaignSequence.js";
import { createAudience, importAudiences, MAX_AUDIENCES, previewAudience, saveTargeting, targetingImpact, targetingView } from "../onboarding/onboarding.service.js";

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
  groups: z.array(z.object({ id: z.string().max(40), on: z.boolean(), titles: list(25, 80), keywords: list(25, 80), sizes: list(7, 20), regions: list(25, 80) })).min(1).max(MAX_AUDIENCES),
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

const newAudienceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: line(600).default(""),
  why: line(600).default(""),
  titles: list(25, 80).default([]),
  includeSimilarTitles: z.boolean().default(true),
  seniorities: list(11, 20).default([]),
  keywords: list(25, 80).min(1),
  sizes: list(7, 20).default([]),
  regions: list(25, 80).min(1),
  source: z.enum(["apollo", "maps", "both"]).default("apollo"),
  namedOnly: z.boolean().default(false),
  mapsCities: list(40, 80).default([]),
});

/** "New campaign": one more audience, searched on its own and switched on right away. */
export async function createAudienceHandler(req: Request, res: Response) {
  return ok(res, await createAudience(ctx(req).orgId, parseBody(req, newAudienceSchema)));
}

/** The live count and a few example people while a new campaign is being written. */
export async function previewAudienceHandler(req: Request, res: Response) {
  const body = parseBody(req, newAudienceSchema.extend({ name: z.string().max(60).default(""), keywords: list(25, 80).default([]), regions: list(25, 80).default([]) }));
  return ok(res, await previewAudience(ctx(req).orgId, body));
}

/** Many campaigns from one CSV, parsed in the browser. `check: true` only checks the rows. */
export async function importAudiencesHandler(req: Request, res: Response) {
  const row = newAudienceSchema.extend({ name: z.string().trim().max(60).default(""), keywords: list(25, 80).default([]), regions: list(25, 80).default([]) });
  const { rows, check } = parseBody(req, z.object({ rows: z.array(row).min(1).max(MAX_AUDIENCES), check: z.boolean().default(false) }));
  return ok(res, await importAudiences(ctx(req).orgId, rows, check));
}
