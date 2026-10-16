import type { LogLevel, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export async function logSystem(orgId: string | null, level: LogLevel, source: string, message: string, meta?: Prisma.InputJsonValue): Promise<void> {
  const log = level === "CRITICAL" || level === "ERROR" ? logger.error.bind(logger) : level === "WARN" ? logger.warn.bind(logger) : logger.info.bind(logger);
  log({ orgId, source, meta }, message);
  await prisma.systemLog
    .create({ data: { organizationId: orgId, level, source: source.slice(0, 40), message: message.slice(0, 1000), meta } })
    .catch((err: Error) => logger.error({ err: err.message }, "failed to persist system log"));
}
