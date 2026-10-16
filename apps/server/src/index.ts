import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { closeRedis } from "./lib/redis.js";
import { interruptActiveRuns } from "./modules/analyses/analyses.service.js";
import { features } from "./config/env.js";
import { startJobsInProcess } from "./jobs/inProcess.js";
import { startMailboxWatcher } from "./domain/sending/watch.js";
import { closeInboxEvents } from "./domain/sending/inboxEvents.js";
import { endInboxStreams } from "./modules/inbox/inbox.stream.js";

async function main() {
  await prisma.$connect();
  const app = createApp();
  const server = app.listen(env.PORT, "0.0.0.0", () => logger.info({ port: env.PORT }, "api listening"));
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 61_000;

  // Locally there is no Cloud Scheduler, so the API runs every background job itself, each on its own schedule.
  if (features.jobsInProcess) {
    startJobsInProcess();
    logger.info("background jobs run inside the API on their schedules (RUN_JOBS_IN_PROCESS)");
  }
  // Instant replies. In production this runs as its own process (src/watcher.ts) instead.
  const watcher = features.mailboxWatchInProcess ? startMailboxWatcher() : null;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    setTimeout(() => process.exit(1), 10_000).unref();
    // Ends any analysis mid-run first, so the page starts a fresh one instead of waiting on a dead one.
    await Promise.race([interruptActiveRuns().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
    await watcher?.stop().catch(() => undefined);
    // Live inbox streams never end on their own, so they are closed here or server.close would wait on them.
    endInboxStreams();
    server.close(async () => {
      await prisma.$disconnect().catch(() => undefined);
      await closeInboxEvents();
      await closeRedis();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
