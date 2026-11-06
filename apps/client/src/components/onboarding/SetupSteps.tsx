"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button, Notice } from "@/components/ui/primitives";
import type { Catalogue, CreditsPanel, MarketView, VolumeOptions, VolumeStop } from "@/lib/types";
import { budgetOf, dollarsOf, n0 } from "@/lib/format";
import { monthsTxt, usd, WORK_DAYS } from "./sizing";
import { StripeCardCheckout, TopupPay, type PayHandle } from "./Payment";
import { TopupChooser } from "@/components/billing/DailyBudget";
import { api, useCreditsQuery } from "@/store/api";
import { useAppDispatch } from "@/store";
import { StepCta } from "./StepCta";

/**
 * What the customer decides during setup. There are no domains, inboxes, sender names or plans to choose: sending
 * runs on a shared, managed pool whose mailboxes sign with their own names. The customer picks emails a day and pays
 * one flat price per email; a card unlocks the free credit.
 */
export interface Draft {
  /** Emails a day. Stored as the daily budget (emails x $0.04); the dashboard edits it in dollars. */
  emails: number;
  set: boolean;
}

interface Common {
  draft: Draft;
  cat: Catalogue;
  patch: (p: Partial<Draft>) => void;
  domain: string;
}

/** New people a day an email volume carries: each person gets four emails, so a quarter of it. */
export const people = (emails: number) => (emails > 0 ? Math.max(1, Math.floor(emails / 4)) : 0);

/** The stop the server priced for this many emails. */
export const stopFor = (stops: VolumeStop[], emails: number) => stops.find((x) => x.emails === emails) ?? null;

function NeedLine({ stop, pool }: { stop: VolumeStop; pool: number | null }) {
  const ppm = stop.people * WORK_DAYS;
  return (
    <>
      At <b>{stop.perDay} a day</b> you reach about <b>{n0(ppm)} new people a month</b>. Each gets a first email and three follow-ups over two weeks
      {pool && ppm ? (
        <>
          , so your market lasts <b>{monthsTxt(pool / ppm).toLowerCase()}</b>
        </>
      ) : null}
      .
    </>
  );
}

