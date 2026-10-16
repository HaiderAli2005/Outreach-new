import { SEQUENCE_STEPS } from "../config/plans.js";
import { prisma } from "../lib/prisma.js";
import { getSettings } from "../domain/settings.js";
import { blockEmail, pauseInFlight } from "../domain/suppression.js";
import { forEachOrg, autopilotOrgs } from "./runner.js";

export async function reconcile(orgId: string): Promise<number> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT c.id FROM "Contact" c
    JOIN "BlocklistEntry" b ON b."organizationId" = c."organizationId" AND (
      (b."entryType" = 'EMAIL' AND b.value = c."emailNormalized") OR
      (b."entryType" = 'DOMAIN' AND b.reason <> 'NO_RESPONSE' AND (b.value = c."companyDomain" OR b.value = c.domain))
    )
    WHERE c."organizationId" = ${orgId}
      AND c.status NOT IN ('BLOCKLISTED','UNSUBSCRIBED','BOUNCED')
      AND b.reason IN ('MANUAL','UNSUBSCRIBED','BOUNCED','COMPLAINED','NO_RESPONSE','REMOVED','DEAL_CLOSED','COMPETITOR','CUSTOMER')
      AND NOT (b.reason = 'NO_RESPONSE' AND c."repliedAt" IS NOT NULL)
      AND NOT (b."entryType" = 'DOMAIN' AND c.status = 'REPLIED')
    LIMIT 5000`;
  if (!ids.length) return 0;
  const r = await prisma.contact.updateMany({ where: { id: { in: ids.map((x) => x.id) }, status: { notIn: ["BLOCKLISTED", "UNSUBSCRIBED", "BOUNCED"] } }, data: { status: "BLOCKLISTED" } });
  return r.count;
}

/**
 * People who got the whole sequence and never answered go on the blocklist as NO_RESPONSE. "Got the whole
 * sequence" is read from our own sends: the third email went out (or the sequence ended early because a follow-up
 * could not be sent). Anyone still mid-sequence is left alone.
 */
export async function retireNonResponders(orgId: string): Promise<{ retired: number; skippedUnsent: number }> {
  const s = await getSettings(orgId);
  const cutoff = new Date(Date.now() - s.blocklistNoReplyDays * 86_400_000);
  const rows = await prisma.contact.findMany({
    where: { organizationId: orgId, status: "CONTACTED", repliedAt: null, firstContactedAt: { lte: cutoff }, lastContactedAt: { lte: cutoff } },
    select: { id: true, emailNormalized: true, sends: { where: { step: { gte: 1 } }, select: { step: true, status: true, nextRetryAt: true } } },
    take: 5000,
  });
  let retired = 0;
  let skippedUnsent = 0;
  for (const c of rows) {
    const finished = c.sends.some((x) => x.step === SEQUENCE_STEPS && (x.status === "SENT" || x.status === "DELIVERED")) || c.sends.some((x) => x.status === "REJECTED" && x.step > 1);
    const pending = c.sends.some((x) => x.status === "SOFT_BOUNCE" && x.nextRetryAt);
    if (!finished || pending) {
      skippedUnsent++;
      continue;
    }
    await prisma.contact.update({ where: { id: c.id }, data: { status: "BLOCKLISTED" } });
    await blockEmail(orgId, c.emailNormalized, "NO_RESPONSE", c.id, { emailOnly: true });
    await pauseInFlight(orgId, [c]);
    retired++;
  }
  return { retired, skippedUnsent };
}

export function runBlocklistJob() {
  return forEachOrg("blocklist", autopilotOrgs, async (orgId) => ({ reconciled: await reconcile(orgId), ...(await retireNonResponders(orgId)) }));
}
