"use client";

import { Select } from "@/components/ui/Select";
import { useEffect, useState } from "react";
import { Notice, Switch } from "@/components/ui/primitives";
import { useToast } from "@/store";
import { errorMessage, useBillingConfigQuery, useSettingsQuery, useStartSetupMutation, useTopupOptionsQuery, useUpdateSettingsMutation } from "@/store/api";
import { confirmOffSessionConsent } from "@/components/onboarding/Payment";
import type { Catalogue } from "@/lib/types";
import { dateLong } from "@/lib/format";
import { toDc, usd } from "@/components/onboarding/sizing";

/** Thresholds offered, in days of the daily budget. Two days is the default. */
const THRESHOLD_DAYS = [1, 2, 3, 5];

/**
 * Auto-reload. Off by default. When on, the saved card is charged the chosen amount once when the balance drops
 * below the threshold, at most once in 24 hours. A failed charge switches it off and emails the customer; it is
 * never retried. Every charge is emailed. Switching it on records the sentence shown here as the customer's mandate.
 */

/** The same sentence the server records as the mandate. */
const mandate = (threshold: string, amount: string) =>
  `When my balance drops below ${usd(threshold)}, charge my saved card ${usd(amount)}. At most one charge a day. I can turn this off at any time.`;

export function AutoReload({ cat, budget, hasCard, lastTopup }: { cat: Pick<Catalogue, "pricing">; budget: string; hasCard: boolean; lastTopup: string | null }) {
  const { data } = useSettingsQuery();
  const [save, saving] = useUpdateSettingsMutation();
  const [startSetup] = useStartSetupMutation();
  const { data: cfg } = useBillingConfigQuery();
  const [consenting, setConsenting] = useState(false);
  const toast = useToast();
  const s = data?.settings;
  const { data: opts } = useTopupOptionsQuery({ budget });
  const cards = opts?.options ?? [];
  const b = toDc(budget);
  const thresholds = THRESHOLD_DAYS.map((d) => ({ d, amount: (b * BigInt(d)).toString() }));
  const defaultThreshold = thresholds.find((t) => t.d === 2)?.amount ?? "";
  const recommended = (cards.find((c) => c.recommended) ?? cards[0])?.deciCents ?? "";
  const defaultAmount = lastTopup && toDc(lastTopup) >= toDc(cat.pricing.minTopupDeciCents) && toDc(lastTopup) % 1000n === 0n ? lastTopup : recommended;

  const [threshold, setThreshold] = useState(defaultThreshold);
  const [amount, setAmount] = useState(defaultAmount);
  useEffect(() => {
    if (!s) return;
    setThreshold(s.autoReloadThresholdDecicents ?? defaultThreshold);
    setAmount(s.autoReloadAmountDecicents ?? defaultAmount);
    // Defaults follow the budget and the last top-up until the customer saves their own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.autoReloadThresholdDecicents, s?.autoReloadAmountDecicents, defaultThreshold, defaultAmount]);

  if (!s) return null;
  const on = s.autoReloadEnabled;
  const amountOptions = [...new Set([amount, ...cards.map((c) => c.deciCents)])].filter(Boolean).sort((x, y) => (toDc(x) < toDc(y) ? -1 : 1));
  const thresholdOptions = [...new Set([threshold, ...thresholds.map((t) => t.amount)])].filter((x) => toDc(x) > 0n).sort((x, y) => (toDc(x) < toDc(y) ? -1 : 1));
  const daysOf = (dc: string) => (b > 0n ? Number(toDc(dc) / b) : null);

  const apply = (patch: { autoReloadEnabled?: boolean; autoReloadThresholdDecicents?: string; autoReloadAmountDecicents?: string; autoReloadSetupIntentId?: string }, msg: string) =>
    save(patch)
      .unwrap()
      .then(() => toast(msg, "good"))
      .catch((e) => toast(errorMessage(e), "bad"));

  // Switching on asks the card's own consent to charges while the customer is away (the card added at setup only
  // allows charges they make themselves). The bank may ask to approve it; then the setting is saved with it.
  const switchOn = async () => {
    if (!cfg?.publishableKey) return toast("Payments are not set up on this server.", "bad");
    setConsenting(true);
    try {
      const si = await startSetup({ purpose: "auto_reload", idempotencyKey: `reload-${crypto.randomUUID()}` }).unwrap();
      const id = await confirmOffSessionConsent(cfg.publishableKey, si.clientSecret, si.paymentMethodId);
      await apply({ autoReloadEnabled: true, autoReloadSetupIntentId: id, autoReloadThresholdDecicents: threshold, autoReloadAmountDecicents: amount }, `Auto-reload is on: ${usd(amount)} when your balance drops below ${usd(threshold)}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : errorMessage(e), "bad");
    } finally {
      setConsenting(false);
    }
  };

  return (
    <div className="panel glass autoreload">
      <div className="ar-head">
        <div>
          <b>Top up automatically</b>
          <p className="muted">Off by default. Turn it off any time. We never charge more than this, and never when it is switched off.</p>
        </div>
        <Switch
          label="Auto-reload"
          checked={on}
          disabled={saving.isLoading || consenting || (!on && (!hasCard || !amount))}
          onChange={(v) => (v ? void switchOn() : apply({ autoReloadEnabled: false }, "Auto-reload is off."))}
        />
      </div>
      {s.autoReloadDisabledAt && !on ? (
        <Notice tone="warn" icon="card" title="We switched auto-reload off">
          On {dateLong(s.autoReloadDisabledAt)}: {s.autoReloadDisabledReason ?? "it could not charge your card"}. Nothing was retried. Switch it back on when you&apos;re ready.
        </Notice>
      ) : null}
      {!hasCard && !on ? <p className="muted ar-note">Add your card first. Auto-reload charges the card you saved.</p> : null}
      <div className="ar-fields">
        <label>
          <span>When my balance drops below</span>
          <Select
            className="input"
            value={threshold}
            disabled={saving.isLoading}
            onChange={(e) => {
              setThreshold(e.target.value);
              if (on) apply({ autoReloadThresholdDecicents: e.target.value }, "Auto-reload updated.");
            }}
          >
            {thresholdOptions.map((t) => {
              const d = daysOf(t);
              return (
                <option key={t} value={t}>
                  {usd(t)}
                  {d ? ` (about ${d} day${d === 1 ? "" : "s"} of budget)` : ""}
                </option>
              );
            })}
          </Select>
        </label>
        <label>
          <span>Add</span>
          <Select
            className="input"
            value={amount}
            disabled={saving.isLoading}
            onChange={(e) => {
              setAmount(e.target.value);
              if (on) apply({ autoReloadAmountDecicents: e.target.value }, "Auto-reload updated.");
            }}
          >
            {amountOptions.map((a) => {
              const card = cards.find((c) => c.deciCents === a);
              return (
                <option key={a} value={a}>
                  {usd(a)}
                  {card ? ` (${card.label})` : ""}
                </option>
              );
            })}
          </Select>
        </label>
      </div>
      {threshold && amount ? (
        <p className="ar-mandate">
          {on ? "You agreed: " : "By switching it on you agree: "}
          <q>{on && s.autoReloadMandateText ? s.autoReloadMandateText : mandate(threshold, amount)}</q>
          {on && s.autoReloadMandateAcceptedAt ? <span className="muted"> ({dateLong(s.autoReloadMandateAcceptedAt)})</span> : null}
        </p>
      ) : null}
      <p className="muted ar-note">Every charge is emailed to you. If a charge fails, or your bank asks you to approve it, auto-reload switches off and we tell you.</p>
    </div>
  );
}
