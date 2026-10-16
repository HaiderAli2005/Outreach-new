import { prisma } from "../lib/prisma.js";
import { verifierFor } from "../integrations/verifier.js";
import { blockEmail } from "../domain/suppression.js";
import { addUsage } from "../domain/usage.js";
import { forEachOrg, autopilotOrgs } from "./runner.js";

export async function reverifyForOrg(orgId: string) {
  const verify = await verifierFor(orgId);
  if (!verify) return { skipped: "verifier-not-configured" };
  const rows = await prisma.contact.findMany({
    where: {
      organizationId: orgId,
      status: { in: ["NEW", "PERSONALIZED", "QUEUED"] },
      verifyResult: { notIn: ["ok", "catch_all"] },
      verifiedAt: { lt: new Date(Date.now() - 7 * 86_400_000) },
    },
    take: 100,
  });
  let ok = 0;
  let dropped = 0;
  for (const c of rows) {
    const v = await verify(c.email);
    if (v.transient) continue;
    await addUsage(orgId, "emailsVerified");
    await prisma.contact.update({ where: { id: c.id }, data: { verifyResult: v.result, verifyQuality: v.quality, verifiedAt: new Date() } });
    if (v.ok) ok++;
    else {
      await prisma.contact.update({ where: { id: c.id }, data: { status: "BOUNCED" } });
      await blockEmail(orgId, c.emailNormalized, "BOUNCED", c.id, { emailOnly: true });
      dropped++;
    }
  }
  return { checked: rows.length, ok, dropped };
}

export function runReverifyJob() {
  return forEachOrg("reverify", autopilotOrgs, reverifyForOrg);
}
