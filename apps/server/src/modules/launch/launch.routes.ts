import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ctx, ok } from "../../lib/http.js";
import { requireManager } from "../../middleware/auth.js";
import { parseBody } from "../../middleware/validate.js";
import { approveFirstBatch, approvePeople, approvalView, hasConsent, recordConsent } from "../../domain/launch.js";
import { saveVocab, vocabFor } from "../../domain/leadStatus.js";
import { startFillToday } from "../onboarding/firstRun.js";

const meta = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null });

/** Approval before launch, and the consent record. No timer anywhere: nothing sends until a person approves. */
export const launchRouter = Router();
launchRouter.get("/", async (req: Request, res: Response) => ok(res, await approvalView(ctx(req).orgId)));
launchRouter.post("/approve", requireManager, async (req: Request, res: Response) => {
  const body = parseBody(req, z.object({ consent: z.boolean().default(false), excludeIds: z.array(z.string().max(40)).max(50).default([]), shownIds: z.array(z.string().max(40)).max(50).default([]), autoContinue: z.boolean().optional() }));
  const r = await approveFirstBatch(ctx(req).orgId, ctx(req).userId, { ...body, ...meta(req) });
  // The rest of today's emails are prepared now, not a few each run.
  startFillToday(ctx(req).orgId);
  return ok(res, r);
});
launchRouter.post("/approve-people", requireManager, async (req: Request, res: Response) => {
  const body = parseBody(req, z.object({ ids: z.array(z.string().max(40)).min(1).max(200), consent: z.boolean().default(false) }));
  return ok(res, await approvePeople(ctx(req).orgId, ctx(req).userId, body.ids, { consent: body.consent, ...meta(req) }));
});
launchRouter.post("/consent", requireManager, async (req: Request, res: Response) => {
  parseBody(req, z.object({ confirm: z.literal(true) }));
  if (!(await hasConsent(ctx(req).orgId))) await recordConsent(ctx(req).orgId, ctx(req).userId, meta(req));
  return ok(res, { consent: true });
});

/** The workspace's lead status vocabulary. */
export const vocabRouter = Router();
vocabRouter.get("/", async (req: Request, res: Response) => ok(res, await vocabFor(ctx(req).orgId)));
vocabRouter.put("/", requireManager, async (req: Request, res: Response) => {
  const body = parseBody(req, z.object({ items: z.array(z.object({ key: z.string().regex(/^[A-Z][A-Z_]{1,39}$/), label: z.string().trim().min(1).max(40), color: z.string().max(12).nullable().optional() })).min(1).max(30) }));
  return ok(res, await saveVocab(ctx(req).orgId, body.items));
});
