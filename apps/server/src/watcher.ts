import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { closeRedis } from "./lib/redis.js";
import { startMailboxWatcher } from "./domain/sending/watch.js";

/**
 * The mailbox watcher on its own: one IMAP IDLE connection per sending mailbox, so replies are read seconds after they
 * land. Run it as an always-on process next to the API (`npm run watcher`), several with MAILBOX_WATCH_SHARD=i/n once
 * one holds too many sockets, and leave MAILBOX_WATCH off on the API. Set REDIS_URL so its nudges reach every API
 * instance's live inbox at once; without Redis the inbox still notices within 5 seconds.
 */
async function main() {
  await prisma.$connect();
  const watcher = startMailboxWatcher();
  const beat = setInterval(() => logger.info(watcher.status(), "watcher status"), 10 * 60_000);
  beat.unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "watcher shutting down");
    setTimeout(() => process.exit(1), 10_000).unref();
    clearInterval(beat);
    await watcher.stop().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await closeRedis();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "watcher failed to start");
  process.exit(1);
});
