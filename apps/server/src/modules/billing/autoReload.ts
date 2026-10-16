import type Stripe from "stripe";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import { balanceOf, customerOf, setAfterDebit } from "../../domain/credits/index.js";
import { formatUsd, toStripeCents, type DeciCents } from "../../domain/money.js";
import { notifyOwners } from "../../domain/sending/health.js";
import { logSystem } from "../../domain/systemLog.js";
import { getStripe } from "./stripe.client.js";
import { onTopupSucceeded } from "./webhook.service.js";

/**
 * Auto-reload: the one place a card is charged without the customer pressing a button.
 *
 *   off by default      a customer who never switches it on can never be charged off-session
 *   a mandate           switching it on records the exact sentence they agreed to, with when, who and from where
 *   when on             one charge of the chosen amount once the balance drops below the threshold
 *   at most once a day  the slot is claimed before the card is touched, and Stripe's idempotency key is dated
 *   queued              a debit only enqueues a check; the send pipeline never waits on a card
 *   a failure           switches it off with the reason, emails the customer, and is never retried
 *   authentication      (3-D Secure) is not a decline: the customer gets a link to approve the payment
 *   every charge        is emailed
 */
const DAY = 86_400_000;

/** The sentence shown next to the switch and stored, verbatim, as the mandate. */
export function mandateText(threshold: DeciCents, amount: DeciCents): string {
  return `When my balance drops below ${formatUsd(threshold).replace(/\.00$/, "")}, charge my saved card ${formatUsd(amount).replace(/\.00$/, "")}. At most one charge a day. I can turn this off at any time.`;
}

const appUrl = () => env.WEB_ORIGIN.split(",")[0].trim().replace(/\/$/, "");

/**
 * Switches auto-reload off and records why. Returns true only for the call that actually switched it off, so the
 * customer is told once even when the job and a webhook both notice.
 */
export async function disableAutoReload(payer: string, reason: string, now = new Date()): Promise<boolean> {
  const r = await prisma.orgSettings.updateMany({
    where: { organizationId: payer, autoReloadEnabled: true },
    data: { autoReloadEnabled: false, autoReloadDisabledAt: now, autoReloadDisabledReason: reason.slice(0, 300) },
  });
  if (r.count) await logSystem(payer, "WARN", "billing", `Auto-reload was switched off: ${reason}.`);
  return r.count > 0;
}

async function failed(payer: string, amount: DeciCents, why: string) {
  if (await disableAutoReload(payer, why)) {
    await notifyOwners(
      payer,
      "Auto-reload failed and is now off",
      `We tried to add ${formatUsd(amount)} to your Aperture balance and your card was not charged (${why}). Auto-reload is now off and will not try again. Sending carries on until the balance runs out; top up from Credits whenever you like: ${appUrl()}/app/billing/credits`,
    );
  }
  return { charged: false, reason: why };
}

/** The bank wants the customer to approve this payment. Not a decline: they get a link to confirm it. */
export async function authenticationNeeded(payer: string, amount: DeciCents, paymentIntentId: string | null | undefined) {
  if (await disableAutoReload(payer, "the card needs authentication")) {
    const link = paymentIntentId ? `${appUrl()}/app/billing/credits?confirm=${paymentIntentId}` : `${appUrl()}/app/billing/credits`;
    await notifyOwners(
      payer,
      "Please approve your auto-reload payment",
      `Your bank asked you to approve the ${formatUsd(amount)} auto-reload before it can go through, so nothing has been charged yet. Approve it here: ${link}. Auto-reload stays off until you switch it back on.`,
    );
  }
  return { charged: false, reason: "the card needs authentication" };
}

