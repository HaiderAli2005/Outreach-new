"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconId } from "@/components/ui/Icon";
import { Avatar, Button, Chip, ErrorState, Seg, Skeleton } from "@/components/ui/primitives";
import { DailyBudget } from "@/components/billing/DailyBudget";
import { TOP_ACTIONS_ID } from "@/components/shell/AppShell";
import { Confirm } from "@/components/ui/overlays";
import { LineChart, Spark, TONE } from "@/components/admin/charts";
import { useAppSelector, useRole, useToast } from "@/store";
import { errorMessage, useCockpitQuery, useEngineStartMutation, useEngineStopMutation, useFirstRunMutation, usePerformanceQuery } from "@/store/api";
import { REPLY_LABEL, REPLY_TONE, ago, clock, n0, placeOf, when } from "@/lib/format";
import type { CampaignState, Cockpit, Performance } from "@/lib/types";

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
      <Button size="sm" variant="ghost" icon="power" onClick={() => setConfirm(true)}>
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
          body="Autopilot turns off and no new emails or follow-ups go out. Replies still arrive in your inbox."
        />
      ) : null}
    </>,
    slot,
  );
}

/** The one next thing to do, if there is one. Everything else on the page is reading. */
function NextAction({ c }: { c: Cockpit }) {
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
      <Link className="btn btn-primary" href={`/app/leads?batch=${week.batchId}`}>
        Review the week
      </Link>
    );
  return null;
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
      title: funded ? "Campaign launched" : "Add a card",
      text: funded ? `${c.credits.balance} in your balance, about ${n0(c.credits.emailsLeft)} emails. Nothing was charged.` : "Add a card to unlock your free credit.",
      state: funded && c.engine.on ? "done" : "you",
    },
    {
      title: "Finding your first people",
      text: `${n0(found)} found · ${n0(p.verified)} verified · ${n0(written)} emails written`,
      state: fb?.problem ? "stop" : fb ? (fb.ready >= fb.needed || (!fb.finding && fb.ready > 0) ? "done" : "now") : written > 0 ? "done" : "now",
    },
  ];
  if (fb)
    steps.push({
      title: "Your approval",
      text: fb.ready ? `${plural(fb.ready, "person", "people")} ready to check. Nothing is sent before you approve.` : `Next, you check the first ${n0(fb.needed)} people and their emails.`,
      state: fb.ready ? "you" : "next",
    });
  steps.push({
    title: "First emails",
    text: c.engine.state === "capacity" && c.engine.capacityLiveOn ? `When sending capacity goes live on ${c.engine.capacityLiveOn}` : `${fb ? "After you approve, from" : "From"} ${c.engine.windowStart} in each prospect's local time`,
    state: "next",
  });
  return steps;
}

const STEP_LABEL: Record<Step["state"], string> = { done: "Done", now: "Working on it", you: "Needs you", next: "Next", stop: "Stopped" };

/** A greeting and one sentence that sums up the period, so the page answers "how is it going" before any number. */
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
  const summary = bits.length ? `${bits.join(", ")}.` : c.progress.sentEver ? "A quiet week so far." : "Your outreach is being set up.";
  return (
    <header className="cpt-head">
      <div>
        <h1>
          {hello}
          {first ? `, ${first}` : ""}
        </h1>
        <p>{summary}</p>
      </div>
    </header>
  );
}

