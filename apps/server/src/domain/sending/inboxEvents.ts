import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import { getRedis } from "../../lib/redis.js";
import { logger } from "../../lib/logger.js";

/**
 * "New mail was just read": the nudge that makes the live inbox stream (modules/inbox/inbox.stream.ts) look again at
 * once instead of at its next check. It carries no data, only a wake-up, so a missed one costs a few seconds, never
 * a message.
 *
 * Within one process it is an EventEmitter. With REDIS_URL set it is also published on a Redis channel, so a watcher
 * running as its own process (src/watcher.ts) wakes the streams held by every API instance.
 */
const CHANNEL = "ap:inbox-changed";
const bus = new EventEmitter();
bus.setMaxListeners(0);
let subscriber: Redis | null = null;

export function inboxChanged(): void {
  bus.emit("changed");
  getRedis()?.publish(CHANNEL, "1").catch(() => undefined);
}

/** Calls `fn` on every nudge, from this process or (with Redis) any other. Returns the unsubscribe. */
export function onInboxChanged(fn: () => void): () => void {
  bus.on("changed", fn);
  const redis = getRedis();
  if (redis && !subscriber) {
    // A subscribed Redis connection can do nothing else, so it is a second connection, opened on first use.
    subscriber = redis.duplicate();
    subscriber.on("error", (err) => logger.warn({ err: err.message }, "inbox events: redis subscriber error"));
    subscriber.on("message", (channel) => channel === CHANNEL && bus.emit("changed"));
    subscriber.subscribe(CHANNEL).catch((err: Error) => logger.warn({ err: err.message }, "inbox events: subscribe failed"));
  }
  return () => void bus.off("changed", fn);
}

export async function closeInboxEvents(): Promise<void> {
  if (subscriber) {
    await subscriber.quit().catch(() => undefined);
    subscriber = null;
  }
}
