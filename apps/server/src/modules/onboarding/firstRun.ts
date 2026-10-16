import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { logSystem } from "../../domain/systemLog.js";
import { getSettings } from "../../domain/settings.js";
import { FIRST_BATCH_SIZE, hasConsent } from "../../domain/launch.js";
import { sourceForOrg } from "../../jobs/sourcing.js";
import { notifyOwners } from "../../domain/sending/health.js";
import { env } from "../../config/env.js";
import { personalizeNew, verifyNew } from "../../jobs/send.js";

/**
 * The first search after launch. Scheduled finding runs every two hours, so without this a new customer would watch
 * a spinner for up to two hours (or until Sunday in weekly mode). It runs once, straight away, in the background:
 * find the first people, verify their addresses, write their emails. Its outcome is stored so the launch page shows
 * what really happened, including why it stopped.
 */

/** Why a first run found nobody, in words the launch page shows as they are. */
export type FirstRunReason = "apollo-not-configured" | "sourcing-off" | "no-active-campaign" | "out-of-credits" | "nobody-found" | "error";

export interface FirstRunResult {
  ok: boolean;
  reason?: FirstRunReason;
  message?: string;
  found: number;
  verified: number;
  written: number;
}

/** A run that has not finished after this long is taken as interrupted (a restart, a crash), and is run again. */
const STALE_MS = 15 * 60_000;
/** Only new campaigns get a first run: a workspace launched long ago is on its normal schedule. */
const FIRST_RUN_WINDOW_MS = 7 * 86_400_000;
/** Runs started by this process, so tests (and a graceful shutdown) can wait for them. */
const inFlight = new Set<Promise<unknown>>();

/**
 * Claims the run in the database, so only one server ever runs it, however many are up: the row is updated only if
 * no run has started, or the last one was interrupted. Whoever updates it owns the run.
 */
async function claim(orgId: string): Promise<boolean> {
  const r = await prisma.onboarding.updateMany({
    where: { organizationId: orgId, launchedAt: { not: null }, OR: [{ firstRunStartedAt: null }, { firstRunFinishedAt: null, firstRunStartedAt: { lt: new Date(Date.now() - STALE_MS) } }] },
    data: { firstRunStartedAt: new Date(), firstRunFinishedAt: null, firstRunResult: Prisma.DbNull },
  });
  return r.count === 1;
}

/** Find, check, write: the same steps the scheduled jobs take, for this one workspace, now. */
async function run(orgId: string): Promise<FirstRunResult> {
  const sourced = await sourceForOrg(orgId, { force: true });
  if ("skipped" in sourced) {
    const reason: FirstRunReason = sourced.skipped === "apollo-not-configured" || sourced.skipped === "sourcing-off" ? sourced.skipped : "no-active-campaign";
    return { ok: false, reason, found: 0, verified: 0, written: 0 };
  }
  if (!sourced.inserted) {
    return { ok: false, reason: sourced.outOfCredits ? "out-of-credits" : "nobody-found", found: 0, verified: 0, written: 0 };
  }
  const verified = await verifyNew(orgId);
  const written = await personalizeNew(orgId);
  return { ok: true, found: sourced.inserted, verified: verified.good, written };
}

async function execute(orgId: string): Promise<void> {
  const result = await run(orgId).catch(async (e: Error): Promise<FirstRunResult> => {
    logger.error({ orgId, err: e.message }, "first run failed");
    await logSystem(orgId, "ERROR", "sourcing", `Finding the first people stopped: ${e.message}`.slice(0, 300)).catch(() => undefined);
    return { ok: false, reason: "error", message: e.message.slice(0, 200), found: 0, verified: 0, written: 0 };
  });
  await prisma.onboarding
    .update({ where: { organizationId: orgId }, data: { firstRunFinishedAt: new Date(), firstRunResult: result as unknown as Prisma.InputJsonValue } })
    .catch((e: Error) => logger.error({ orgId, err: e.message }, "first run result not saved"));
  await tellOwners(orgId, result).catch((e: Error) => logger.warn({ orgId, err: e.message }, "first run email not sent"));
}

const NO_PEOPLE_BECAUSE: Record<FirstRunReason, string> = {
  "apollo-not-configured": "finding people is not connected on our side yet. We are on it.",
  "sourcing-off": "finding new people is turned off in your Settings. Turn it on, or upload your own list.",
  "no-active-campaign": "your campaign is paused. Resume it and we start straight away.",
  "out-of-credits": "your balance cannot cover new people yet. Add credits and we start straight away.",
  "nobody-found": "nobody new matched your audiences. Widen them under Setup, Targeting, then press Try again.",
  error: "something went wrong on our side. Press Try again on the launch page.",
};

