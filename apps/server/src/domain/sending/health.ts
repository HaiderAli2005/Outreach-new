import { prisma } from "../../lib/prisma.js";
import { logSystem } from "../systemLog.js";
import { sendMail } from "../../integrations/mailer.js";
import { badWeight, DELIVERED_OR_BOUNCED } from "../pool/lifecycle.js";

/**
 * Customer-level health, the shared pool's safety valve. On a shared pool one customer's bad list damages domains
 * every other customer sends from, and the mailbox isn't at fault, so protection acts on the customer.
 *
 * Over the customer's last 100 first-touch sends (since any unpause):
 *   (hard bounces + complaints) / sends > 2%  -> WARNING: a banner and an email to the customer
 *                                     > 4%  -> PAUSED: no new first touches; replies and follow-ups carry on
 */
export const HEALTH_WINDOW = 100;
export const WARN_RATE = 0.02;
export const PAUSE_RATE = 0.04;
/** Below this many first touches the rate is noise, so nothing is decided on it yet. */
export const HEALTH_MIN_SENDS = 25;

export async function recomputeCustomerHealth(orgId: string, now = new Date()) {
  const current = await prisma.customerHealth.findUnique({ where: { organizationId: orgId } });
  const rows = await prisma.send.findMany({
    where: { organizationId: orgId, isFirstTouch: true, status: { in: [...DELIVERED_OR_BOUNCED] }, ...(current?.unpausedAt ? { sentAt: { gt: current.unpausedAt } } : {}) },
    orderBy: { sentAt: "desc" },
    take: HEALTH_WINDOW,
    select: { status: true },
  });
  const bad = rows.reduce((a, r) => a + badWeight(r.status), 0);
  const rate = rows.length ? bad / rows.length : 0;
  const decided = rows.length >= HEALTH_MIN_SENDS;
  let status = current?.status ?? "OK";
  // A pause sticks until the list is re-verified or an operator lifts it; the rate alone never unpauses.
  if (status !== "PAUSED") status = decided && rate > PAUSE_RATE ? "PAUSED" : decided && rate > WARN_RATE ? "WARNING" : "OK";
  const becamePaused = status === "PAUSED" && current?.status !== "PAUSED";
  const becameWarning = status === "WARNING" && current?.status !== "WARNING";
  const row = await prisma.customerHealth.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId, windowSends: rows.length, windowBounces: bad, bounceRate: rate.toFixed(4), status, ...(becamePaused ? { pausedAt: now, pausedReason: reason(rate, rows.length) } : {}) },
    update: { windowSends: rows.length, windowBounces: bad, bounceRate: rate.toFixed(4), status, ...(becamePaused ? { pausedAt: now, pausedReason: reason(rate, rows.length) } : {}) },
  });
  if (becamePaused) {
    await logSystem(orgId, "CRITICAL", "sending", `New emails are paused: ${reason(rate, rows.length)}. Conversations already going carry on. Re-verify your list from Billing → Credits to start again.`);
    await notifyOwners(orgId, "New emails are paused", `${reason(rate, rows.length)}. Replies and follow-ups to people you are already talking to carry on. Re-verify your list in Aperture to start sending again.`);
  } else if (becameWarning) {
    await logSystem(orgId, "WARN", "sending", `Your bounce rate is ${(rate * 100).toFixed(1)}%. Above 4% new emails pause to protect deliverability.`);
    await notifyOwners(orgId, "Your bounce rate is rising", `${(rate * 100).toFixed(1)}% of your recent emails bounced. Above 4% new emails pause automatically. Check the people you uploaded or re-verify your list.`);
  }
  return row;
}

function reason(rate: number, sends: number): string {
  return `${(rate * 100).toFixed(1)}% of your last ${sends} first emails bounced or were marked as spam`;
}

export async function notifyOwners(orgId: string, subject: string, text: string): Promise<void> {
  const owners = await prisma.membership.findMany({ where: { organizationId: orgId, role: { in: ["OWNER", "ADMIN"] }, status: "ACTIVE", user: { isNot: null } }, select: { user: { select: { email: true } } } });
  for (const o of owners) {
    if (o.user?.email) await sendMail({ to: o.user.email, subject: `Aperture: ${subject}`, text, html: `<p>${text}</p>` }).catch(() => false);
  }
}

export async function isPaused(orgId: string): Promise<boolean> {
  const h = await prisma.customerHealth.findUnique({ where: { organizationId: orgId }, select: { status: true } });
  return h?.status === "PAUSED";
}

/**
 * Lifts a pause. Allowed for an operator, or for the customer once their queued list has been sent back for
 * verification. Who did it and why is recorded. The rate window restarts from now.
 */
export async function unpause(orgId: string, by: { userId: string; reason: string; operator: boolean }, now = new Date()) {
  const row = await prisma.customerHealth.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId, status: "OK", unpausedAt: now, unpausedById: by.userId, unpauseReason: by.reason },
    update: { status: "OK", windowSends: 0, windowBounces: 0, bounceRate: 0, unpausedAt: now, unpausedById: by.userId, unpauseReason: by.reason },
  });
  await logSystem(orgId, "INFO", "sending", `${by.operator ? "An operator" : "You"} restarted new emails: ${by.reason}.`, { userId: by.userId, operator: by.operator });
  return row;
}

/**
 * The customer's way back from a pause: every queued person is sent back through verification before any new
 * email, then sending restarts.
 */
export async function reverifyAndUnpause(orgId: string, userId: string) {
  const r = await prisma.contact.updateMany({
    where: { organizationId: orgId, status: { in: ["NEW", "PERSONALIZED", "QUEUED"] }, assignedMailboxId: null },
    data: { verifiedAt: null, verifyResult: null },
  });
  await unpause(orgId, { userId, reason: `list re-verified (${r.count} people will be checked again before sending)`, operator: false });
  return { requeued: r.count };
}
