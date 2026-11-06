"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconId } from "@/components/ui/Icon";
import { Avatar, Button, Chip, ErrorState, Skeleton } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { CampaignsCard, PeriodSelect } from "@/components/app/CampaignsCard";
import { DailyBudget } from "@/components/billing/DailyBudget";
import { TOP_ACTIONS_ID } from "@/components/shell/AppShell";
import { Confirm } from "@/components/ui/overlays";
import { LineChart, MiniChart, TONE } from "@/components/admin/charts";
import { useAppSelector, useRole, useToast } from "@/store";
import { errorMessage, useCockpitQuery, useEngineStartMutation, useEngineStopMutation, useFirstRunMutation, useLeaveOutMutation, usePerformanceQuery } from "@/store/api";
import { REPLY_LABEL, REPLY_TONE, ago, clock, dayName, n0, placeOf, when } from "@/lib/format";
import type { Cockpit, Performance, PerformancePeriod } from "@/lib/types";
import { useBalanceSync } from "@/store/useBalanceSync";

/**
 * The cockpit, read top to bottom: what is happening and the one thing to do next, what needs you, what the
 * money bought (sent, delivered, hot leads, spent) over time and per campaign, then the latest replies and events.
 */

type Tone = "go" | "warm" | "off" | "bad";
const STATE: Record<Cockpit["engine"]["state"], { label: string; tone: Tone; text: string }> = {
  running: { label: "Sending", tone: "go", text: "Finding, writing and sending on schedule." },
  approval: { label: "Waiting for your approval", tone: "warm", text: "Your first people and their emails are ready. Nothing is sent before you approve them." },
  preparing: { label: "Getting ready", tone: "warm", text: "We're finding the right people and writing an email for each one. You don't need to do anything yet." },
  reviewing: { label: "Waiting for your review", tone: "warm", text: "A week of leads is ready for your review before it sends." },
  resting: { label: "Resting", tone: "off", text: "Weekends are quiet. Sending resumes on the next working day." },
  paused: { label: "Paused", tone: "off", text: "Nothing is being sent. Start again whenever you're ready." },
  unpaid: { label: "Waiting for credit", tone: "bad", text: "Everything is paused until you add credits, including replies." },
  reserve: { label: "Cold email paused", tone: "warm", text: "Your live conversations are still running. Add credits to resume cold email." },
  capacity: { label: "Getting ready", tone: "warm", text: "We're getting your sending capacity ready. Your first emails go out as soon as it's live." },
};

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n0(n)} ${n === 1 ? one : many}`;
const dollars = (decicents: number) => `$${(decicents / 1000).toFixed(2)}`;
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A day stamp for events that belong to a whole day (a day's sends), so a 17:00 stamp never reads "just now". */
function dayOf(at: string) {
  const d = new Date(at);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "today";
  if (d.toDateString() === y.toDateString()) return "yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Start or stop outreach, shown in the top bar next to the balance. */
function EngineAction({ c }: { c: Cockpit }) {
  const { canManage } = useRole();
  const toast = useToast();
  const [stop, stopState] = useEngineStopMutation();
  const [start, startState] = useEngineStartMutation();
  const [confirm, setConfirm] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(TOP_ACTIONS_ID)), []);
  if (!canManage || !slot) return null;
  const unfunded = c.credits.stage === "unfunded";
  const action =
    c.engine.state === "unpaid" ? (
      <Link className="btn btn-primary btn-sm" href="/app/billing/credits">
        {unfunded ? "Add your card" : "Add credits"}
      </Link>
    ) : c.engine.on ? (
      <Button size="sm" variant="ghost" icon="power" className="ap-stop" onClick={() => setConfirm(true)}>
        Stop outreach
      </Button>
    ) : (
      <Button
        size="sm"
        variant="primary"
        icon="power"
        loading={startState.isLoading}
        onClick={() =>
          start()
            .unwrap()
            .then(() => toast("Outreach started", "good"))
            .catch((e) => toast(errorMessage(e), "bad"))
        }
      >
        Start outreach
      </Button>
    );
  return createPortal(
    <>
      {action}
      {confirm ? (
        <Confirm
          title="Stop all outreach?"
          danger
          confirmLabel="Stop outreach"
          loading={stopState.isLoading}
          onClose={() => setConfirm(false)}
          onConfirm={() =>
            stop()
              .unwrap()
              .then((r) => {
                setConfirm(false);
                toast(r.stopped ? "Outreach stopped. Nothing new goes out until you start it again." : "Outreach is already stopped.", "good");
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body="“Run every working day” turns off and no new emails or follow-ups go out. Replies still arrive in your inbox."
        />
      ) : null}
    </>,
    slot,
  );
}

/** The one next thing to do, if there is one. Everything else on the page is reading. */
function NextAction({ c, soft }: { c: Cockpit; soft?: boolean }) {
  const { canManage } = useRole();
  const toast = useToast();
  const [retry, retryState] = useFirstRunMutation();
  const fb = c.needsYou.firstBatch;
  const week = c.needsYou.pendingWeeks[0];
  if (c.engine.state === "unpaid" || c.engine.state === "reserve")
    return (
      <Link className="btn btn-primary" href="/app/billing/credits">
        {c.credits.stage === "unfunded" ? "Add your card" : "Add credits"}
      </Link>
    );
  if (fb?.problem && canManage)
    return (
      <Button
        variant="primary"
        icon="rotate"
        loading={retryState.isLoading}
        onClick={() =>
          retry()
            .unwrap()
            .then(() => toast("Searching again", "good"))
            .catch((e) => toast(errorMessage(e), "bad"))
        }
      >
        Search again
      </Button>
    );
  if (c.engine.state === "approval")
    return (
      <Link className="btn btn-primary" href="/app/approve">
        Review and approve
      </Link>
    );
  if (c.engine.state === "reviewing" && week)
    return (
      <Link className={`btn ${soft ? "btn-ghost" : "btn-primary"}`} href={`/app/leads?batch=${week.batchId}`}>
        Review next week&apos;s {plural(week.sendable, "person", "people")}
      </Link>
    );
  return null;
}

type FirstBatch = NonNullable<Cockpit["needsYou"]["firstBatch"]>;

/**
 * Where the first campaign is before anything has been sent. "ready" only once the full first batch is written, or
 * the search has finished with fewer: asking for an approval while people are still being written (1 of 20) made
 * the page say "ready" and "working on it" at the same time.
 */
function firstBatchPhase(fb: FirstBatch): "problem" | "finding" | "ready" {
  if (fb.problem) return "problem";
  return fb.ready > 0 && (fb.ready >= fb.needed || !fb.finding) ? "ready" : "finding";
}

/**
 * The first campaign, from launch to approval, as one card that answers three questions: where is it, how far
 * along, and what do I do now. One headline, one progress bar with the only number that matters (people ready out
 * of the first batch), one button. The four steps underneath show the way to the first email.
 */
function FirstBatchHero({ c, fb }: { c: Cockpit; fb: FirstBatch }) {
  const { canManage } = useRole();
  const toast = useToast();
  const [retry, retryState] = useFirstRunMutation();
  const phase = firstBatchPhase(fb);
  const ready = Math.min(fb.ready, fb.needed);
  const tone: Tone = phase === "problem" ? "bad" : phase === "ready" ? "warm" : "go";
  const title = phase === "problem" ? "The search for your first people stopped" : phase === "ready" ? `Your first ${plural(ready, "person", "people")} ${ready === 1 ? "is" : "are"} ready to check` : `Getting your first ${n0(fb.needed)} people ready`;
  const text =
    phase === "problem" ? fb.problem : phase === "ready" ? "Check who they are and their emails, then approve. Nothing sends before you do." : "Usually a few minutes. We'll email you when they're ready.";
  // What is happening between "found" and "ready", in words, so 882 found and 0 ready never read as a contradiction.
  const status =
    phase === "ready"
      ? fb.ready < fb.needed
        ? `${n0(ready)} of ${n0(fb.needed)} ready · the search is done for now`
        : `${n0(ready)} of ${n0(fb.needed)} ready`
      : fb.found
        ? `${n0(fb.found)} found · checking emails and writing to them`
        : "Searching for people who match";
  return (
    <section className={`cpt-hero is-${tone} is-first`} aria-label="Status">
      <div className="cpt-hero-main">
        <div className="cpt-hero-t">
          <h2 className="cpt-title">{title}</h2>
          <p>{text}</p>
          {phase !== "problem" ? (
            <div className="cpt-progress" role="progressbar" aria-label="People ready" aria-valuemin={0} aria-valuemax={fb.needed} aria-valuenow={ready}>
              <span className="cpt-bar">
                <i style={{ width: `${Math.max(4, (ready / fb.needed) * 100)}%` }} />
              </span>
              <small>{status}</small>
            </div>
          ) : null}
          <div className="cpt-actions">
            {phase === "ready" ? (
              <Link className="btn btn-primary" href="/app/approve">
                Review and approve
              </Link>
            ) : phase === "problem" && canManage ? (
              <Button
                variant="primary"
                icon="rotate"
                loading={retryState.isLoading}
                onClick={() =>
                  retry()
                    .unwrap()
                    .then(() => toast("Searching again", "good"))
                    .catch((e) => toast(errorMessage(e), "bad"))
                }
              >
                Search again
              </Button>
            ) : fb.ready > 0 ? (
              <Link className="btn btn-ghost" href="/app/approve">
                See the {plural(fb.ready, "person", "people")} ready so far
              </Link>
            ) : null}
            <span className="cpt-credit">
              {c.credits.balance} {c.credits.stage === "trial" ? "free credit · nothing charged" : "balance"}
            </span>
          </div>
        </div>
      </div>
      <Milestones steps={stepsOf(c)} />
    </section>
  );
}

type Step = { title: string; text: string; state: "done" | "now" | "you" | "next" | "stop" };

/** Before the first email: the four steps from launch to sending, with real numbers, so waiting never looks like nothing. */
function stepsOf(c: Cockpit): Step[] {
  const p = c.progress;
  const fb = c.needsYou.firstBatch;
  const funded = c.credits.stage !== "unfunded";
  const written = Math.max(p.written, fb?.written ?? 0);
  const found = Math.max(p.found, fb?.found ?? 0);
  const steps: Step[] = [
    {
      title: !funded ? "Add a card" : c.engine.on ? "Launched" : "Sending is switched off",
      text: !funded ? "Add a card to unlock your free credit." : c.engine.on ? `${c.credits.balance} in your balance, about ${plural(c.credits.emailsLeft, "email")}.${c.credits.stage === "trial" ? " Nothing was charged." : ""}` : "Turn on “Run every working day” in Settings, Sending.",
      state: funded && c.engine.on ? "done" : "you",
    },
    {
      title: "Finding people",
      // The card's status line already says how many were found; the step only marks where we are.
      text: fb ? "" : `${n0(found)} found · ${n0(p.verified)} verified · ${plural(written, "email")} written`,
      state: fb?.problem ? "stop" : fb ? (firstBatchPhase(fb) === "ready" ? "done" : "now") : written > 0 ? "done" : "now",
    },
  ];
  if (fb)
    steps.push({
      title: "Your approval",
      text: firstBatchPhase(fb) === "ready" ? `${plural(fb.ready, "person", "people")} to check` : `You check the first ${n0(fb.needed)}`,
      state: firstBatchPhase(fb) === "ready" ? "you" : "next",
    });
  steps.push({
    title: "First emails",
    text: c.engine.state === "capacity" && c.engine.capacityLiveOn ? `When sending capacity goes live on ${c.engine.capacityLiveOn}` : `From ${c.engine.windowStart}, their local time`,
    state: "next",
  });
  return steps;
}

const STEP_LABEL: Record<Step["state"], string> = { done: "Done", now: "Working on it", you: "Needs you", next: "Next", stop: "Stopped" };

/**
 * The way to the first email as one quiet rail: small nodes on a thin line, the current step lit, finished steps a
 * fine check, the rest hollow. The state is carried by the node and one short word, never by a big filled badge.
 */
function Milestones({ steps }: { steps: Step[] }) {
  return (
    <ol className="cpt-rail" aria-label="Steps to your first email">
      {steps.map((st) => (
        <li key={st.title} className={`is-${st.state}`}>
          <span className="node" aria-hidden="true">
            {st.state === "done" ? <Icon id="check" /> : null}
          </span>
          <b>{st.title}</b>
          {st.state === "now" || st.state === "you" || st.state === "stop" ? (
            <>
              {st.text ? <small>{st.text}</small> : null}
              <em>{STEP_LABEL[st.state]}</em>
            </>
          ) : (
            <span className="sr">{st.text}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A greeting and one sentence that sums up the period, so the page answers "how is it going" before any number. */
/** Respects the reader's "reduce motion" setting: no counting, no sliding. */
function prefersStill(): boolean {
  return typeof window === "undefined" || !window.matchMedia || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A number that counts up to its value the first time it is shown ("$1.48", "37", "100%"). Text that is not a number
 * shows as it is. Screen readers get the final value at once.
 */
function CountUp({ text }: { text: string }) {
  const m = /^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/.exec(text);
  const target = m ? Number(m[2].replace(/,/g, "")) : NaN;
  const decimals = m && m[2].includes(".") ? m[2].split(".")[1].length : 0;
  const [shown, setShown] = useState(text);
  const done = useRef(false);
  useEffect(() => {
    if (!m || !Number.isFinite(target) || done.current || prefersStill()) return void setShown(text);
    done.current = true;
    const grouped = m[2].includes(",");
    const fmt = (v: number) => (grouped ? v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : v.toFixed(decimals));
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 1100);
      setShown(`${m[1]}${fmt(target * (1 - Math.pow(1 - p, 3)))}${m[3]}`);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // Counts once per value; a later refresh with the same text keeps it still.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className="sr">{text}</span>
    </>
  );
}

/**
 * One line under the status: how many emails today against the daily amount, in plain words, and the one reason
 * when it is lower. Never a promise of a slow climb: the day fills as soon as people are ready.
 */
function DayLine({ day }: { day: NonNullable<Cockpit["day"]> }) {
  const short = day.planned < day.plan;
  return (
    <p className={`cpt-dayline${short ? " is-short" : ""}`}>
      <b>
        {n0(day.planned)} of {n0(day.plan)} emails today
      </b>
      {!short ? (
        " · your full daily amount is booked."
      ) : day.reason === "approval" ? (
        <>
          {" "}
          · {plural(day.waitingApproval, "person is", "people are")} waiting for you. <Link href="/app/approve">Approve them</Link> to send the rest today.
        </>
      ) : day.reason === "preparing" ? (
        " · the rest are being found, checked and written now, and join today as they're ready."
      ) : day.reason === "nobody" ? (
        <>
          {" "}
          · not enough people match your campaigns. <Link href="/app/campaigns/new">Add a campaign</Link> to reach your full amount.
        </>
      ) : null}
      {day.mailboxLimit && day.chosen ? (
        <span className="cpt-dayline-cap">
          You chose {n0(day.chosen)} a day; your sending mailboxes carry {n0(day.mailboxLimit)} a day right now
          {day.moreMailboxesOn ? `, more from ${day.moreMailboxesOn}` : ", more are being added"}.
        </span>
      ) : null}
    </p>
  );
}

/** Today's spend against the daily budget, as a ring that fills when the page opens. */
function LiveRing({ spent, budget, pace }: { spent: string; budget: string; pace: number }) {
  const r = 44;
  const len = 2 * Math.PI * r;
  const [fill, setFill] = useState(prefersStill() ? pace : 0);
  useEffect(() => {
    const t = setTimeout(() => setFill(pace), 60);
    return () => clearTimeout(t);
  }, [pace]);
  return (
    <div className="cpt-ring" role="img" aria-label={`Spent today: ${spent} of a ${budget} daily budget`}>
      <svg viewBox="0 0 104 104" aria-hidden="true">
        <circle className="trk" cx="52" cy="52" r={r} />
        <circle className="val" cx="52" cy="52" r={r} strokeDasharray={len} strokeDashoffset={len * (1 - Math.max(0, Math.min(100, fill)) / 100)} />
      </svg>
      <div className="mid" aria-hidden="true">
        <b>
          <CountUp text={spent.replace(/\.00$/, "")} />
        </b>
        <small>of {budget} today</small>
      </div>
    </div>
  );
}

/** Minutes past midnight of a moment, read in a time zone. */
function minutesIn(at: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Number(p.find((x) => x.type === "hour")?.value ?? 0) * 60 + Number(p.find((x) => x.type === "minute")?.value ?? 0);
}
const hhmmToMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/**
 * Today's sends on one line across the sending window, in the prospects' own time: what went out (filled dots on the
 * lit part of the track), what is booked (open dots), and where "now" is. Plain HTML laid out in percent, so the
 * text keeps its size whatever the width of the card.
 */
function TodayLine({ c }: { c: Cockpit }) {
  const w = c.outlook.window;
  const tz = w.tz;
  const now = new Date();
  const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: tz });
  const today = dayKey(now);
  const sent = (c.today?.sent ?? []).map((s) => new Date(s)).filter((d) => dayKey(d) === today);
  const booked = (c.today?.booked ?? []).map((s) => new Date(s)).filter((d) => dayKey(d) === today);
  const a = hhmmToMin(w.start);
  const b = Math.max(a + 60, hhmmToMin(w.end));
  const at = (m: number) => Math.max(0, Math.min(1, (m - a) / (b - a)));
  const nowMin = minutesIn(now, tz);
  const nowP = at(nowMin);
  const nowIn = nowMin >= a && nowMin <= b;
  const label = (m: number) => {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  };
  const nowMs = now.getTime();
  const next = booked.filter((d) => d.getTime() >= nowMs).sort((x, y) => x.getTime() - y.getTime())[0];
  // Sends are counted in 15-minute slots (wider on very long windows) and drawn as bars, so a busy day reads as
  // volume instead of a pile of overlapping dots.
  const step = Math.max(15, Math.ceil((b - a) / 48 / 15) * 15);
  const slots = Math.max(1, Math.ceil((b - a) / step));
  const bins = Array.from({ length: slots }, () => ({ sent: 0, booked: 0 }));
  const slotOf = (d: Date) => Math.max(0, Math.min(slots - 1, Math.floor((minutesIn(d, tz) - a) / step)));
  for (const d of sent) bins[slotOf(d)].sent++;
  for (const d of booked) bins[slotOf(d)].booked++;
  const peak = Math.max(1, ...bins.map((x) => x.sent + x.booked));
  // Square-root scale: one busy slot (a catch-up, a "send now") would otherwise flatten every single send to a dash.
  const H = 40;
  const hOf = (n: number) => (n ? Math.max(6, Math.round(Math.sqrt(n / peak) * H)) : 0);
  const span = (b - a) / step;
  const pos = (p: number) => `calc(7px + (100% - 14px) * ${p.toFixed(4)})`;
  const pastP = nowIn ? nowP : nowMin > b ? 1 : 0;
  // A tick on every whole hour, a label every two (three on long windows), and always the start and the end.
  const every = b - a > 600 ? 180 : 120;
  const hours: { m: number; label: boolean }[] = [];
  // A label too close to the end one would run into it, so it keeps only its tick.
  for (let m = Math.ceil(a / 60) * 60; m <= b; m += 60) hours.push({ m, label: m === a || m === b || ((m - a) % every === 0 && b - m >= every * 0.75) });
  if (!hours.some((h) => h.m === b)) hours.push({ m: b, label: true });
  return (
    <div className="cpt-day">
      <div className="cpt-day-h">
        <span className="k">Today&apos;s sends</span>
        <small>
          {nowIn ? (
            <>
              <i className="cpt-day-live" aria-hidden="true" />
              Now {clock(now, tz)} in {placeOf(tz)}
            </>
          ) : (
            `Their time in ${placeOf(tz)}`
          )}
        </small>
      </div>
      <div className="cpt-day-track" role="img" aria-label={`${sent.length} sent today, ${booked.length} still to go`}>
        {pastP > 0 ? <i className="past" style={{ width: `calc((100% - 14px) * ${pastP.toFixed(4)} + 7px)` }} /> : null}
        <i className="base" />
        {hours.map((h) => (
          <i key={h.m} className="tick" style={{ left: pos(at(h.m)) }} />
        ))}
        {bins.map((x, i) => {
          if (!x.sent && !x.booked) return null;
          const p = i / span;
          const w = Math.min(1, (i + 1) / span) - p;
          const from = a + i * step;
          const tip = `${label(from)}–${label(Math.min(b, from + step))}: ${x.sent ? `${x.sent} sent` : ""}${x.sent && x.booked ? ", " : ""}${x.booked ? `${x.booked} to go` : ""}`;
          const total = hOf(x.sent + x.booked);
          const hs = x.sent ? (x.booked ? Math.max(3, Math.round((total * x.sent) / (x.sent + x.booked))) : total) : 0;
          const hb = x.booked ? Math.max(3, total - hs) : 0;
          return (
            <span key={i} className="bin" title={tip} style={{ left: pos(p), width: `max(3px, calc((100% - 14px) * ${w.toFixed(4)} - 2px))` }}>
              {hb ? <i className="booked" style={{ height: hb }} /> : null}
              {hs ? <i className="sent" style={{ height: hs }} /> : null}
            </span>
          );
        })}
        {nowIn ? <i className="now" style={{ left: pos(nowP) }} /> : null}
      </div>
      <div className="cpt-day-ax" aria-hidden="true">
        {hours
          .filter((h) => h.label)
          .map((h) => (
            <span key={h.m} className={h.m === a ? "first" : h.m === b ? "last" : ""} style={{ left: pos(at(h.m)) }}>
              {label(h.m)}
            </span>
          ))}
      </div>
      <div className="cpt-day-key">
        <span>
          <i className="sent" /> {n0(sent.length)} sent
        </span>
        <span>
          <i className="booked" /> {n0(booked.length)} to go{next ? ` · next ${clock(next, tz)}` : ""}
        </span>
      </div>
    </div>
  );
}

function Greeting({ c }: { c: Cockpit }) {
  const user = useAppSelector((s) => s.auth.user);
  // Set after mount: the server has no idea what time of day it is for this person.
  const [hello, setHello] = useState("Welcome back");
  useEffect(() => {
    const h = new Date().getHours();
    setHello(h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
  }, []);
  const first = user?.name?.trim().split(/\s+/)[0];
  const w = c.week;
  const bits: string[] = [];
  if (w.sent) bits.push(`${plural(w.sent, "email")} out this week`);
  if (w.replies) bits.push(`${plural(w.replies, "reply", "replies")} back`);
  const fb = c.needsYou.firstBatch;
  const summary = bits.length
    ? `${bits.join(", ")}.`
    : c.progress.sentEver
      ? "A quiet week so far."
      : fb && firstBatchPhase(fb) === "ready"
        ? "Your first people are ready for you to check."
        : "Your first campaign is getting ready.";
  return (
    <header className="cpt-head">
      <div>
        <h1>
          {hello}
          {first ? `, ${first}` : ""}
        </h1>
        <p>
          <CountUp text={summary} />
        </p>
      </div>
    </header>
  );
}

function Status({ c }: { c: Cockpit }) {
  const fb = c.needsYou.firstBatch;
  // Before the first email of a first campaign, one focused card; money problems keep the normal card and its button.
  if (fb && !c.progress.sentEver && !["unpaid", "reserve", "paused", "capacity"].includes(c.engine.state)) return <FirstBatchHero c={c} fb={fb} />;
  const base = STATE[c.engine.state];
  const unfunded = c.credits.stage === "unfunded";
  const problem = fb?.problem ?? null;
  const o = c.outlook;

  /*
   * The header is corrected against what is actually queued, so it can never say "sending on schedule" above a
   * line that says nothing is scheduled.
   */
  const idle = c.engine.state === "running" && !o.inDay;
  // A weekly list can wait for review while this week's emails are already scheduled: then the headline is the
  // sending, and the review is the second thing on the card, not the other way round.
  const reviewWhileSending = c.engine.state === "reviewing" && !!(o.next || o.inDay);
  const tone: Tone = problem ? "bad" : reviewWhileSending ? "go" : idle ? (o.next ? "go" : "warm") : base.tone;
  const label = problem
    ? "Needs attention"
    : reviewWhileSending
      ? c.progress.sentEver
        ? "Sending"
        : "First emails scheduled"
      : unfunded
      ? "Card needed"
      : idle
        ? o.next
          ? "Next emails queued"
          : c.progress.sentEver
            ? "Nothing scheduled"
            : "Preparing your first emails"
        : base.label;
  const text = problem
    ? problem
    : reviewWhileSending
      ? "Your approved people are emailed on schedule. Next week's list is ready whenever you want to look at it."
      : c.engine.state === "unpaid" && unfunded
      ? "Add a card to start sending. You get free credit and nothing is charged."
      : c.engine.state === "capacity" && c.engine.capacityLiveOn
        ? `We're getting your sending capacity ready. It goes live on ${c.engine.capacityLiveOn}.`
        : c.engine.state === "approval" && fb
          ? `${fb.ready >= fb.needed ? `Your first ${n0(fb.needed)} people` : `${plural(fb.ready, "person", "people")}`} and their emails are ready. Check them, then approve. Nothing is sent before you do.`
          : c.engine.state === "preparing" && fb
            ? `We're finding the right people and writing an email for each one. Then you check the first ${n0(fb.needed)} before anything is sent.`
            : idle
              ? o.next
                ? "Outreach is on. The next emails are queued and go out at the time shown."
                : c.progress.sentEver
                  ? "Outreach is on, but nothing is queued for the next 24 hours. The reason is below."
                  : "We're choosing who to contact and writing an email for each one."
              : base.text;

  const blocked = ["approval", "reviewing", "unpaid", "reserve"].includes(c.engine.state);
  // The list of people waiting for a first email is nearly empty: say so, instead of "nothing needs you".
  const sup = c.outlook.supply;
  const low = !!sup?.low && !blocked && !problem && c.progress.sentEver;
  const quiet = !blocked && !c.needsYou.pendingWeeks.length && !c.needsYou.repliesWaiting && !c.needsYou.awaitingApproval && !problem && !low;
  // While the first people wait for approval nothing can send, so the daily sending budget is not shown yet.
  const showBudget = c.credits.stage !== "unfunded" && c.engine.state !== "approval";
  // Once a budget is running, the card leads with today: the spend ring on the left and the day's sends on the right.
  const live = !!c.budget.perDay && showBudget && !problem;
  const day = c.day;
  // Without today's plan (an older server), the bars below fall back to money spent against the budget.
  const capDc = c.budget.deciCents ? Number(c.budget.deciCents) : 0;
  const spentDc = Number((c.budget.spentToday ?? "0").replace(/[$,]/g, "")) * 1000;
  const pace = capDc ? Math.min(100, (spentDc / capDc) * 100) : c.engine.todayTarget ? Math.min(100, (c.engine.todaySent / c.engine.todayTarget) * 100) : 0;

  return (
    <section className={`cpt-hero is-${tone}`} aria-label="Status">
      <div className="cpt-hero-main">
        <div className={`cpt-hero-t${live ? " is-live" : ""}`}>
          {live ? <LiveRing spent={c.budget.spentToday ?? "$0.00"} budget={c.budget.perDay!} pace={pace} /> : null}
          <div className="cpt-live-t">
            <span className={`cpt-step is-${tone}`}>
              <span className={`ap-dot is-${tone}`} />
              {tone === "go" && c.progress.sentEver ? "Live" : c.progress.sentEver ? "Status" : "Your first campaign"}
            </span>
            <h2 className="cpt-title">{label}</h2>
            <p>
              {text}
              {quiet ? " Nothing needs you right now." : ""}
              {low && sup ? (
                sup.finding ? (
                  <> {sup.ready ? `Only ${plural(sup.ready, "person", "people")} left to email, so we're finding more now.` : "Everyone found so far has been emailed, so we're finding more now."}</>
                ) : (
                  <>
                    {" "}
                    {sup.ready ? `Only ${plural(sup.ready, "person", "people")} left to email.` : "Everyone found so far has been emailed."} Turn on <Link href="/app/settings?tab=autopilot">Find new people automatically</Link> or upload a list to keep sending.
                  </>
                )
              ) : null}
            </p>
            {live && day ? <DayLine day={day} /> : null}
            <div className="cpt-actions">
              <NextAction c={c} soft={reviewWhileSending} />
            </div>
          </div>
        </div>
        <div className="cpt-facts">
          {live ? (
            <div className="cpt-fact">
              <TodayLine c={c} />
            </div>
          ) : c.budget.perDay ? (
            <div className="cpt-fact cpt-spend" aria-label={`Spent today: ${c.budget.spentToday ?? "$0.00"} of a ${c.budget.perDay} daily budget`}>
              <div className="cpt-spend-head">
                <span className="k">Spent today</span>
                <span className="cpt-spend-cap">Budget {c.budget.perDay} / day</span>
              </div>
              <b className="cpt-spend-v">{c.budget.spentToday ?? "$0.00"}</b>
              <span className="cpt-bar" aria-hidden="true">
                <i style={{ width: `${pace}%` }} />
              </span>
              <div className="cpt-spend-foot">
                <span>{plural(c.engine.todaySent, "email")} sent</span>
                <span>Replies are free</span>
              </div>
            </div>
          ) : (
            <div className="cpt-fact">
              <span className="k">Sent today</span>
              <b className="v">{n0(c.engine.todaySent)}</b>
              <span className="cpt-bar" aria-hidden="true">
                <i style={{ width: `${pace}%` }} />
              </span>
            </div>
          )}
          <div className="cpt-fact">
            <span className="k">{c.progress.sentEver ? "Next email" : "First emails"}</span>
            <Outlook c={c} />
          </div>
        </div>
      </div>

      {!c.progress.sentEver ? (
        <Milestones steps={stepsOf(c)} />
      ) : null}

      {showBudget ? (
        <div className="ap-status-budget cpt-budget">
          <DailyBudget mode="line" />
        </div>
      ) : null}

      {!c.progress.sentEver && c.credits.stage === "trial" ? (
        <p className="ap-status-note">
          Your {c.credits.balance} free credit covers about {plural(c.credits.emailsLeft, "email")}. <Link href="/app/billing/credits">Add credits</Link> when you&apos;re ready.
        </p>
      ) : null}
    </section>
  );
}

