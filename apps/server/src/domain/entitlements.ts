import { prisma } from "../lib/prisma.js";
import { insufficientCredits, unprocessable } from "../lib/errors.js";
import { availableOf, balanceOf, customerOf, SEQUENCE_HOLD } from "./credits/index.js";
import { PRICE_PER_EMAIL } from "./money.js";
import { getSettings } from "./settings.js";
import { VOLUME_MAX } from "../config/plans.js";

/** Our own outreach (Marketlytics, skimming.ai, RankHouse) goes through the pool unbilled. */
export async function isInternal(orgId: string): Promise<boolean> {
  return (await prisma.organization.findUnique({ where: { id: orgId }, select: { kind: true } }))?.kind === "INTERNAL";
}

/**
 * What a customer may do, now that there are no plans. A workspace that has ever been funded (a top-up or the free
 * trial) can run the engine; sending itself is gated per email by the balance in the send pipeline.
 */
export async function isFunded(orgId: string): Promise<boolean> {
  if (await isInternal(orgId)) return true;
  const payer = await customerOf(orgId);
  const n = await prisma.creditLedger.count({ where: { organizationId: payer, kind: { in: ["TOPUP", "BONUS"] } } });
  return n > 0;
}

export async function assertFunded(orgId: string): Promise<void> {
  if (!(await isFunded(orgId))) throw insufficientCredits("Add a card to get your free credit and start sending. Nothing is charged.");
}

/**
 * Everything that has to be true before a campaign starts sending, each with its own message: funded (a card added,
 * or credit bought), money left and a daily budget above $0. Pool capacity is the team's to keep ahead of demand
 * (see `reportShortfall`), never a reason to hold a customer back.
 */
export async function assertCanStart(orgId: string): Promise<void> {
  if (await isInternal(orgId)) return;
  await assertFunded(orgId);
  if ((await balanceOf(await customerOf(orgId))) < PRICE_PER_EMAIL) throw insufficientCredits("Your balance is empty. Add credits to start sending.");
  const s = await getSettings(orgId);
  if (s.dailyBudgetDecicents !== null && s.dailyBudgetDecicents <= 0n) throw unprocessable("Your daily budget is $0, which pauses sending. Choose how many emails a day to send first.");
}

/** True when the balance can pay for at least one more person's sequence. */
export async function canStartSequence(orgId: string): Promise<boolean> {
  if (await isInternal(orgId)) return true;
  return (await availableOf(await customerOf(orgId))) >= SEQUENCE_HOLD;
}

/** The most a customer can ask to send a day. There is no plan ceiling below the product maximum. */
export function dailyVolumeLimit(): number {
  return VOLUME_MAX;
}
