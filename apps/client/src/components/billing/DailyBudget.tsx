"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import { useRole, useToast } from "@/store";
import { errorMessage, useBudgetCardQuery, usePlansQuery, useTopupOptionsQuery, useUpdateSettingsMutation } from "@/store/api";
import type { Catalogue } from "@/lib/types";
import { n0 } from "@/lib/format";
import { parseDollars, presets, toDc, usd } from "@/components/onboarding/sizing";

const DOLLAR = 1000n;
const MAX_TOPUP = 10_000_000n;

/**
 * The daily budget in dollars: a $4 to $200 slider in whole dollars, with the server's presets. Emails a day and
 * new people a day are shown as what the budget buys, never as inputs.
 */
export function BudgetRange({
  cat,
  value,
  onChange,
  onCommit,
  recommended,
  disabled,
  id = "budgetRange",
}: {
  cat: Pick<Catalogue, "budget" | "pricing">;
  value: string;
  onChange: (deciCents: string) => void;
  onCommit?: (deciCents: string) => void;
  recommended?: string | null;
  disabled?: boolean;
  id?: string;
}) {
  const min = Number(toDc(cat.budget.minDeciCents) / DOLLAR);
  const max = Number(toDc(cat.budget.maxDeciCents) / DOLLAR);
  const dollars = Math.min(max, Math.max(min, Number(toDc(value) / DOLLAR)));
  const pct = ((dollars - min) / (max - min)) * 100;
  const pick = (dc: string) => {
    onChange(dc);
    onCommit?.(dc);
  };
  return (
    <>
      <input
        id={id}
        className="range"
        type="range"
        min={min}
        max={max}
        step={1}
        value={dollars}
        disabled={disabled}
        aria-valuetext={`${usd(BigInt(dollars) * DOLLAR)} a day`}
        onChange={(e) => onChange((BigInt(+e.target.value) * DOLLAR).toString())}
        onPointerUp={(e) => onCommit?.((BigInt(+(e.target as HTMLInputElement).value) * DOLLAR).toString())}
        onKeyUp={(e) => onCommit?.((BigInt(+(e.target as HTMLInputElement).value) * DOLLAR).toString())}
        style={{ ["--p" as string]: `${pct}%` }}
      />
      <div className="ticks">
        <span>${min}</span>
        <span>$50</span>
        <span>$100</span>
        <span>${max}</span>
      </div>
      <div className="presets">
        {presets(cat).map((p) => (
          <button key={p.toString()} className="pill-btn" type="button" disabled={disabled} aria-pressed={p.toString() === value} onClick={() => pick(p.toString())}>
            {usd(p)}/day{p.toString() === recommended ? " · recommended" : ""}
          </button>
        ))}
      </div>
    </>
  );
}

/** "500 emails a day · 125 new people a day" for a budget, as the server priced it. */
export function budgetBuys(budget: string, cat: Pick<Catalogue, "budget">) {
  const stop = cat.budget.stops.find((x) => x.deciCents === budget);
  return stop ? `${n0(stop.emails)} emails a day · ${n0(stop.people)} new people a day` : "";
}

/**
 * Top-up cards sized to the daily budget (3 days, 1 week, 2 weeks, 1 month), plus any other amount in whole dollars.
 * The amounts, labels and email counts come from the server; the client never does money arithmetic.
 */
