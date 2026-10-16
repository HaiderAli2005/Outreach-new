import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

let client: Redis | null = null;

export function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
    client.on("error", (err) => logger.warn({ err: err.message }, "redis error"));
  }
  return client;
}

export async function redisHealthy(): Promise<boolean | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}
