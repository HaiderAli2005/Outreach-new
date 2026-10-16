import { Router, type Request, type Response } from "express";
import { env } from "../../config/env.js";
import { safeEqual } from "../../lib/crypto.js";
import { notFound, unauthorized } from "../../lib/errors.js";
import { ok } from "../../lib/http.js";
import { withLock } from "../../lib/locks.js";
import { JOBS } from "../../jobs/registry.js";

function authorize(req: Request) {
  const token = req.get("x-jobs-secret") ?? "";
  if (!token || !safeEqual(token, env.JOBS_SECRET)) throw unauthorized("Invalid jobs secret");
}

async function list(req: Request, res: Response) {
  authorize(req);
  return ok(res, Object.entries(JOBS).map(([name, j]) => ({ name, schedule: j.schedule, description: j.description })));
}

async function run(req: Request, res: Response) {
  authorize(req);
  const name = String(req.params.name);
  const job = JOBS[name];
  if (!job) throw notFound(`Job '${name}'`);
  const started = Date.now();
  const r = await withLock(`job:${name}`, job.lockMs, job.run);
  return ok(res, { job: name, ran: r.ran, ...(r.ran ? { result: r.result } : { reason: "already-running" }), durationMs: Date.now() - started });
}

export const jobsRouter = Router();
jobsRouter.get("/", list);
jobsRouter.post("/:name/run", run);