export function TopupChooser({ cat, budget, amount, onAmount }: { cat: Pick<Catalogue, "pricing">; budget: string; amount: string; onAmount: (deciCents: string) => void }) {
  const { data, isLoading } = useTopupOptionsQuery({ budget });
  const cards = data?.options ?? [];
  const onCard = cards.some((c) => c.deciCents === amount);
  const [custom, setCustom] = useState(() => (amount && !onCard && cards.length ? usd(amount).replace("$", "") : ""));
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const min = toDc(cat.pricing.minTopupDeciCents);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const typed = (v: string) => {
    setCustom(v);
    if (timer.current) clearTimeout(timer.current);
    if (!v.trim()) {
      setErr("");
      return;
    }
    const dc = parseDollars(v);
    // A hint only; the server is the authority on what it accepts.
    if (dc === null || dc % DOLLAR !== 0n) setErr("Enter whole dollars, like 60.");
    else if (dc < min) setErr(`The smallest top-up is ${usd(min)}.`);
    else if (dc > MAX_TOPUP) setErr(`For more than ${usd(MAX_TOPUP)}, contact us.`);
    else {
      setErr("");
      // A payment starts for the amount, so wait until the customer stops typing.
      timer.current = setTimeout(() => onAmount(dc.toString()), 700);
    }
  };
  if (isLoading && !data) return <div className="plans topups skel" aria-busy="true" style={{ minHeight: 112 }} />;
  return (
    <>
      {data ? <p className="tp-lead">{data.lead}</p> : null}
      <div className="plans topups" role="radiogroup" aria-label="Top-up amount">
        {cards.map((c) => (
          <button
            key={c.deciCents}
            type="button"
            role="radio"
            className="plan"
            aria-checked={c.deciCents === amount}
            aria-pressed={c.deciCents === amount}
            onClick={() => {
              if (timer.current) clearTimeout(timer.current);
              setCustom("");
              setErr("");
              onAmount(c.deciCents);
            }}
          >
            <span className="ck">
              <Icon id="check" />
            </span>
            <div className="pn">
              {c.label}
              {c.recommended ? <span className="tp-star"> · recommended</span> : null}
            </div>
            <div className="pp">{c.amount}</div>
            <div className="pv">{n0(c.emails)} emails</div>
          </button>
        ))}
      </div>
      {data ? (
        <p className="tp-bal">
          You have {data.balance} left{data.balanceLasts ? `, ${data.balanceLasts}` : ""}.
        </p>
      ) : null}
      <div className="topup-other">
        <label htmlFor="topupOther">Or enter another amount</label>
        <div className="topup-other-in">
          <span aria-hidden="true">$</span>
          <input id="topupOther" className="input" inputMode="numeric" placeholder={usd(min).replace("$", "")} value={custom} onChange={(e) => typed(e.target.value)} aria-invalid={!!err} aria-describedby="topupOtherHint" />
        </div>
        <small id="topupOtherHint" className={err ? "bad" : "muted"} role={err ? "alert" : undefined}>
          {err || `Whole dollars, from ${usd(min)}`}
        </small>
      </div>
    </>
  );
}

/** The suggested amount at a budget: the server's recommended (1 week) option. */
export function useDefaultTopup(budget: string | null): string {
  const { data } = useTopupOptionsQuery({ budget: budget ?? undefined }, { skip: !budget });
  return (data?.options.find((o) => o.recommended) ?? data?.options[0])?.deciCents ?? "";
}

export const PRICE_COPY = (cat: Pick<Catalogue, "pricing">) =>
  `Prepaid, so you never get a surprise bill. ${cat.pricing.perEmail} an email, including finding the person, verifying the address and writing every message. If we can't find an address you pay nothing.`;

const todayKey = () => new Date().toISOString().slice(0, 10);
const NUDGE_KEY = "aperture.budgetNudge.dismissed";

function nudgeDismissedToday(): boolean {
  try {
    return window.localStorage.getItem(NUDGE_KEY) === todayKey();
  } catch {
    return false;
  }
}

/**
 * The daily budget, in dollars (the dashboard's unit; setup asked in emails a day). It always shows the stored value:
 * the slider starts from what the customer chose and only a person moving it saves anything.
 *
 *   line     the Cockpit: one summary line, "Sending 500 a day · $20 a day · 09:00–17:00", opening on Change
 *   editor   the Credits page: the slider, presets, pause and today's spend, always open
 */