/** Step 5. The daily budget is the question and the big number: a ceiling, like an ads budget. Emails are the small line. */
export function VolumeStep({ draft, cat, patch, market, volume }: Common & { market: MarketView | undefined; volume: VolumeOptions | undefined }) {
  if (!volume) return <div className="ob-body" aria-busy="true" style={{ minHeight: 280 }} />;
  const v = Math.min(volume.max, Math.max(volume.min, draft.emails));
  const stop = stopFor(volume.stops, v);
  const pool = market?.verified ?? market?.people ?? null;
  const set = (x: number) => patch({ emails: x, set: true });
  const pct = volume.max > volume.min ? ((v - volume.min) / (volume.max - volume.min)) * 100 : 100;
  const disabled = volume.presets.filter((p) => p.disabled);
  // Prices as the server quoted them; the flat $0.04 only if a stop is missing.
  const m = (e: number) => stopFor(volume.stops, e)?.perDay ?? budgetOf(e);
  const trial = Number(cat.pricing.freeTrial.amount.replace(/[$,]/g, ""));
  const trialDays = trial > 0 ? Math.floor(trial / dollarsOf(v)) : 0;
  return (
    <>
      <header className="ob-head">
      <h2 className="ob-h">Set your daily budget</h2>
      <p className="ob-p">
        The most we spend in a day. <b>{cat.pricing.perEmail}</b> an email, including finding the person, verifying the address and writing every message. Replies to your leads are always free. Change it any time from your dashboard.
      </p>
      <StepCta />
      </header>
      <div className="ob-body">
        <div className="vol glass">
          <label htmlFor="obRange" className="sr">
            Daily budget
          </label>
          <div className="vol-num">
            <output className="num">{m(v)}</output>
            <span>a day, at most</span>
          </div>
          <input
            id="obRange"
            className="range"
            type="range"
            min={volume.min}
            max={volume.max}
            step={volume.step}
            value={v}
            aria-valuetext={`${m(v)} a day`}
            onChange={(e) => set(+e.target.value)}
            style={{ ["--p" as string]: `${pct}%` }}
          />
          <div className="ticks">
            <span>{m(volume.min)}</span>
            <span>{m(volume.max)}</span>
          </div>
          <div className="presets">
            {volume.presets.map((p) => (
              <button key={p.emails} className="pill-btn" type="button" disabled={p.disabled} aria-pressed={!p.disabled && p.emails === v} title={p.reason ?? undefined} onClick={() => set(p.emails)}>
                {m(p.emails)}
                {p.emails === volume.recommended ? " · recommended" : ""}
              </button>
            ))}
          </div>
          {disabled.length ? (
            <p className="vol-cap">
              {disabled.map((p) => m(p.emails)).join(" and ")} a day: {disabled[0].reason}.
            </p>
          ) : null}
          <p className="vol-cost">
            Up to <b>{n0(v)} emails a day</b> · {n0(Math.max(1, Math.ceil(v * 0.2)))}–{n0(Math.max(1, Math.floor(v * 0.5)))} new people a day, follow-ups first
            {trialDays ? ` · your ${cat.pricing.freeTrial.amount.replace(/\.00$/, "")} free credit covers about ${trialDays === 1 ? "1 day" : `${trialDays} days`}` : ""}
          </p>
        </div>
        {stop ? (
          <div className="need glass">
            <span className="ic">
              <Icon id="st-gauge" />
            </span>
            <div>
              <NeedLine stop={stop} pool={pool} />
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * Step 6. One path: add a card, the free credit lands, nothing is charged. Once the workspace has its card, the step
 * shows the billing and lets the customer add credit (optional). "Skip for now" is a small link for someone who can't
 * add a card at this moment.
 */
export function CardStep({
  cat,
  draft,
  credits,
  funded,
  orgId,
  awaiting,
  cancelled,
  register,
  onBusy,
  onSkip,
  skipBusy,
}: Common & {
  credits: CreditsPanel | undefined;
  funded: boolean;
  orgId: string;
  awaiting: boolean;
  /** Back from Stripe's page without saving a card. */
  cancelled: boolean;
  register: (h: PayHandle | null) => void;
  onBusy: (b: boolean) => void;
  onSkip: () => void;
  skipBusy: boolean;
}) {
  if (funded) return <FundedStep cat={cat} credits={credits} orgId={orgId} emails={draft.emails} />;
  return (
    <>
      <header className="ob-head">
      <h2 className="ob-h">Add your card</h2>
      <p className="ob-p">
        Add a card on Stripe&apos;s secure page and we&apos;ll put <b>{cat.pricing.freeTrial.amount}</b> of free credit in your balance, about {n0(cat.pricing.freeTrial.emails)} emails. Nothing is charged today.
      </p>
      <StepCta />
      </header>
      <div className="ob-body">
        {awaiting ? (
          <Notice tone="info" icon="card" title="Card added">
            Adding your free credit. This usually takes a few seconds and the page moves on by itself.
          </Notice>
        ) : null}
        {awaiting ? null : <StripeCardCheckout register={register} onBusy={onBusy} cancelled={cancelled} credit={cat.pricing.freeTrial.amount} />}
        <p className="skip-card">
          Can&apos;t add a card right now?{" "}
          <button type="button" className="linkish" onClick={onSkip} disabled={skipBusy || awaiting}>
            Skip for now
          </button>
        </p>
      </div>
    </>
  );
}

/**
 * Step 6 once this workspace has its card and credit: what is on file, what the balance covers at the volume just
 * chosen, and adding credit right here (optional) with the same top-up cards as the Credits page.
 */
function FundedStep({ cat, credits, orgId, emails }: { cat: Catalogue; credits: CreditsPanel | undefined; orgId: string; emails: number }) {
  const dispatch = useAppDispatch();
  const [amount, setAmount] = useState("");
  const [awaiting, setAwaiting] = useState(false);
  const before = useRef<string | null>(null);
  const { data: live } = useCreditsQuery(undefined, { pollingInterval: awaiting ? 2500 : 0 });
  const c = live ?? credits;
  // One balance everywhere: when it moves, the rail, step 7 and the app read it again.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!c) return;
    if (shown.current !== null && shown.current !== c.balanceDeciCents) dispatch(api.util.invalidateTags(["Onboarding", "Credits", "Nav", "Cockpit"]));
    shown.current = c.balanceDeciCents;
    if (!awaiting) before.current = c.balanceDeciCents;
    else if (before.current !== null && BigInt(c.balanceDeciCents) > BigInt(before.current)) {
      setAwaiting(false);
      setAmount("");
    }
  }, [awaiting, c, dispatch]);
  useEffect(() => {
    if (credits && live && credits.balanceDeciCents !== live.balanceDeciCents) dispatch(api.util.invalidateTags(["Onboarding"]));
  }, [credits, live, dispatch]);
  const stop = cat.volume.stops.find((x) => x.emails === emails) ?? null;
  const budget = stop?.perDayDeciCents ?? cat.budget.defaultDeciCents;
  return (
    <>
      <header className="ob-head">
      <h2 className="ob-h">Your billing is ready</h2>
      <p className="ob-p">You pay {cat.pricing.perEmail} for each email sent, from your balance. Add more credit now if you like, or any time from Credits in the app.</p>
      <StepCta />
      </header>
      <div className="ob-body">
        <div className="lp-stats bill">
          <div>
            <small>Card</small>
            <b>{c?.card ? `${c.card.brand} ${c.card.last4}` : c?.hasCard ? "Saved" : "None saved"}</b>
            <span>{c?.hasCard ? "Charged only when you add credit" : "Credit was added without a card"}</span>
          </div>
          <div>
            <small>Balance</small>
            <b>{c?.balance ?? cat.pricing.freeTrial.amount}</b>
            <span>about {n0(c?.emailsLeft ?? cat.pricing.freeTrial.emails)} emails{c?.lasts ? `, ${c.lasts}` : ""}</span>
          </div>
          <div>
            <small>Daily budget</small>
            <b>{stop ? stop.perDay : usd(budget)}</b>
            <span>up to {n0(emails)} emails a day, replies free</span>
          </div>
        </div>
        {awaiting ? (
          <Notice tone="info" icon="card" title="Payment submitted">
            Waiting for Stripe to confirm it. Your balance updates here by itself, usually within a few seconds.
          </Notice>
        ) : null}
        <h3 className="bill-h">
          Add credit <span className="fs-tag">Optional</span>
        </h3>
        <TopupChooser cat={cat} budget={budget} amount={amount} onAmount={setAmount} />
        {amount && !awaiting ? <TopupPay orgId={orgId} amount={amount} card={c?.card ?? null} onPaid={() => setAwaiting(true)} returnPath="/onboarding?paid=1" /> : null}
      </div>
    </>
  );
}
