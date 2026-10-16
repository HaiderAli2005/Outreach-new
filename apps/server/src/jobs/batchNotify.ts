import { prisma } from "../lib/prisma.js";
import { webOrigins, env } from "../config/env.js";
import { approveToken, batchStats, weekLabel } from "../domain/batches.js";
import { postToSlack } from "../integrations/slack.js";
import { forEachOrg, payingOrgs } from "./runner.js";

const NAG_EVERY_MS = 3 * 3_600_000;

export async function notifyForOrg(orgId: string) {
  const pending = await prisma.weeklyBatch.findMany({
    where: { organizationId: orgId, status: "REVIEW", OR: [{ lastNagAt: null }, { lastNagAt: { lt: new Date(Date.now() - NAG_EVERY_MS) } }] },
  });
  let sent = 0;
  for (const b of pending) {
    const stats = await batchStats(orgId, b.id);
    const link = `${env.PUBLIC_API_URL.replace(/\/$/, "")}/api/v1/public/batches/approve?batch=${b.id}&token=${approveToken(b.id)}`;
    const ok = await postToSlack(
      orgId,
      `:hourglass: The week of ${weekLabel(b)} has ${stats.sendable} leads waiting for your approval. Review them at ${webOrigins[0]}/app/leads?week=${b.id} or approve in one click: ${link}`,
    );
    if (ok) sent++;
    await prisma.weeklyBatch.update({ where: { id: b.id }, data: { lastNagAt: new Date() } });
  }
  return { pending: pending.length, notified: sent };
}

export function runBatchNotifyJob() {
  return forEachOrg("batch-notify", { AND: [payingOrgs, { batches: { some: { status: "REVIEW" } } }] }, notifyForOrg);
}