/**
 * When the next email really goes out, from each person's scheduled minute, or in plain words why nothing is
 * scheduled. Times are the customer's own; the prospect's local time sits beside the next one.
 */
function Outlook({ c }: { c: Cockpit }) {
  const o = c.outlook;
  const place = placeOf(o.window.tz);
  const parts: ReactNode[] = [];
  if (o.next) {
    const theirs = o.nextProspectTz ? ` (${clock(o.next, o.nextProspectTz)} in ${placeOf(o.nextProspectTz)})` : "";
    const now = Date.now();
    // Its minute has come: the sender picks it up on its next pass, within a minute or two.
    const due = new Date(o.next).getTime() <= now;
    const head = due ? "Next email is going out now" : `Next email ${/^\d/.test(when(o.next)) ? "at " : ""}${when(o.next)} your time`;
    let more = "";
    if (o.inDay > 1 && o.lastInDay) {
      const sameDay = new Date(o.lastInDay).toDateString() === new Date(Math.max(now, new Date(o.next).getTime())).toDateString();
      more = ` · ${n0(o.inDay - 1)} more ${sameDay ? "today" : "in the next 24 hours"}, the last at ${clock(o.lastInDay)} your time`;
    }
    parts.push(
      <span key="next">
        <b>{head}</b>
        {due ? "" : theirs}
        {more}.
      </span>,
    );
  }
  // The status above already explains credit and capacity stops; a known next email already answers "when".
  const covered = ["unpaid", "reserve", "capacity"].includes(c.engine.state);
  if (!o.next && !o.inDay && o.reason && !covered) {
    const opens = o.window.opensAt;
    const why: Record<NonNullable<typeof o.reason>, ReactNode> = {
      "autopilot-off": (
        <>
          Nothing is scheduled because “Run every working day” is off. <Link href="/app/settings?tab=autopilot">Turn it on in Settings</Link>.
        </>
      ),
      "awaiting-approval": (
        <>
          Nothing is scheduled because your people are waiting for your approval. <Link href="/app/approve">Review them</Link>.
        </>
      ),
      "daily-cap": <>Today&apos;s {n0(o.cap)} new people have all been started. More start on the next sending day.</>,
      "outside-window": opens ? (
        <>
          Sending is closed for your prospects in {place} until {when(opens)} your time ({clock(opens, o.window.tz)} for them).
        </>
      ) : (
        <>Sending is closed for your prospects in {place}.</>
      ),
      "nothing-ready": <>Nothing is scheduled yet: we&apos;re still finding people and writing their emails.</>,
      scheduling: <>The next emails are being given their send times. That happens every few minutes.</>,
    };
    parts.push(<span key="why">{why[o.reason]}</span>);
  }
  if (!parts.length) return <p className="ap-outlook muted">Nothing queued yet.</p>;
  return (
    <p className="ap-outlook" role="status">
      <span>{parts}</span>
    </p>
  );
}