/** The customer may have closed the page: they hear by email when the first people are ready, or why not. */
async function tellOwners(orgId: string, r: FirstRunResult): Promise<void> {
  const settings = await getSettings(orgId);
  const web = env.WEB_ORIGIN.split(",")[0].trim();
  if (r.ok && r.written && settings.launchMode !== "AUTO" && !settings.firstBatchApprovedAt) {
    await notifyOwners(orgId, "Your first people are ready", `We found ${r.found} people for your campaign and wrote their emails. Check the first ${FIRST_BATCH_SIZE} and approve them, and sending starts in their own working hours: ${web}/app/approve`);
  } else if (!r.ok) {
    await notifyOwners(orgId, "We could not find your first people yet", `Your campaign is saved, but ${NO_PEOPLE_BECAUSE[r.reason ?? "error"]} ${web}/onboarding`);
  }
}

/** Starts the first run now, in the background, if nobody else has. Safe to call any number of times. */
export async function startFirstRun(orgId: string): Promise<boolean> {
  if (!(await claim(orgId))) return false;
  const p = execute(orgId).finally(() => inFlight.delete(p));
  inFlight.add(p);
  return true;
}

/** "Try again": a finished run is opened again, then claimed like any other. A run still going is left alone. */
export async function retryFirstRun(orgId: string): Promise<boolean> {
  await prisma.onboarding.updateMany({ where: { organizationId: orgId, firstRunFinishedAt: { not: null } }, data: { firstRunStartedAt: null, firstRunFinishedAt: null, firstRunResult: Prisma.DbNull } });
  return startFirstRun(orgId);
}

/**
 * Every minute, the safety net: picks up first runs nobody started (a launch whose background run never began) or
 * that were interrupted by a restart, a few at a time, so a burst of launches cannot swamp the server. Runs through
 * the job scheduler, so in production any worker can take it, and the claim keeps it to one.
 */
export async function runPendingFirstRuns(limit = 5): Promise<{ ran: number }> {
  const due = await prisma.onboarding.findMany({
    where: {
      launchedAt: { gte: new Date(Date.now() - FIRST_RUN_WINDOW_MS) },
      OR: [{ firstRunStartedAt: null }, { firstRunFinishedAt: null, firstRunStartedAt: { lt: new Date(Date.now() - STALE_MS) } }],
    },
    select: { organizationId: true },
    orderBy: { launchedAt: "asc" },
    take: limit,
  });
  let ran = 0;
  for (const o of due) {
    if (!(await claim(o.organizationId))) continue;
    await execute(o.organizationId);
    ran++;
  }
  return { ran };
}

/** For tests and shutdown: resolves once every first run started in this process has finished. */
export async function settleFirstRuns(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/** What the launch page shows, from the database: the run's state and real counts. */
export async function firstRunView(orgId: string) {
  const [o, settings, consent, found, verified, written] = await Promise.all([
    prisma.onboarding.findUnique({ where: { organizationId: orgId }, select: { launchedAt: true, firstRunStartedAt: true, firstRunFinishedAt: true, firstRunResult: true } }),
    getSettings(orgId),
    hasConsent(orgId),
    prisma.contact.count({ where: { organizationId: orgId, status: { not: "REJECTED" } } }),
    prisma.contact.count({ where: { organizationId: orgId, verifyResult: "ok", status: { not: "REJECTED" } } }),
    prisma.contact.count({ where: { organizationId: orgId, status: { in: ["PERSONALIZED", "QUEUED", "CONTACTED", "REPLIED"] } } }),
  ]);
  if (!o?.launchedAt) return null;
  const stale = !!o.firstRunStartedAt && !o.firstRunFinishedAt && Date.now() - o.firstRunStartedAt.getTime() >= STALE_MS;
  const state: "idle" | "running" | "done" | "failed" = !o.firstRunStartedAt || stale ? "idle" : !o.firstRunFinishedAt ? "running" : (o.firstRunResult as FirstRunResult | null)?.ok ? "done" : "failed";
  const result = (o.firstRunResult as FirstRunResult | null) ?? null;
  return {
    state,
    reason: result?.reason ?? null,
    message: result?.message ?? null,
    startedAt: o.firstRunStartedAt,
    finishedAt: o.firstRunFinishedAt,
    found,
    verified,
    written,
    // Nothing is sent until a person approves the first people (unless the workspace chose to send without asking).
    needsApproval: settings.launchMode !== "AUTO" && !settings.firstBatchApprovedAt,
    approved: !!settings.firstBatchApprovedAt || settings.launchMode === "AUTO",
    approveCount: FIRST_BATCH_SIZE,
    consent,
    windowStart: settings.sendingWindowStart,
  };
}
