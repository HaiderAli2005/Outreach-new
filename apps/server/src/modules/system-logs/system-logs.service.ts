import type { LogLevel } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

export async function list(orgId: string, q: { level?: LogLevel; open?: boolean; limit: number }) {
  const [logs, open] = await Promise.all([
    prisma.systemLog.findMany({
      where: { organizationId: orgId, ...(q.level ? { level: q.level } : {}), ...(q.open ? { resolvedAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: q.limit,
    }),
    prisma.systemLog.groupBy({ by: ["level"], where: { organizationId: orgId, resolvedAt: null }, _count: { _all: true } }),
  ]);
  return { logs, openByLevel: Object.fromEntries(open.map((o) => [o.level, o._count._all])) };
}

export async function resolve(orgId: string, id?: string) {
  const r = await prisma.systemLog.updateMany({ where: { organizationId: orgId, resolvedAt: null, ...(id ? { id } : {}) }, data: { resolvedAt: new Date() } });
  return { cleared: r.count };
}
