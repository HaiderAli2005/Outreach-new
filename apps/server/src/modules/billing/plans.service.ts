import { emailsFor, formatPrice, formatUsd, peopleFor, PRICE_PER_EMAIL, REPLY_RESERVE } from "../../domain/money.js";
import {
  BUDGET_DEFAULT_DECICENTS,
  BUDGET_MAX_DECICENTS,
  BUDGET_MIN_DECICENTS,
  BUDGET_PRESETS_DECICENTS,
  FREE_TRIAL_DECICENTS,
  MIN_TOPUP_DECICENTS,
  SEQUENCE_DAYS,
  SEQUENCE_STEPS,
  TOPUP_DAYS,
  VOLUME_MAX,
  VOLUME_MIN,
  VOLUME_PRESETS,
  VOLUME_STEP,
} from "../../config/plans.js";
import { quotes } from "../../domain/capacity.js";

function budgetStops() {
  const out: { deciCents: string; emails: number; people: number }[] = [];
  for (let d = BUDGET_MIN_DECICENTS; d <= BUDGET_MAX_DECICENTS; d += 1_000n) {
    const emails = emailsFor(d);
    out.push({ deciCents: d.toString(), emails, people: peopleFor(emails) });
  }
  return out;
}

/**
 * The public price list. There are no plans: one price per email sent, paid from a prepaid balance, and one control,
 * the daily budget. Supplier costs (config/internalCosts.ts) are never part of this.
 */
export function catalogue() {
  return {
    pricing: {
      perEmail: formatPrice(PRICE_PER_EMAIL),
      perEmailDeciCents: PRICE_PER_EMAIL.toString(),
      /** Cold email keeps this much for replies in live conversations. */
      replyReserve: formatUsd(REPLY_RESERVE),
      sequenceDays: [...SEQUENCE_DAYS],
      minTopup: formatUsd(MIN_TOPUP_DECICENTS),
      minTopupDeciCents: MIN_TOPUP_DECICENTS.toString(),
      topupDays: [...TOPUP_DAYS],
      freeTrial: { amount: formatUsd(FREE_TRIAL_DECICENTS), emails: emailsFor(FREE_TRIAL_DECICENTS), people: peopleFor(emailsFor(FREE_TRIAL_DECICENTS)) },
      included: ["Finding and verifying each person. If we can't find an address, you pay nothing", "Writing every email", "Reply sorting and drafted answers"],
      ownership: "Your leads are yours. Export them any time.",
    },
    budget: {
      minDeciCents: BUDGET_MIN_DECICENTS.toString(),
      maxDeciCents: BUDGET_MAX_DECICENTS.toString(),
      defaultDeciCents: BUDGET_DEFAULT_DECICENTS.toString(),
      presetsDeciCents: BUDGET_PRESETS_DECICENTS.map((d) => d.toString()),
      // Every whole-dollar stop on the dashboard slider, with what it buys, so the page never works it out.
      stops: budgetStops(),
    },
    /** Emails a day, as asked at setup and on the pricing page, with every stop priced here. */
    volume: { min: VOLUME_MIN, max: VOLUME_MAX, step: VOLUME_STEP, presets: [...VOLUME_PRESETS], stops: quotes(VOLUME_MAX) },
    sizing: { sequenceSteps: SEQUENCE_STEPS },
  };
}
