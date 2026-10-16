import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok } from "../../lib/http.js";
import { parseBody, parseParams } from "../../middleware/validate.js";
import * as service from "./settings.service.js";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const patchSchema = z
  .object({
    autopilotEnabled: z.boolean(),
    weeklyBatchMode: z.boolean(),
    autoApproveBatches: z.boolean(),
    leadSourcing: z.enum(["AUTOMATIC", "OFF"]),
    perMailboxDailyCap: z.number().int(),
    blocklistNoReplyDays: z.number().int(),
    timezone: z.string().max(64),
    sendingWindowStart: time,
    sendingWindowEnd: time,
    language: z.string().regex(/^[a-z]{2}$/),
    personalizationEnabled: z.boolean(),
    requireVerifiedEmail: z.boolean(),
    monthlyCreditCap: z.number().int().min(0).max(10_000_000),
    dailyCreditCap: z.number().int().min(0).max(1_000_000),
    dailySourceTarget: z.number().int().min(20).max(5000),
    apolloCycleResetDay: z.number().int(),
    perCompanyContactCap: z.number().int(),
    senderCompany: z.string().trim().max(160).nullable(),
    senderTitle: z.string().trim().max(120).nullable(),
    senderAddress: z.string().trim().max(300).nullable(),
    meetingLink: z.string().trim().max(500).nullable(),
    valueProp: z.string().trim().max(600).nullable(),
    optOutLine: z.string().trim().max(300).nullable(),
    browserNotifications: z.boolean(),
    draftReplies: z.boolean(),
    launchMode: z.enum(["APPROVE_EACH", "APPROVE_FIRST_BATCH", "AUTO"]),
    sendDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    prospectTimezone: z.string().max(64).nullable(),
    // The daily budget is always a number for a customer: 0 pauses; "no cap" is an admin-only setting.
    dailyBudgetDecicents: z.string().regex(/^\d{1,12}$/),
    autoReloadEnabled: z.boolean(),
    autoReloadThresholdDecicents: z.string().regex(/^\d{1,12}$/),
    autoReloadAmountDecicents: z.string().regex(/^\d{1,12}$/),
    autoReloadSetupIntentId: z.string().max(100),
    proofPoints: z.array(z.object({ claim: z.string().trim().min(3).max(300), source: z.string().trim().min(3).max(300) })).max(20),
  })
  .partial()
  .strict();

const provider = z.object({ provider: z.enum(["APOLLO", "MILLIONVERIFIER", "SLACK_WEBHOOK"]) });

export async function view(req: Request, res: Response) {
  return ok(res, await service.view(ctx(req).orgId));
}

export async function update(req: Request, res: Response) {
  return ok(res, await service.update(ctx(req).orgId, parseBody(req, patchSchema), { userId: ctx(req).userId, ip: req.ip ?? null }));
}

export async function saveCredential(req: Request, res: Response) {
  const { provider: p } = parseParams(req, provider);
  const { value } = parseBody(req, z.object({ value: z.string().trim().min(1).max(500) }));
  return ok(res, await service.saveCredential(ctx(req).orgId, p, value));
}

export async function removeCredential(req: Request, res: Response) {
  return ok(res, await service.removeCredential(ctx(req).orgId, parseParams(req, provider).provider));
}

export async function verifyEmail(req: Request, res: Response) {
  const { email } = parseBody(req, z.object({ email: z.email() }));
  return ok(res, await service.verifyEmail(ctx(req).orgId, email));
}

export async function autopilot(req: Request, res: Response) {
  return ok(res, await service.autopilotStatus(ctx(req).orgId));
}
