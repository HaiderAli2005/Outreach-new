import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { redisHealthy } from "../../lib/redis.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const checks: Record<string, string | number | null> = {};
  let status = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "fail";
    status = "down";
  }
  const redis = await redisHealthy();
  checks.redis = redis === null ? "not-configured" : redis ? "ok" : "fail";
  if (status === "ok") {
    checks.criticalAlerts = await prisma.systemLog.count({ where: { resolvedAt: null, level: "CRITICAL" } }).catch(() => null);
    if (checks.redis === "fail" || (checks.criticalAlerts ?? 0) > 0) status = "degraded";
  }
  res.status(status === "down" ? 503 : 200).json({ data: { status, checks, time: new Date().toISOString() } });
});
