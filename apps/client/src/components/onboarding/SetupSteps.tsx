"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button, Notice } from "@/components/ui/primitives";
import type { Catalogue, CreditsPanel, MarketView, VolumeOptions, VolumeStop } from "@/lib/types";
import { n0 } from "@/lib/format";
import { monthsTxt, usd, WORK_DAYS } from "./sizing";
import { CardSetupForm, TopupPay, type PayHandle } from "./Payment";
import { TopupChooser } from "@/components/billing/DailyBudget";
import { api, useCreditsQuery } from "@/store/api";
import { useAppDispatch } from "@/store";

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

/** The stop the server priced for this many emails. */
export const stopFor = (stops: VolumeStop[], emails: number) => stops.find((x) => x.emails === emails) ?? null;

function NeedLine({ stop, pool }: { stop: VolumeStop; pool: number | null }) {
  const ppm = stop.people * WORK_DAYS;
  return (
    <>
      At <b>{n0(stop.emails)} emails a day</b> you reach about <b>{n0(ppm)} new people a month</b>, each with a 4-email sequence over two weeks
      {pool && ppm ? (
        <>
          , so your market lasts <b>{monthsTxt(pool / ppm).toLowerCase()}</b>
        </>
      ) : null}
      .
    </>
  );
}

/** Step 5. Emails a day is the question and the big number; what it costs is the small line underneath. */
export function VolumeStep({ draft, cat, patch, market, volume }: Common & { market: MarketView | undefined; volume: VolumeOptions | undefined }) {
  if (!volume) return <div className="ob-body" aria-busy="true" style={{ minHeight: 280 }} />;
  const v = Math.min(volume.max, Math.max(volume.min, draft.emails));
  const stop = stopFor(volume.stops, v);
  const pool = market?.verified ?? market?.people ?? null;
  const set = (x: number) => patch({ emails: x, set: true });
  const pct = volume.max > volume.min ? ((v - volume.min) / (volume.max - volume.min)) * 100 : 100;
  const disabled = volume.presets.filter((p) => p.disabled);
  return (
    <>
      <h2 className="ob-h">How many emails a day?</h2>
      <p className="ob-p">
        <b>{cat.pricing.perEmail}</b> an email, including finding the person, verifying the address and writing every message. If we can&apos;t find an address you pay nothing. Sending, warmup and deliverability are on us. Change this any time from your dashboard.
      </p>
      <div className="ob-body">
        <div className="vol glass">
          <label htmlFor="obRange" className="sr">
            Emails a day
          </label>
          <div className="vol-num">
            <output className="num">{n0(v)}</output>
            <span>emails a day</span>
          </div>
          <input
            id="obRange"
            className="range"
            type="range"
            min={volume.min}
            max={volume.max}
            step={volume.step}
            value={v}
            aria-valuetext={`${n0(v)} emails a day`}
            onChange={(e) => set(+e.target.value)}
            style={{ ["--p" as string]: `${pct}%` }}
          />
          <div className="ticks">
            <span>{n0(volume.min)}</span>
            <span>{n0(volume.max)}</span>
          </div>
          <div className="presets">
            {volume.presets.map((p) => (
              <button key={p.emails} className="pill-btn" type="button" disabled={p.disabled} aria-pressed={!p.disabled && p.emails === v} title={p.reason ?? undefined} onClick={() => set(p.emails)}>
                {n0(p.emails)}
                {p.emails === volume.recommended ? " · recommended" : ""}
              </button>
            ))}
          </div>
          {disabled.length ? (
            <p className="vol-cap">
              {disabled.map((p) => n0(p.emails)).join(" and ")} a day: {disabled[0].reason}.
            </p>
          ) : null}
          {stop ? (
            <p className="vol-cost">
              <b>{stop.perDay} a day</b> · {n0(stop.people)} new people a day · {stop.perMonth} a month
            </p>
          ) : null}
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
  register,
  onSaved,
  onBusy,
  onSkip,
  skipBusy,
}: Common & {
  credits: CreditsPanel | undefined;
  funded: boolean;
  orgId: string;
  awaiting: boolean;
  register: (h: PayHandle | null) => void;
  onSaved: () => void;
  onBusy: (b: boolean) => void;
  onSkip: () => void;
  skipBusy: boolean;
}) {
  if (funded) return <FundedStep cat={cat} credits={credits} orgId={orgId} emails={draft.emails} />;
  return (
    <>
      <h2 className="ob-h">Add your card</h2>
      <p className="ob-p">
        Add a card and we&apos;ll put <b>{cat.pricing.freeTrial.amount}</b> of free credit in your balance, about {n0(cat.pricing.freeTrial.emails)} emails. Nothing is charged today.
      </p>
      <div className="ob-body">
        {awaiting ? (
          <Notice tone="info" icon="card" title="Card added">
            Adding your free credit. This usually takes a few seconds and the page moves on by itself.
          </Notice>
        ) : null}
        <CardSetupForm orgId={orgId} register={register} onSaved={onSaved} onBusy={onBusy} />
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
      <h2 className="ob-h">Your billing is ready</h2>
      <p className="ob-p">You pay {cat.pricing.perEmail} for each email sent, from your balance. Add more credit now if you like, or any time from Credits in the app.</p>
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
            <small>Emails a day</small>
            <b>{n0(emails)}</b>
            <span>{stop ? `${stop.perDay} a day at most` : `${usd(budget)} a day at most`}</span>
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
