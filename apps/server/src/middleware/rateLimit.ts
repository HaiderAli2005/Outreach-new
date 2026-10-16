import rateLimit, { type Options, type Store } from "express-rate-limit";
import { getRedis } from "../lib/redis.js";
import { tooManyRequests } from "../lib/errors.js";

class RedisStore implements Store {
  windowMs = 60_000;
  prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  init(options: Options) {
    this.windowMs = options.windowMs;
  }
  async increment(key: string) {
    const redis = getRedis()!;
    const k = this.prefix + key;
    const hits = await redis.incr(k);
    if (hits === 1) await redis.pexpire(k, this.windowMs);
    const ttl = await redis.pttl(k);
    return { totalHits: hits, resetTime: new Date(Date.now() + Math.max(ttl, 0)) };
  }
  async decrement(key: string) {
    await getRedis()!.decr(this.prefix + key);
  }
  async resetKey(key: string) {
    await getRedis()!.del(this.prefix + key);
  }
}

export function limiter(name: string, windowMs: number, limit: number, keyFn?: Options["keyGenerator"]) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    store: getRedis() ? new RedisStore(`rl:${name}:`) : undefined,
    keyGenerator: keyFn,
    passOnStoreError: true,
    handler: (_req, _res, next) => next(tooManyRequests()),
  });
}