export async function maybeAutoReload(orgId: string, now = new Date()): Promise<{ charged: boolean; reason?: string }> {
  const payer = await customerOf(orgId);
  const s = await prisma.orgSettings.findUnique({ where: { organizationId: payer } });
  // No switch, no mandate, no numbers: no charge. This is the only path to off_session in the codebase.
  if (!s?.autoReloadEnabled || !s.autoReloadMandateAcceptedAt || !s.autoReloadThresholdDecicents || !s.autoReloadAmountDecicents) return { charged: false, reason: "off" };
  if ((await balanceOf(payer)) >= s.autoReloadThresholdDecicents) return { charged: false, reason: "above threshold" };

  // Claim today's one charge first. If another run (or a retry) got here in the last 24 hours, nothing happens.
  const claimed = await prisma.orgSettings.updateMany({
    where: { organizationId: payer, autoReloadEnabled: true, OR: [{ autoReloadLastAt: null }, { autoReloadLastAt: { lt: new Date(now.getTime() - DAY) } }] },
    data: { autoReloadLastAt: now },
  });
  if (!claimed.count) return { charged: false, reason: "already charged in the last 24 hours" };

  const amount = s.autoReloadAmountDecicents;
  const stripe = getStripe();
  const org = await prisma.organization.findUnique({ where: { id: payer }, select: { stripeCustomerId: true } });
  if (!stripe || !org?.stripeCustomerId) return failed(payer, amount, "no saved card");
  let pi: Stripe.PaymentIntent;
  try {
    const pms = await stripe.paymentMethods.list({ customer: org.stripeCustomerId, limit: 1 });
    const pm = pms.data[0];
    if (!pm) return failed(payer, amount, "no saved card");
    pi = await stripe.paymentIntents.create(
      {
        amount: toStripeCents(amount),
        currency: "usd",
        customer: org.stripeCustomerId,
        payment_method: pm.id,
        off_session: true,
        confirm: true,
        description: `Aperture credits ${formatUsd(amount)} (auto-reload)`,
        metadata: { organizationId: payer, kind: "topup", source: "auto_reload", deciCents: amount.toString() },
      },
      // Dated, so Stripe itself allows one auto-reload a day; tied to the mandate, so switching it back on after a
      // failure is a new request rather than a replay of the failed one.
      { idempotencyKey: `autoreload:${payer}:${now.toISOString().slice(0, 10)}:${s.autoReloadMandateAcceptedAt.getTime()}` },
    );
  } catch (e) {
    const err = e as { code?: string; message?: string; payment_intent?: { id?: string } };
    logger.warn({ payer, code: err.code, err: err.message }, "auto-reload charge failed");
    if (err.code === "authentication_required") return authenticationNeeded(payer, amount, err.payment_intent?.id);
    return failed(payer, amount, err.message || "the card was declined");
  }
  if (pi.status === "requires_action") return authenticationNeeded(payer, amount, pi.id);
  if (pi.status !== "succeeded" && pi.status !== "processing") return failed(payer, amount, `payment ${pi.status}`);
  if (pi.status === "succeeded") await onTopupSucceeded(pi);
  await notifyOwners(
    payer,
    `${formatUsd(amount)} added to your balance`,
    `Auto-reload added ${formatUsd(amount)} to your Aperture balance because it dropped below ${formatUsd(s.autoReloadThresholdDecicents)}. Switch it off any time on the Credits page: ${appUrl()}/app/billing/credits. Stripe emails the receipt.`,
  );
  await logSystem(payer, "INFO", "billing", `Auto-reload charged ${formatUsd(amount)}.`);
  return { charged: true };
}

/** Workspaces with a check already queued: one at a time each, so two sends can never both start a reload. */
const queued = new Set<string>();

/**
 * Called after a debit commits. Only enqueues: the check and any charge run on their own, after the send has
 * finished, so a send never waits on a card.
 */
export function queueAutoReload(payer: string): void {
  if (queued.has(payer)) return;
  queued.add(payer);
  setImmediate(() => {
    prisma.orgSettings
      .findUnique({ where: { organizationId: payer }, select: { autoReloadEnabled: true } })
      .then((s) => (s?.autoReloadEnabled ? maybeAutoReload(payer) : null))
      .catch((err) => logger.error({ payer, err: (err as Error).message }, "auto-reload check failed"))
      .finally(() => queued.delete(payer));
  });
}

setAfterDebit(queueAutoReload);

/** The scheduled safety net: every workspace with auto-reload on, checked every ten minutes. */
export async function runAutoReload(): Promise<{ checked: number; charged: number }> {
  const on = await prisma.orgSettings.findMany({ where: { autoReloadEnabled: true }, select: { organizationId: true } });
  let charged = 0;
  for (const o of on) {
    try {
      if ((await maybeAutoReload(o.organizationId)).charged) charged++;
    } catch (e) {
      logger.error({ org: o.organizationId, err: (e as Error).message }, "auto-reload check failed");
    }
  }
  return { checked: on.length, charged };
}