export function DailyBudget({ mode = "editor", window: sendWindow }: { mode?: "line" | "editor"; window?: string }) {
  const { data: card } = useBudgetCardQuery(undefined, { refetchOnMountOrArgChange: true, pollingInterval: 60_000 });
  const { data: cat } = usePlansQuery();
  const [save, saving] = useUpdateSettingsMutation();
  const { canManage } = useRole();
  const toast = useToast();
  const saved = card?.budget ?? null;
  const [value, setValue] = useState<string>("");
  const [open, setOpen] = useState(mode === "editor");
  const [dismissed, setDismissed] = useState(false);
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!cat || !card) return;
    // Bound to the stored budget. Only when there is none (paused at $0, or an admin's no-cap) does the slider rest
    // on the default, and even then nothing is saved until a person moves it.
    setValue(saved && saved !== "0" ? saved : cat.budget.defaultDeciCents);
    last.current = saved;
  }, [saved, cat, card]);
  useEffect(() => setDismissed(nudgeDismissedToday()), []);

  if (!card || !cat) return null;

  const commit = (dc: string, msg?: string) => {
    if (dc === last.current) return;
    last.current = dc;
    save({ dailyBudgetDecicents: dc })
      .unwrap()
      .then(() => toast(msg ?? `Daily budget set to ${usd(dc)}.`, "good"))
      .catch((e) => {
        last.current = saved;
        toast(errorMessage(e), "bad");
      });
  };

  const paused = card.state === "paused";
  const budget = toDc(card.budget);
  const spent = toDc(card.spentToday);
  const pct = budget > 0n ? Math.min(100, Number((spent * 1000n) / budget) / 10) : 0;
  const nudge = card.nudge && !dismissed && canManage ? card.nudge : null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(NUDGE_KEY, todayKey());
    } catch {}
    setDismissed(true);
  };
  const hitAt = nudge?.hitAt ? new Date(nudge.hitAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;
  const summary = paused ? "Sending paused" : card.state === "uncapped" ? `Sending ${n0(card.emailsPerDay)} a day` : `Sending ${n0(card.emailsPerDay)} a day · ${usd(card.budget ?? "0")} a day`;

  const editor = (
    <>
      <div className="bc-head">
        <div>
          <small className="muted">Daily budget</small>
          <b className="bc-amt">{paused ? "Paused" : card.state === "uncapped" ? "No cap" : `${usd(card.budget ?? "0")} a day`}</b>
          <span className="muted bc-buys">{paused ? "No cold email goes out. Replies in your live conversations keep sending." : budgetBuys(value, cat)}</span>
        </div>
        {canManage ? (
          paused ? (
            <Button size="sm" variant="primary" loading={saving.isLoading} onClick={() => commit(value, `Sending resumed at ${usd(value)} a day.`)}>
              Resume at {usd(value)} a day
            </Button>
          ) : (
            <Button size="sm" loading={saving.isLoading} onClick={() => commit("0", "Sending paused. Your balance is untouched.")}>
              Pause
            </Button>
          )
        ) : null}
      </div>
      {canManage ? (
        <div className="bc-range">
          <label htmlFor={`budget-${mode}`} className="sr">
            Daily budget in dollars
          </label>
          <BudgetRange id={`budget-${mode}`} cat={cat} value={value} onChange={setValue} onCommit={paused ? undefined : (dc) => commit(dc)} disabled={saving.isLoading} />
        </div>
      ) : null}
      {!paused && card.state !== "uncapped" ? (
        <div className="bc-today">
          <div className="bc-row">
            <span>
              Today <b>{usd(card.spentToday)}</b> of {usd(card.budget ?? "0")}
            </span>
            <span className="muted">
              {n0(card.sentToday)} sent today · {n0(card.peopleToday)} people reached
            </span>
          </div>
          <div className={`bc-bar${card.state === "reached" ? " full" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Today's spend against the budget">
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <div className={`engine glass budget-card${mode === "line" ? " line" : ""}`}>
      {mode === "line" ? (
        <div className="bc-line">
          <span>
            <b>{summary}</b>
            {sendWindow ? <span className="muted"> · {sendWindow}</span> : null}
          </span>
          {canManage ? (
            <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "Done" : "Change"}
            </button>
          ) : null}
        </div>
      ) : null}
      {open ? editor : null}
      {nudge ? (
        <div className="bc-nudge" role="status">
          <p>
            You reached today&apos;s budget{hitAt ? ` at ${hitAt}` : ""} and <b>{n0(nudge.waiting)} {nudge.waiting === 1 ? "person is" : "people are"} waiting</b>. At {usd(nudge.raiseTo)} a day you would reach about {n0(nudge.morePeoplePerMonth)} more people a month
            {nudge.moreRepliesPerMonth !== null && nudge.replyRate !== null ? (
              <>
                , and at your reply rate of {(nudge.replyRate * 100).toFixed(1)}% that is an estimated {n0(nudge.moreRepliesPerMonth)} more replies
              </>
            ) : null}
            .
          </p>
          <div className="bc-nudge-a">
            <button type="button" className="btn btn-text btn-sm" onClick={dismiss}>
              Not now
            </button>
            <Button size="sm" variant="primary" loading={saving.isLoading} onClick={() => commit(nudge.raiseTo, `Daily budget raised to ${usd(nudge.raiseTo)}.`)}>
              Raise to {usd(nudge.raiseTo)} a day
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
