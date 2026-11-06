import { runFirstTouchesJob, runSendJob } from "./send.js";
import { runBlocklistJob } from "./blocklist.js";
import { runReplySyncJob } from "./replySync.js";
import { runSourcingJob } from "./sourcing.js";
import { runReverifyJob } from "./reverify.js";
import { runBatchNotifyJob } from "./batchNotify.js";
import { runReportJob } from "./report.js";
import { runBillingSyncJob } from "./billingSync.js";
import * as pool from "./pool.js";
import { runAutoReload } from "../modules/billing/autoReload.js";
import { notifyCapacityReady } from "../domain/capacity.js";
import { runPendingFirstRuns } from "../modules/onboarding/firstRun.js";

export interface JobDefinition {
  run: () => Promise<unknown>;
  lockMs: number;
  schedule: string;
  description: string;
}

export const JOBS: Record<string, JobDefinition> = {
  send: { run: runSendJob, lockMs: 25 * 60_000, schedule: "*/30 * * * *", description: "Verify, personalize and start the day's new people through the send pipeline" },
  blocklist: { run: runBlocklistJob, lockMs: 20 * 60_000, schedule: "17 2 * * *", description: "Reconcile suppressions and retire non-responders" },
  "reply-sync": { run: runReplySyncJob, lockMs: 10 * 60_000, schedule: "*/5 * * * *", description: "Classify unread replies and draft return-date check-ins" },
  // No job ever sends a reply: replies are drafted and wait for a person to press Send.
  "first-touches": { run: runFirstTouchesJob, lockMs: 4 * 60_000, schedule: "*/5 * * * *", description: "Send first emails whose random minute inside the prospect's own working hours has come" },
  "first-runs": { run: () => runPendingFirstRuns(), lockMs: 30 * 60_000, schedule: "* * * * *", description: "Start or restart the first search for new campaigns that have none running" },
  sourcing: { run: runSourcingJob, lockMs: 55 * 60_000, schedule: "0 */2 * * *", description: "Source new leads from Apollo into the next week's batch" },
  reverify: { run: runReverifyJob, lockMs: 30 * 60_000, schedule: "0 3 * * *", description: "Re-verify held email addresses" },
  "batch-notify": { run: runBatchNotifyJob, lockMs: 10 * 60_000, schedule: "0 */3 * * *", description: "Remind owners about weeks waiting for approval" },
  "report-daily": { run: () => runReportJob("daily"), lockMs: 30 * 60_000, schedule: "0 18 * * 1-5", description: "Daily Slack summary" },
  "report-weekly": { run: () => runReportJob("weekly"), lockMs: 30 * 60_000, schedule: "0 8 * * 1", description: "Weekly Slack summary" },
  "report-monthly": { run: () => runReportJob("monthly"), lockMs: 30 * 60_000, schedule: "0 8 1 * *", description: "Monthly Slack summary" },
  "auto-reload": { run: runAutoReload, lockMs: 9 * 60_000, schedule: "*/10 * * * *", description: "Top up the workspaces that switched auto-reload on and dropped below their threshold, at most once a day each" },
  "capacity-notify": { run: () => notifyCapacityReady(), lockMs: 9 * 60_000, schedule: "45 * * * *", description: "Email customers who asked to hear when there is sending capacity for them" },
  "billing-sync": { run: runBillingSyncJob, lockMs: 30 * 60_000, schedule: "0 * * * *", description: "Credit any top-up whose Stripe webhook was missed" },
  // Our own sending engine: IMAP reading, soft-bounce retries, follow-ups.
  "mailbox-poll": { run: pool.runPollMailboxes, lockMs: 110_000, schedule: "*/2 * * * *", description: "Read every sending mailbox over IMAP: replies, auto-replies, bounces and complaints" },
  "soft-bounce-retry": { run: pool.runRetrySoftBounces, lockMs: 4 * 60_000, schedule: "*/5 * * * *", description: "Retry soft-bounced emails at 15 minutes, 2 hours and 12 hours" },
  "follow-ups": { run: pool.runFollowUpsJob, lockMs: 4 * 60_000, schedule: "*/5 * * * *", description: "Send sequence emails 2, 3 and 4 (days 3, 7, 14) from each person's pinned mailbox at their scheduled minute" },
  // Shared sending pool. Hourly state machines, daily roll-ups, weekly burn. Nothing here buys anything.
  "pool-mailbox-health": { run: pool.runMailboxHealth, lockMs: 15 * 60_000, schedule: "15 * * * *", description: "Move unhealthy mailboxes to replies-only and promote warmed ones" },
  "pool-domain-health": { run: pool.runDomainHealth, lockMs: 15 * 60_000, schedule: "20 * * * *", description: "Age, warm, activate, degrade and retire pool domains" },
  "pool-warmup": { run: pool.runAdvanceWarmup, lockMs: 15 * 60_000, schedule: "25 * * * *", description: "Step the warmup ramp once a day and reset daily send counts" },
  "pool-rollup": { run: pool.runRollUpDomainHealth, lockMs: 20 * 60_000, schedule: "10 0 * * *", description: "Rewrite domain_health_daily from the sends table" },
  "pool-risk": { run: pool.runRiskScores, lockMs: 20 * 60_000, schedule: "20 0 * * *", description: "Score each active domain's risk of degrading" },
  "pool-snapshot": { run: pool.runSnapshotPoolMetrics, lockMs: 20 * 60_000, schedule: "30 0 * * *", description: "Write today's pool_metrics_daily row" },
  "pool-ewma": { run: pool.runRecomputeEwma, lockMs: 20 * 60_000, schedule: "40 0 * * 1", description: "Recompute the weighted weekly burn" },
  "pool-reorder-check": { run: pool.runReorderCheck, lockMs: 20 * 60_000, schedule: "50 0 * * *", description: "Ask an operator to approve a restock when the shelf runs short" },
  "pool-retire-quiet": { run: pool.runRetireQuietMailboxes, lockMs: 30 * 60_000, schedule: "0 1 * * *", description: "Retire replies-only mailboxes that have gone quiet" },
  "pool-dns": { run: pool.runVerifyDomainDns, lockMs: 30 * 60_000, schedule: "5 2 * * *", description: "Check every pool domain's SPF, DKIM and DMARC records" },
  "pool-seed-test": { run: pool.runSeedInboxTest, lockMs: 30 * 60_000, schedule: "35 2 * * *", description: "Send one message per domain to the seed mailbox and verify our own SPF, DKIM and DMARC" },
  "inbox-history": { run: pool.runArchiveMailboxHistory, lockMs: 10 * 60_000, schedule: "*/30 * * * *", description: "Move mail that predates its mailbox out of the unmatched queue" },
  "pool-console": { run: pool.runCacheConsole, lockMs: 10 * 60_000, schedule: "*/15 * * * *", description: "Cache the ops console aggregates so /admin/pool never computes them on load" },
  "pool-dilution": { run: pool.runComputeDilution, lockMs: 10 * 60_000, schedule: "45 0 * * *", description: "Average customers per domain per day over the last week" },
  // Spends money only on orders an operator confirmed, within the pool's per-batch and per-day limits.
  "inboxkit-sync": { run: pool.runInboxKitSync, lockMs: 15 * 60_000, schedule: "*/10 * * * *", description: "InboxKit: place confirmed order batches, sign new mailboxes in, read warmup health, start the ladder, cancel retired mailboxes" },
  "credits-stale-holds": { run: pool.runReleaseStaleHolds, lockMs: 20 * 60_000, schedule: "15 1 * * *", description: "Return money held for sequences that ended without word from the sender" },
};