/**
 * Who gets a first email next, soonest first. Instead of reviewing a whole list every week, the customer glances at
 * the next few people and leaves out anyone who isn't a fit, before anything is sent to them.
 */
function UpNext({ c }: { c: Cockpit }) {
  const { canManage } = useRole();
  const toast = useToast();
  const [leaveOut, leaving] = useLeaveOutMutation();
  const [asking, setAsking] = useState<{ id: string; name: string } | null>(null);
  const up = c.upNext;
  if (!up?.people.length || c.needsYou.firstBatch) return null;
  const np = c.outlook.newPeople;
  const tz = c.outlook.window.tz;
  // "Tomorrow from 9:00am: 13 new people", in the prospects' own morning, so nobody wonders why nothing goes today.
  const npDay = np ? dayName(np.at, tz) : null;
  const npWhen = np ? (npDay === "Today" && new Date(np.at).getTime() <= Date.now() ? "Today, through the day" : `${npDay} from ${clock(np.at, tz)}`) : null;
  return (
    <section className="cpt-next" aria-label="Up next">
      <header>
        <div className="cpt-next-t">
          <h3>Up next</h3>
          {np ? (
            <p className="cpt-next-when">
              <b>{npWhen}</b>
              <span>
                {" "}
                · {np.count === 1 ? "1 new person" : `${n0(np.count)} new people`}
                {tz ? ` · their time in ${placeOf(tz)}` : ""}
              </span>
            </p>
          ) : (
            <p className="cpt-next-when">The next people to get a first email</p>
          )}
        </div>
        <Link href="/app/leads?tab=today" className="cpt-next-all">
          {up.total > up.people.length ? `All ${n0(up.total)} lined up` : "See the schedule"}
          <Icon id="arr" />
        </Link>
      </header>
      <ul>
        {up.people.map((p) => (
          <li key={p.id}>
            <Avatar name={p.name} size={30} />
            <span className="who">
              <b>{p.name}</b>
              <small>{[p.title, p.company].filter(Boolean).join(" at ") || "\u00a0"}</small>
            </span>
            <span className="at">
              {p.at ? (
                <>
                  {when(p.at)}
                  {p.tz ? <small>{clock(p.at, p.tz)} for them</small> : null}
                </>
              ) : (
                <small>{npDay ? npDay.toLowerCase() === "today" ? "later today" : npDay.toLowerCase() : "next sending day"}</small>
              )}
            </span>
            {canManage ? (
              <button type="button" className="btn btn-text btn-xs" onClick={() => setAsking({ id: p.id, name: p.name })}>
                Leave out
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {asking ? (
        <Confirm
          title={`Leave out ${asking.name}?`}
          confirmLabel="Leave out"
          loading={leaving.isLoading}
          onClose={() => setAsking(null)}
          onConfirm={() =>
            leaveOut(asking.id)
              .unwrap()
              .then(() => {
                toast(`${asking.name} won't be emailed.`, "good");
                setAsking(null);
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body="They get no emails from this campaign. Nothing has been sent to them yet."
        />
      ) : null}
    </section>
  );
}

/** Weekly lead lists, people to approve and replies waiting. The first approval lives in the status card above. */
function NeedsYou({ c }: { c: Cockpit }) {
  const needs = c.needsYou;
  // Before the first batch is approved, the first batch is the only approval on the page; weekly lists come after.
  const weeks = needs.firstBatch ? [] : c.engine.state === "reviewing" ? needs.pendingWeeks.slice(1) : needs.pendingWeeks;
  const items: { key: string; href: string; icon: IconId; title: string; text: string; tone: "gold" | "bad" }[] = [];
  if (needs.repliesWaiting)
    items.push({
      key: "replies",
      href: "/app/inbox?filter=needs",
      icon: "inbox",
      title: `${n0(needs.repliesWaiting)} repl${needs.repliesWaiting === 1 ? "y" : "ies"} waiting`,
      text: needs.urgentReplies ? `${needs.urgentReplies} marked urgent` : "Waiting for an answer from you",
      tone: needs.urgentReplies ? "bad" : "gold",
    });
  if (needs.awaitingApproval)
    items.push({
      key: "approve",
      href: "/app/approve",
      icon: "users",
      title: `${plural(needs.awaitingApproval, "person", "people")} waiting for your approval`,
      text: "Found and written to. Nobody is emailed until you approve them.",
      tone: "gold",
    });
  for (const w of weeks)
    items.push({ key: w.batchId, href: `/app/leads?batch=${w.batchId}`, icon: "calendar", title: `Week of ${w.label} is ready`, text: `${n0(w.sendable)} of ${n0(w.total)} leads can send. Review and approve.`, tone: "gold" });
  if (!items.length) return null;
  return (
    <section className="cpt-todo" aria-label="Waiting on you">
      {items.map((it) => (
        <Link key={it.key} href={it.href} className={`cpt-task is-${it.tone}`}>
          <span className="ic">
            <Icon id={it.icon} />
          </span>
          <span className="t">
            <b>{it.title}</b>
            <small>{it.text}</small>
          </span>
          <span className="go">
            Open
            <Icon id="arr" />
          </span>
        </Link>
      ))}
    </section>
  );
}

/**
 * The change against the period before: a percentage for counts, points for rates. Direction is not sentiment:
 * the sign says which way it moved, the colour says whether that is good for this particular metric.
 */
function Change({ now, before, points, days, rising = "good" }: { now: number | null; before: number | null; points?: boolean; days: number; rising?: "good" | "bad" | "neutral" }) {
  if (now === null) return null;
  const title = days === 1 ? "Compared with yesterday" : `Compared with the ${days} days before`;
  // With nothing earlier to compare against there is no badge; the section header says so once.
  if (before === null || (!before && !points)) return null;
  const d = points ? Math.round((now - before) * 10) / 10 : Math.round(((now - before) / before) * 100);
  if (!d)
    return (
      <span className="ap-chg" title={title}>
        no change
      </span>
    );
  const tone = rising === "neutral" ? "" : (d > 0) === (rising === "good") ? "good" : "poor";
  return (
    <span className={`ap-chg ${tone} ${d > 0 ? "up" : "down"}`} title={title}>
      {d > 0 ? "+" : "−"}
      {Math.abs(d)}
      {points ? " pts" : "%"}
    </span>
  );
}

/** A rate, without claiming precision the sample cannot carry: 100.0% of five emails is not a tenth of a percent. */
function rate(v: number | null, sample: number) {
  if (v === null) return "–";
  return sample >= 200 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
}

function Kpi({ label, hint, value, change, chart, children, empty }: { label: string; hint: string; value: string; change: ReactNode; chart: ReactNode; children: ReactNode; empty?: { title: string; note: string } }) {
  return (
    <div className={`cpt-kpi${empty ? " is-empty" : ""}`}>
      <span className="lab" title={hint}>
        {label}
      </span>
      {empty ? (
        // A zero that is only early days reads as encouragement, not as a failure in big white type.
        <div className="cpt-kpi-empty">
          <b>{empty.title}</b>
          <p>{empty.note}</p>
        </div>
      ) : (
        <>
          <div className="vrow">
            <b className="v">
              <CountUp text={value} />
            </b>
            {change}
          </div>
          <div className="sp">{chart}</div>
        </>
      )}
      <div className="sub">{children}</div>
    </div>
  );
}

type Day = Performance["series"][number];
type Bucket = { label: string; full: string; days: Day[] };
const dayDate = (day: string) => new Date(`${day}T12:00:00Z`);
const fmtDay = (day: string, o: Intl.DateTimeFormatOptions) => dayDate(day).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });

/**
 * The points a tile shows: one per day for a week, one per week for longer (30 crowded dots read as noise). Weeks
 * are counted back from today, so the last point is always the current week.
 */
function bucketsOf(series: Day[]): Bucket[] {
  // Longer than about four months: one point per month, so a year never becomes 52 crowded dots.
  if (series.length > 120) {
    const months = new Map<string, Day[]>();
    for (const d of series) months.set(d.day.slice(0, 7), [...(months.get(d.day.slice(0, 7)) ?? []), d]);
    return [...months.values()].map((days) => ({ label: fmtDay(days[0].day, { month: "short" }), full: fmtDay(days[0].day, { month: "long", year: "numeric" }), days }));
  }
  if (series.length <= 10)
    return series.map((d) => ({ label: fmtDay(d.day, { weekday: "short" }), full: fmtDay(d.day, { weekday: "short", day: "numeric", month: "short" }), days: [d] }));
  const out: Bucket[] = [];
  for (let end = series.length; end > 0; end -= 7) {
    // A short leftover at the start (30 days is 4 weeks and 2 days) joins the next week instead of becoming its own point.
    const start = end - 7 < 4 ? 0 : end - 7;
    const days = series.slice(start, end);
    end = start + 7;
    const first = days[0].day;
    const last = days[days.length - 1].day;
    out.unshift({ label: fmtDay(first, { month: "short", day: "numeric" }), full: `${fmtDay(first, { month: "short", day: "numeric" })} – ${fmtDay(last, { month: "short", day: "numeric" })}`, days });
  }
  return out;
}
const sumOf = (days: Day[], k: keyof Omit<Day, "day">) => days.reduce((a, d) => a + (d[k] as number), 0);
const money = (decicents: number) => `$${(decicents / 1000).toFixed(decicents >= 10_000 ? 0 : 2)}`;

function Kpis({ p }: { p: Performance }) {
  const t = p.totals;
  const b = p.previous;
  const delivered = pct(t.delivered, t.sent);
  const deliveredBefore = pct(b.delivered, b.sent);
  const replyRate = pct(t.replies, t.firstEmails);
  const perLead = t.hot ? dollars(Math.round(t.spentDecicents / t.hot)) : null;
  const bk = bucketsOf(p.series);
  const pts = (f: (days: Day[]) => number | null) => bk.map((x) => ({ label: x.label, full: x.full, value: f(x.days) }));
  const plural1 = (v: number, one: string, many: string) => `${n0(v)} ${v === 1 ? one : many}`;
  return (
    <div className="cpt-kpis">
      <Kpi label="Emails sent" hint="First emails and follow-ups that went out" value={n0(t.sent)} change={<Change now={t.sent} before={b.sent} days={p.days} />} chart={<MiniChart points={pts((d) => sumOf(d, "sent"))} color={TONE.blue} unit={(v) => plural1(v, "email", "emails")} />}>
        <span>
          <b>{n0(t.firstEmails)}</b> first emails
        </span>
        <span>
          <b>{n0(t.followUps)}</b> follow-ups
        </span>
      </Kpi>
      <Kpi
        label="Delivered"
        hint="Share of sent emails that reached the inbox"
        value={rate(delivered, t.sent)}
        change={<Change now={delivered} before={deliveredBefore} points days={p.days} rising="good" />}
        // A day or week with nothing sent has no rate, so it shows no dot rather than a false 0%.
        chart={<MiniChart points={pts((d) => pct(sumOf(d, "delivered"), sumOf(d, "sent")))} color={TONE.good} max={100} format={(v) => `${Math.round(v)}%`} unit={(v) => `${Math.round(v)}% delivered`} />}
      >
        <span>
          <b>{n0(t.delivered)}</b> reached the inbox
        </span>
        <span className={t.bounced ? "bad" : ""}>
          <b>{n0(t.bounced)}</b> bounced
        </span>
      </Kpi>
      <Kpi
        label="Hot leads"
        hint="Replies that showed interest or asked a real question"
        empty={!t.hot && !t.replies && t.firstEmails > 0 ? { title: "None yet", note: "Replies usually start 3 to 5 days after the first emails." } : undefined}
        value={n0(t.hot)} change={<Change now={t.hot} before={b.hot} days={p.days} />} chart={<MiniChart points={pts((d) => sumOf(d, "hot"))} color={TONE.accent} unit={(v) => plural1(v, "hot lead", "hot leads")} />}>
        <span>
          <b>{n0(t.replies)}</b> {t.replies === 1 ? "reply" : "replies"}
        </span>
        {replyRate !== null ? (
          <span>
            <b>{rate(replyRate, t.firstEmails)}</b> replied
          </span>
        ) : null}
      </Kpi>
      <Kpi label="Spent" hint="What the emails in this period cost" value={t.spent} change={<Change now={t.spentDecicents} before={b.spentDecicents} days={p.days} rising="neutral" />} chart={<MiniChart points={pts((d) => sumOf(d, "spentDecicents"))} color={TONE.accent} format={money} unit={(v) => `${money(v)} spent`} />}>
        <span>
          <b>{t.pricePerEmail}</b> per email, answers included
        </span>
        {perLead ? (
          <span>
            <b>{perLead}</b> per hot lead
          </span>
        ) : null}
      </Kpi>
    </div>
  );
}

/** Sent and replies per day on one chart, so effort and result are read side by side. */
function Trend({ p }: { p: Performance }) {
  return (
    <div className="ap-card cpt-trend">
      <div className="ap-card-h">
        <h2>Sends and replies</h2>
        <span className="sp" />
        <span className="cpt-key">
          <span>
            <i className="bar" style={{ background: "var(--chart-2)" }} />
            Emails sent
          </span>
          <span>
            <i className="bar" style={{ background: "var(--chart-1)" }} />
            Replies
          </span>
        </span>
      </div>
      <div className="cpt-chart">
        <LineChart
          labels={p.series.map((d) => shortDay(d.day))}
          counts
          height={210}
          series={[
            // Daily counts are sparse, so each day gets two slim columns side by side: effort in calm blue, the result in gold.
            { key: "sent", label: "Emails sent", color: TONE.blue, values: p.series.map((d) => d.sent), bars: true },
            { key: "replies", label: "Replies", color: TONE.accent, values: p.series.map((d) => d.replies), bars: true },
          ]}
          empty="Daily sends and replies show here once emails go out."
        />
      </div>
    </div>
  );
}

/** What the numbers cover and what they are compared with, in one line. */
function periodNote(p: Performance | undefined, period: PerformancePeriod) {
  const span = period === "today" ? "today" : period === "all" ? "since your first email" : `last ${period === "7d" ? 7 : 30} days`;
  if (period === "all") return span;
  if (p && p.period === period && !p.previous.sent) return `${span} · nothing earlier to compare with yet`;
  return period === "today" ? "today, compared with yesterday" : `${span}, compared with the ${period === "7d" ? 7 : 30} days before`;
}

function PerformanceSection() {
  const [period, setPeriod] = useState<PerformancePeriod>("7d");
  const [campaign, setCampaign] = useState("");
  const { data: p, isError, error, refetch } = usePerformanceQuery({ period, campaign: campaign || null }, { pollingInterval: 120_000, skipPollingIfUnfocused: true });
  // The campaign list never narrows with the filter, so the picker keeps every choice while a new period loads.
  const [choices, setChoices] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    if (p?.audiences.length) setChoices(p.audiences.map((a) => ({ value: a.id || "own", label: a.name })));
  }, [p?.audiences]);
  const ready = !!p && p.period === period && (p.campaign ?? "") === campaign;
  return (
    <section className="cpt-perf" aria-label="Performance">
      <div className="ap-sec-h">
        <h2>Performance</h2>
        <span className="meta">{periodNote(p, period)}</span>
        <span className="sp" />
        <div className="cpt-filters">
          {choices.length > 1 ? (
            <Select className="select cpt-filter" aria-label="Campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
              <option value="">All campaigns</option>
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          ) : null}
          <PeriodSelect value={period} onChange={setPeriod} />
        </div>
      </div>
      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : !ready ? (
        <>
          <Skeleton h={168} r={16} />
          <Skeleton h={260} r={16} />
        </>
      ) : (
        <>
          <Kpis p={p} />
          <Trend p={p} />
          <CampaignsCard p={p} link={{ href: "/app/campaigns", label: "Open campaigns" }} />
        </>
      )}
    </section>
  );
}

function LatestReplies({ c }: { c: Cockpit }) {
  const list = c.needsYou.latestReplies;
  return (
    <div className="ap-card cpt-replies">
      <div className="ap-card-h">
        <h2>Latest replies</h2>
        <span className="sp" />
        <Link className="meta" href="/app/inbox">
          Open inbox
        </Link>
      </div>
      {list.length ? (
        <div className="cpt-rlist">
          {list.map((x) => {
            const theirs = x.lastMessageDirection === "INBOUND";
            return (
              <Link key={x.id} href={`/app/inbox?c=${x.id}`} className={`cpt-reply${theirs ? " is-new" : ""}`}>
                <Avatar name={x.fullName ?? x.email} size={34} />
                <span className="t">
                  <span className="top">
                    <b>{x.fullName ?? x.email}</b>
                    {x.company ? <span className="co">{x.company}</span> : null}
                    <time>{ago(x.lastMessageAt)}</time>
                  </span>
                  <span className="pv">
                    {theirs ? null : <span className="you">You: </span>}
                    {x.lastMessagePreview}
                  </span>
                  {x.replyClass || x.replyUrgent ? (
                    <span className="tags">
                      {x.replyUrgent ? <span className="chip-s r">Urgent</span> : null}
                      {x.replyClass ? <span className={`chip-s ${REPLY_TONE[x.replyClass] ?? "v"}`}>{REPLY_LABEL[x.replyClass] ?? x.replyClass}</span> : null}
                    </span>
                  ) : null}
                </span>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="ap-empty">
          <span className="ic">
            <Icon id="inbox" />
          </span>
          <b>No replies yet</b>
          <p>When prospects answer, their replies appear here and in your inbox.</p>
        </div>
      )}
    </div>
  );
}

const EVENT: Record<string, { icon: IconId; tone: string }> = {
  reply: { icon: "inbox", tone: "good" },
  sent: { icon: "plane", tone: "blue" },
  approved: { icon: "check", tone: "gold" },
  review: { icon: "users", tone: "warn" },
};

function Activity({ c }: { c: Cockpit }) {
  // The same event repeated (one person replying several times) becomes one line with a count, at its latest time.
  const rows: (Cockpit["activity"][number] & { times: number })[] = [];
  for (const a of c.activity) {
    const same = rows.find((r) => r.type === a.type && r.title === a.title);
    if (same) same.times++;
    else rows.push({ ...a, times: 1 });
  }
  return (
    <div className="ap-card cpt-activity">
      <div className="ap-card-h">
        <h2>Recent activity</h2>
        <span className="sp" />
        <span className="meta">last two weeks</span>
      </div>
      {c.activity.length ? (
        <ol className="cpt-feed">
          {rows.map((a, i) => {
            const ev = EVENT[a.type] ?? { icon: "pulse" as IconId, tone: "ink" };
            return (
              <li key={i} className={`is-${ev.tone}`}>
                <span className="ic">
                  <Icon id={ev.icon} />
                </span>
                <span className="t">
                  {a.title}
                  {a.times > 1 ? <em className="cpt-times">{a.times} times</em> : null}
                </span>
                <time>{a.type === "sent" ? dayOf(a.at) : ago(a.at)}</time>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="ap-empty">
          <span className="ic">
            <Icon id="list" />
          </span>
          <b>Nothing yet</b>
          <p>Activity shows up here once sending starts.</p>
        </div>
      )}
    </div>
  );
}

export default function CockpitPage() {
  const { data: c, isLoading, isError, error, refetch } = useCockpitQuery(undefined, { pollingInterval: 120_000, skipPollingIfUnfocused: true });
  useBalanceSync(c?.credits.balance);
  const waiting = c?.engine.state === "preparing";
  // While the first people are being found the status moves within seconds; afterwards every two minutes is plenty.
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(refetch, 5_000);
    return () => clearInterval(id);
  }, [waiting, refetch]);

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !c)
    return (
      <div className="cpt" aria-busy="true">
        <Skeleton h={58} w="40%" r={10} />
        <Skeleton h={190} r={18} />
        <Skeleton h={168} r={16} />
      </div>
    );

  return (
    <div className="cpt">
      <EngineAction c={c} />
      <Greeting c={c} />
      <Status c={c} />
      <UpNext c={c} />
      <NeedsYou c={c} />
      <PerformanceSection />
      <div className="cpt-pair">
        <LatestReplies c={c} />
        <Activity c={c} />
      </div>
    </div>
  );
}
