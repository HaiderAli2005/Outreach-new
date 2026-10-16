import { prisma } from "../../lib/prisma.js";
import { unprocessable } from "../../lib/errors.js";
import { getCredential } from "../../integrations/credentials.js";
import { features } from "../../config/env.js";
import { assertCanStart } from "../../domain/entitlements.js";

/**
 * Stopping outreach turns autopilot off: no new first touches and no follow-ups go out (both are sent by our own
 * jobs, which skip a workspace with autopilot off). Replies to people already talking keep working from the inbox.
 */
export async function stop(orgId: string) {
  await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { autopilotEnabled: false } });
  return { stopped: true };
}

export async function start(orgId: string) {
  await assertCanStart(orgId);
  const apollo = await getCredential(orgId, "APOLLO");
  if (!apollo || !features.ai) throw unprocessable("Can't start yet: a connection is missing. Finish Settings → Integrations first.");
  await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { autopilotEnabled: true } });
  // A setup that skipped the card is launched the first time outreach starts.
  await prisma.onboarding.updateMany({ where: { organizationId: orgId, launchedAt: null }, data: { launchedAt: new Date() } });
  return { started: true };
}
