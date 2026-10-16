import { advanceWarmup, evaluateDomainHealth, evaluateMailboxHealth, retireQuietMailboxes } from "../domain/pool/lifecycle.js";
import { cacheConsole, checkReorderTrigger, computeDilution, computeRiskScores, dilutionRegime, recomputeEwmaBurn, rollUpDomainHealth, snapshotPoolMetrics } from "../domain/pool/metrics.js";
import { seedInboxTest, verifyDomainDns } from "../domain/pool/auth.js";
import { pollMailboxes, retrySoftBounces, runFollowUps } from "../domain/sending/jobs.js";
import { archiveMailboxHistory } from "../domain/sending/inbound.js";
import { forEachOrg, autopilotOrgs } from "./runner.js";
import { releaseStaleHolds } from "../domain/credits/index.js";
import { logSystem } from "../domain/systemLog.js";

/** The shared pool's scheduled work. None of these spend money. */
export const runPollMailboxes = () => pollMailboxes();
export const runArchiveMailboxHistory = async () => ({ archived: await archiveMailboxHistory() });
export const runRetrySoftBounces = () => retrySoftBounces();
export const runFollowUpsJob = () => forEachOrg("follow-ups", autopilotOrgs, (orgId) => runFollowUps(orgId));
export const runVerifyDomainDns = () => verifyDomainDns();
export const runCacheConsole = async () => ({ cached: !!(await cacheConsole()) });
export const runSeedInboxTest = () => seedInboxTest();
export async function runComputeDilution() {
  const d = await computeDilution();
  return { dilution: d, regime: dilutionRegime(d) };
}
export const runMailboxHealth = () => evaluateMailboxHealth();
export const runDomainHealth = () => evaluateDomainHealth();
export const runAdvanceWarmup = () => advanceWarmup();
export const runRollUpDomainHealth = async () => ({ rows: await rollUpDomainHealth() });
export const runSnapshotPoolMetrics = () => snapshotPoolMetrics();
export const runRecomputeEwma = async () => ({ ewma: await recomputeEwmaBurn() });
export const runReorderCheck = () => checkReorderTrigger();
export const runRetireQuietMailboxes = () => retireQuietMailboxes();
export const runReleaseStaleHolds = async () => ({ released: await releaseStaleHolds() });

export async function runRiskScores() {
  const risks = await computeRiskScores();
  const atRisk = risks.filter((r) => r.band === "AT_RISK");
  if (atRisk.length) await logSystem(null, "WARN", "pool", `${atRisk.length} domain${atRisk.length === 1 ? " is" : "s are"} at risk of degrading within two weeks: ${atRisk.map((r) => r.name).slice(0, 10).join(", ")}.`);
  return { scored: risks.filter((r) => r.risk !== null).length, atRisk: atRisk.length };
}
