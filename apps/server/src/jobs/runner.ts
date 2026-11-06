import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logSystem } from "../domain/systemLog.js";

export interface OrgJobResult {
  orgId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ForEachOrgOptions {
  /** Workspaces worked on at the same time. One slow workspace never holds up the rest. */
  concurrency?: number;
  /** The most one workspace may take in a run; past it the run moves on (the work itself may still finish). */
  perOrgMs?: number;
}

/** A different workspace leads each run, so with a time limit none is always last. */
let rotation = 0;

export async function forEachOrg(
  job: string,
  where: Prisma.OrganizationWhereInput,
  fn: (orgId: string) => Promise<unknown>,
  opts: ForEachOrgOptions = {},
): Promise<OrgJobResult[]> {
  const orgs = await prisma.organization.findMany({ where: { AND: [{ status: "ACTIVE" }, where] }, select: { id: true }, orderBy: [{ kind: "asc" }, { createdAt: "asc" }] });
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const start = concurrency > 1 && orgs.length ? rotation++ % orgs.length : 0;
  const queue = [...orgs.slice(start), ...orgs.slice(0, start)].map((o) => o.id);
  const out: OrgJobResult[] = [];
  const one = async (id: string) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = fn(id);
      const result = opts.perOrgMs
        ? await Promise.race([work, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`took longer than ${Math.round(opts.perOrgMs! / 1000)}s; moved on to the next workspace`)), opts.perOrgMs)))])
        : await work;
      out.push({ orgId: id, ok: true, result });
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ job, orgId: id, err: message }, "job failed for organization");
      await logSystem(id, "ERROR", job, `Scheduled ${job} failed: ${message}`).catch(() => undefined);
      out.push({ orgId: id, ok: false, error: message });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) await one(id);
  });
  await Promise.all(workers);
  return out;
}

const funded: Prisma.CreditLedgerListRelationFilter = { some: { kind: { in: ["TOPUP", "BONUS"] } } };

/**
 * Workspaces the jobs work for: funded at least once (a top-up or the free trial, their own or their billing
 * organization's), or our own internal outreach. Customers come first in every run, internal outreach after, so
 * paying customers are always served first when capacity is tight.
 */
export const payingOrgs: Prisma.OrganizationWhereInput = { OR: [{ kind: "INTERNAL" }, { creditLedger: funded }, { billingOrganization: { creditLedger: funded } }] };
export const autopilotOrgs: Prisma.OrganizationWhereInput = { AND: [payingOrgs, { settings: { autopilotEnabled: true } }] };
