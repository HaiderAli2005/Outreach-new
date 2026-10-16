import { prisma } from "./prisma.js";
import { getRedis } from "./redis.js";
import { randomToken } from "./crypto.js";

function advisoryKey(name: string): bigint {
  let h = 1125899906842597n;
  for (const ch of name) h = (h * 31n + BigInt(ch.charCodeAt(0))) & 0x7fffffffffffffffn;
  return h;
}

export async function withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<{ ran: true; result: T } | { ran: false }> {
  const redis = getRedis();
  if (redis) {
    const token = randomToken(16);
    const got = await redis.set(`lock:${name}`, token, "PX", ttlMs, "NX").catch(() => null);
    if (got === "OK") {
      try {
        return { ran: true, result: await fn() };
      } finally {
        await redis
          .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, `lock:${name}`, token)
          .catch(() => undefined);
      }
    }
    if (got === null && redis.status === "ready") return { ran: false };
  }
  const key = advisoryKey(name);
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${key}) AS locked`;
      if (!rows[0]?.locked) return { ran: false as const };
      return { ran: true as const, result: await fn() };
    },
    { timeout: ttlMs, maxWait: 5000 },
  );
}
