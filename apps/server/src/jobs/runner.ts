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

export async function forEachOrg(
  job: string,
  where: Prisma.OrganizationWhereInput,
  fn: (orgId: string) => Promise<unknown>,
): Promise<OrgJobResult[]> {
  const orgs = await prisma.organization.findMany({ where: { AND: [{ status: "ACTIVE" }, where] }, select: { id: true }, orderBy: [{ kind: "asc" }, { createdAt: "asc" }] });
  const out: OrgJobResult[] = [];
  for (const { id } of orgs) {
    try {
      out.push({ orgId: id, ok: true, result: await fn(id) });
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ job, orgId: id, err: message }, "job failed for organization");
      await logSystem(id, "ERROR", job, `Scheduled ${job} failed: ${message}`);
      out.push({ orgId: id, ok: false, error: message });
    }
  }
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