function Status({ c }: { c: Cockpit }) {
  const fb = c.needsYou.firstBatch;
  const base = STATE[c.engine.state];
  const unfunded = c.credits.stage === "unfunded";
  const problem = fb?.problem ?? null;
  const o = c.outlook;

  /*
   * The header is corrected against what is actually queued, so it can never say "sending on schedule" above a
   * line that says nothing is scheduled.
   */
  const idle = c.engine.state === "running" && !o.inDay;
  const tone: Tone = problem ? "bad" : idle ? (o.next ? "go" : "warm") : base.tone;
  const label = problem
    ? "Needs attention"
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

  const pace = c.engine.todayTarget ? Math.min(100, (c.engine.todaySent / c.engine.todayTarget) * 100) : 0;
  const blocked = ["approval", "reviewing", "unpaid", "reserve"].includes(c.engine.state);
  const quiet = !blocked && !c.needsYou.pendingWeeks.length && !c.needsYou.repliesWaiting && !c.needsYou.awaitingApproval && !problem;
  // While the first people wait for approval nothing can send, so the daily sending budget is not shown yet.
  const showBudget = c.credits.stage !== "unfunded" && c.engine.state !== "approval";

  return (
    <section className={`cpt-hero is-${tone}`} aria-label="Status">
      <div className="cpt-hero-main">
        <div className="cpt-hero-t">
          <span className={`cpt-pill is-${tone}`}>
            <span className={`ap-dot is-${tone}`} />
            {label}
          </span>
          <p>
            {text}
            {quiet ? " Nothing needs you right now." : ""}
          </p>
          <NextAction c={c} />
        </div>
        <div className="cpt-facts">
          <div className="cpt-fact">
            <span className="k">Sent today</span>
            <b className="v">
              {n0(c.engine.todaySent)}
              <i> / {n0(c.engine.todayTarget)}</i>
            </b>
            <span className="cpt-bar" aria-hidden="true">
              <i style={{ width: `${pace}%` }} />
            </span>
          </div>
          <div className="cpt-fact">
            <span className="k">{c.progress.sentEver ? "Next email" : "First emails"}</span>
            <Outlook c={c} />
          </div>
        </div>
      </div>

      {!c.progress.sentEver ? (
        <ol className="ap-track">
          {stepsOf(c).map((s, i) => (
            <li key={s.title} className={s.state}>
              <span className="k">{s.state === "done" ? <Icon id="check" /> : i + 1}</span>
              <span className="t">
                <b>{s.title}</b>
                <small>{s.text}</small>
                <em>{STEP_LABEL[s.state]}</em>
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {showBudget ? (
        <div className="ap-status-budget cpt-budget">
          <DailyBudget mode="line" />
        </div>
      ) : null}

      {!c.progress.sentEver && c.credits.stage === "trial" ? (
        <p className="ap-status-note">
          Your {c.credits.balance} free credit covers about {n0(c.credits.emailsLeft)} emails. <Link href="/app/billing/credits">Add credits</Link> when you&apos;re ready.
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
    const theirs = o.nextProspectTz ? ` (${clock(o.next, o.nextProspectTz)} for them in ${placeOf(o.nextProspectTz)})` : "";
    const now = Date.now();
    const at = new Date(o.next).getTime() <= now ? "any minute now" : `at ${when(o.next)}`;
    let more = "";
    if (o.inDay > 1 && o.lastInDay) {
      const sameDay = new Date(o.lastInDay).toDateString() === new Date(Math.max(now, new Date(o.next).getTime())).toDateString();
      more = `, ${n0(o.inDay - 1)} more ${sameDay ? "today" : "in the next 24 hours"} between ${clock(o.next)} and ${clock(o.lastInDay)}`;
    }
    parts.push(
      <span key="next">
        <b>Next email {at}</b>
        {theirs}
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
          Nothing is scheduled because Autopilot is off. <Link href="/app/settings?tab=autopilot">Turn it on in Settings</Link>.
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

/** Weekly lead lists, people to approve and replies waiting. The first approval lives in the status card above. */
function NeedsYou({ c }: { c: Cockpit }) {
  const needs = c.needsYou;
  const weeks = c.engine.state === "reviewing" ? needs.pendingWeeks.slice(1) : needs.pendingWeeks;
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
  const title = `Compared with the ${days} days before`;
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

function Kpi({ label, hint, value, change, spark, color, children }: { label: string; hint: string; value: string; change: ReactNode; spark: (number | null)[]; color: string; children: ReactNode }) {
  return (
    <div className="cpt-kpi">
      <span className="lab" title={hint}>
        {label}
      </span>
      <div className="vrow">
        <b className="v">{value}</b>
        {change}
      </div>
      <div className="sp">
        <Spark values={spark} color={color} />
      </div>
      <div className="sub">{children}</div>
    </div>
  );
}

function Kpis({ p }: { p: Performance }) {
  const t = p.totals;
  const b = p.previous;
  const delivered = pct(t.delivered, t.sent);
  const deliveredBefore = pct(b.delivered, b.sent);
  const replyRate = pct(t.replies, t.firstEmails);
  const perLead = t.hot ? dollars(Math.round(t.spentDecicents / t.hot)) : null;
  return (
    <div className="cpt-kpis">
      <Kpi label="Emails sent" hint="First emails and follow-ups that went out" value={n0(t.sent)} change={<Change now={t.sent} before={b.sent} days={p.days} />} spark={p.series.map((d) => d.sent)} color={TONE.gold}>
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
        spark={p.series.map((d) => pct(d.delivered, d.sent))}
        color={TONE.good}
      >
        <span>
          <b>{n0(t.delivered)}</b> reached the inbox
        </span>
        <span className={t.bounced ? "bad" : ""}>
          <b>{n0(t.bounced)}</b> bounced
        </span>
      </Kpi>
      <Kpi label="Hot leads" hint="Replies that showed interest or asked a real question" value={n0(t.hot)} change={<Change now={t.hot} before={b.hot} days={p.days} />} spark={p.series.map((d) => d.hot)} color={TONE.good}>
        <span>
          <b>{n0(t.replies)}</b> {t.replies === 1 ? "reply" : "replies"}
        </span>
        {replyRate !== null ? (
          <span>
            <b>{rate(replyRate, t.firstEmails)}</b> replied
          </span>
        ) : null}
      </Kpi>
      <Kpi label="Spent" hint="What the emails in this period cost" value={t.spent} change={<Change now={t.spentDecicents} before={b.spentDecicents} days={p.days} rising="neutral" />} spark={p.series.map((d) => d.spentDecicents)} color={TONE.gold}>
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
            <i style={{ background: "var(--gold)" }} />
            Emails sent
          </span>
          <span>
            <i style={{ background: "var(--good)" }} />
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
            { key: "sent", label: "Emails sent", color: TONE.gold, values: p.series.map((d) => d.sent), area: true },
            { key: "replies", label: "Replies", color: TONE.good, values: p.series.map((d) => d.replies) },
          ]}
          empty="Daily sends and replies show here once emails go out."
        />
      </div>
    </div>
  );
}

const CAMPAIGN_STATE: Record<CampaignState, { label: string; tone: "g" | "b" | "v" | "y" | "r"; text: string }> = {
  sending: { label: "Sending", tone: "g", text: "Emails go out every working day." },
  finding: { label: "Finding people", tone: "b", text: "Looking for more people who match before the next emails." },
  waiting: { label: "Waiting for approval", tone: "y", text: "Nothing sends until you approve the first people." },
  paused: { label: "Paused", tone: "v", text: "Outreach is stopped. Start it again from the top bar." },
  off: { label: "Off", tone: "v", text: "This audience is turned off." },
  exhausted: { label: "Out of people", tone: "r", text: "Everyone who matches has been emailed. Widen this audience to keep going." },
};

function Campaigns({ p }: { p: Performance }) {
  return (
    <div className="ap-card cpt-camps">
      <div className="ap-card-h">
        <h2>Campaigns</h2>
        <span className="meta">{p.audiences.length ? plural(p.audiences.length, "campaign") : ""}</span>
        <span className="sp" />
        <Link className="meta" href="/app/campaigns">
          Manage
        </Link>
      </div>
      {p.audiences.length ? (
        <div className="ap-tbl-wrap">
          <table className="ap-tbl ap-camps">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th className="r">Found</th>
                <th className="r">Sent</th>
                <th className="r">Reply rate</th>
                <th className="r">Hot leads</th>
                <th className="r">Cost per lead</th>
                <th className="r">Spent</th>
              </tr>
            </thead>
            <tbody>
              {p.audiences.map((a) => {
                const st = CAMPAIGN_STATE[a.state];
                return (
                  <tr key={a.id || "own"}>
                    <td className="s">
                      {a.name}
                      {a.state === "sending" && a.perDay ? <small>about {n0(a.perDay)} a day</small> : null}
                    </td>
                    <td>
                      <span title={st.text}>
                        <Chip tone={st.tone}>{st.label}</Chip>
                      </span>
                    </td>
                    <td className="r">{n0(a.found)}</td>
                    <td className="r">{n0(a.sent)}</td>
                    <td className="r">{a.sent ? `${a.replyRate.toFixed(1)}%` : "–"}</td>
                    <td className={`r${a.hot ? " hot" : ""}`}>{n0(a.hot)}</td>
                    <td className="r">{a.costPerLead ?? "–"}</td>
                    <td className="r">{a.spent}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="ap-empty">
          <span className="ic">
            <Icon id="target" />
          </span>
          <b>No campaigns yet</b>
          <p>Each audience you launch shows here with what it sent, the replies it got and what it cost.</p>
        </div>
      )}
    </div>
  );
}

function PerformanceSection() {
  const [days, setDays] = useState<7 | 30>(7);
  const { data: p, isError, error, refetch } = usePerformanceQuery(days, { pollingInterval: 120_000, skipPollingIfUnfocused: true });
  return (
    <section className="cpt-perf" aria-label="Performance">
      <div className="ap-sec-h">
        <h2>Performance</h2>
        <span className="meta">
          {p && p.days === days && !p.previous.sent ? `last ${days} days · nothing earlier to compare with yet` : `last ${days} days, compared with the ${days} days before`}
        </span>
        <span className="sp" />
        <Seg
          size="sm"
          label="Period"
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: "7 days" },
            { value: 30, label: "30 days" },
          ]}
        />
      </div>
      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : !p || p.days !== days ? (
        <>
          <Skeleton h={168} r={16} />
          <Skeleton h={260} r={16} />
        </>
      ) : (
        <>
          <Kpis p={p} />
          <Trend p={p} />
          <Campaigns p={p} />
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
  sent: { icon: "plane", tone: "gold" },
  approved: { icon: "check", tone: "gold" },
  review: { icon: "users", tone: "warn" },
};

function Activity({ c }: { c: Cockpit }) {
  return (
    <div className="ap-card cpt-activity">
      <div className="ap-card-h">
        <h2>Recent activity</h2>
        <span className="sp" />
        <span className="meta">last two weeks</span>
      </div>
      {c.activity.length ? (
        <ol className="cpt-feed">
          {c.activity.map((a, i) => {
            const ev = EVENT[a.type] ?? { icon: "pulse" as IconId, tone: "ink" };
            return (
              <li key={i} className={`is-${ev.tone}`}>
                <span className="ic">
                  <Icon id={ev.icon} />
                </span>
                <span className="t">{a.title}</span>
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
      <NeedsYou c={c} />
      <PerformanceSection />
      <div className="cpt-pair">
        <LatestReplies c={c} />
        <Activity c={c} />
      </div>
    </div>
  );
}
