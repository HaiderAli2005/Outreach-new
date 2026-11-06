import { prisma } from "./prisma.js";
import { getRedis } from "./redis.js";
import { randomToken } from "./crypto.js";

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
  // No Redis: a lease row. Taken in one statement (free, or the last holder's lease ran out), and it holds no database
  // connection while `fn` runs, so a dozen jobs starting in the same minute can't use up the connection pool.
  const token = randomToken(16);
  const rows = await prisma.$queryRaw<{ token: string }[]>`
    INSERT INTO "JobLease" ("name", "token", "expiresAt") VALUES (${name}, ${token}, now() + ${ttlMs} * interval '1 millisecond')
    ON CONFLICT ("name") DO UPDATE SET "token" = EXCLUDED."token", "expiresAt" = EXCLUDED."expiresAt" WHERE "JobLease"."expiresAt" < now()
    RETURNING "token"`;
  if (rows[0]?.token !== token) return { ran: false };
  try {
    return { ran: true, result: await fn() };
  } finally {
    await prisma.$executeRaw`DELETE FROM "JobLease" WHERE "name" = ${name} AND "token" = ${token}`.catch(() => undefined);
  }
}
