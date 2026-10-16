"use client";

import { CostSection } from "./CostStack";
import type { ReactNode } from "react";
import { money, n0 } from "@/lib/format";
import type { AdminPoolView } from "@/lib/types";
import { BarChart, Bullet, Donut, HBars, Legend, LineChart, Meter, RAMP, StackBar, TONE } from "./charts";
import { exact, Figures, Hero, Kpi, Panel, plural, Section, Verdict, type Tone } from "./poolParts";
import { ShelfSection } from "./PoolShelf";

/** The Graphs view of /admin/pool: the same numbers as the Details view, drawn so the answer reads at a glance. */

const dayLabel = (key: string) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const badTone = (r: number | null): Tone | undefined => (r === null ? undefined : r >= 0.05 ? "bad" : r >= 0.03 ? "warn" : "good");

const REASON: Record<AdminPoolView["burned"][number]["reasonKind"], string> = {
  bounces: "Too many bad emails",
  dkim: "DKIM record lost",
  seed: "Failed the seed test",
  other: "Other",
};

const SHARE_COLORS = [TONE.gold, RAMP.m1, TONE.ink2, RAMP.m3, TONE.ink3];

export function PoolGraphs({ data }: { data: AdminPoolView }) {
  const { charts, capacity, burn, shelf, atRisk, unmatched, footprint, authentication } = data;
  const impact = charts.burnImpact;
  const daily = charts.daily;
  const labels = daily.map((d) => dayLabel(d.day));

  // ── capacity ──
  const free = capacity.total - capacity.committed;
  const short = free < 0;
  const freeShare = capacity.total ? free / capacity.total : 0;
  const capTone: Tone = !capacity.total || short ? "bad" : freeShare < 0.15 ? "warn" : "good";
  const capVerdict = !capacity.total
    ? "No sending capacity yet. Add domains and mailboxes on the Domains page."
    : short
      ? `Not enough. Customers asked for ${n0(-free)} more emails a day than the pool can send.`
      : freeShare < 0.15
        ? `Tight. Only ${pct(freeShare, 0)} of today's capacity is free (${n0(free)} emails a day).`
        : `Enough. ${n0(free)} emails a day are free, room for ${plural(capacity.roomFor500PerDay, "more $20-a-day customer", "more $20-a-day customers")}.`;
  // Internal outreach only ever uses what is left over, so it never takes capacity away from customers and
  // must not eat into the free slice. It is called out underneath instead.
  const internal = Math.max(0, Math.min(capacity.internal, free));
  const meterParts = short
    ? [
        { label: "Covered", value: capacity.total, color: TONE.gold },
        { label: "Short", value: -free, color: TONE.bad },
      ]
    : [
        { label: "Customers", value: capacity.committed, color: TONE.gold },
        {
          label: "Free",
          value: free,
          color: "rgba(140, 203, 159, 0.45)",
        },
      ];
  const sentDays = daily.filter((d) => d.sends > 0);
  const avgSent = sentDays.length ? Math.round(sentDays.reduce((a, d) => a + d.sends, 0) / sentDays.length) : 0;
  const usedToday = capacity.total ? capacity.sentToday / capacity.total : 0;

  // ── burn ──
  const weeks = burn.weekly.slice(-12);
  const ewma = charts.ewma.slice(-12);
  const weekLabels = weeks.map((_, i) => {
    const back = weeks.length - 1 - i;
    return back === 0 ? "This wk" : dayLabel(new Date(new Date(data.cachedAt).getTime() - back * 7 * 86_400_000).toISOString().slice(0, 10));
  });
  const burnTone: Tone = impact.mailboxes === 0 ? "good" : "warn";
  const burnVerdict =
    impact.mailboxes === 0
      ? "Nothing is burned right now."
      : `${plural(impact.mailboxes, "mailbox", "mailboxes")} on ${plural(impact.domains, "domain")} burned. They still carry ${plural(impact.liveConversations, "live conversation")} for ${plural(impact.customersAffected, "customer")} and cost ${impact.monthlyCost} a month until they retire.`;
  const reasons = (Object.keys(REASON) as (keyof typeof REASON)[])
    .map((k) => ({
      label: REASON[k],
      value: data.burned.filter((b) => b.kind === "degraded" && b.reasonKind === k).length,
    }))
    .filter((r) => r.value > 0 || r.label !== "Other");
  const topReason = [...reasons].sort((a, b) => b.value - a.value)[0];
  const reasonTotal = reasons.reduce((a, r) => a + r.value, 0);
  const mb = charts.mailboxes;
  const dm = charts.domains;

  const rateOver = (n: number) => {
    const last = daily.slice(-n);
    const sends = last.reduce((a, d) => a + d.sends, 0);
    return sends ? last.reduce((a, d) => a + d.bad, 0) / sends : null;
  };
  const badToday = daily.length ? daily[daily.length - 1].badRate : null;
  const bad7 = rateOver(7);
  const bad30 = rateOver(30);
  const activeDomains = data.health.activeDomains;
  // Out of every domain that sent in the window: the ones still active plus the ones that burned.
  const sendingDomains = activeDomains + burn.degraded30;
  const burnRate30 = sendingDomains ? burn.degraded30 / sendingDomains : 0;
  const inService = mb.ACTIVE + mb.WARMING + mb.REPLIES_ONLY;
  const burnedShare = inService ? mb.REPLIES_ONLY / inService : 0;
  const canSend = mb.ACTIVE + mb.WARMING;
  const allBoxes = canSend + mb.CONNECTING + mb.ERROR + mb.REPLIES_ONLY + mb.RETIRED;

  // ── health ──
  const red = atRisk.filter((r) => r.risk >= 0.7).length;
  const amber = atRisk.length - red;
  const healthTone: Tone = red ? "bad" : amber ? "warn" : "good";
  const healthVerdict = red
    ? `${plural(red, "domain")} in the at-risk band, ${n0(amber)} more to watch.`
    : amber
      ? `No domain in the at-risk band. ${plural(amber, "domain")} to watch.`
      : "No domain scores as at risk.";

  // ── the rest ──
  const live = Object.entries(dm).reduce((a, [k, v]) => a + (k === "RETIRED" ? 0 : v), 0);
  const unverified = authentication.unverified.length;

  // ── the one thing to know ──
  const lead = shelf.targets.leadTimeWeeks;
  const spares = shelf.warmShelf;
  // With nothing burning there is no runway to state, only the number of spares.
  const runway = shelf.runwayWeeks;
  const runwayText = runway === null ? null : runway >= lead * 2 ? `${lead * 2}+` : runway.toFixed(1);
  const alerts: { tone: Tone; headline: string; body: ReactNode }[] = [];
  if (!capacity.total)
    alerts.push({
      tone: "bad",
      headline: "Nothing can send",
      body: <>The pool has no sending capacity. Add domains and mailboxes on the Domains page before anyone can be emailed.</>,
    });
  else if (short)
    alerts.push({
      tone: "bad",
      headline: "Out of capacity",
      body: (
        <>
          Customers asked for <b>{n0(-free)} more emails a day</b> than the pool can send. Until spare domains go live, some campaigns will not send everything they are paying for.
        </>
      ),
    });
  if (shelf.reorderNeeded)
    alerts.push({
      tone: "bad",
      headline: "Buy domains today",
      body: (
        <>
          There {spares === 1 ? "is" : "are"} <b>{plural(spares, "spare domain")}</b>
          {runwayText ? (
            <>
              , which last <b>{runwayText} weeks</b> at {burn.ewmaWeeklyBurn.toFixed(1)} burning a week
            </>
          ) : (
            <> against a minimum of {n0(shelf.targets.spareDomainsMin)}</>
          )}
          . A new domain needs about {lead} weeks to be ready, so buy <b>{plural(shelf.domainsToBuy, "domain")}</b> now.
        </>
      ),
    });
  if (red)
    alerts.push({
      tone: "bad",
      headline: "Domains in the at-risk band",
      body: (
        <>
          <b>{plural(red, "domain")}</b> scored 0.7 or more on bounces, complaints and how fast they are rising. Check those first. {amber ? `${n0(amber)} more sit in the watch band.` : ""}
        </>
      ),
    });
  if (bad30 !== null && bad30 >= 0.03)
    alerts.push({
      tone: bad30 >= 0.05 ? "bad" : "warn",
      headline: "Bad-email rate is high",
      body: (
        <>
          The pool averages <b>{exact(bad30)}</b> over 30 days (hard bounces, plus complaints counted ten times){bad30 >= 0.05 ? ", above 5%, the rate at which a single domain burns" : ", above 3%, where warming mailboxes stop moving up"}. Check
          the lists going out before sending more.
        </>
      ),
    });
  if (!short && capacity.total && freeShare < 0.15)
    alerts.push({
      tone: "warn",
      headline: "Capacity is tight",
      body: (
        <>
          Only <b>{n0(free)} emails a day</b> are free, {pct(freeShare, 0)} of the pool. There is room for {plural(capacity.roomFor500PerDay, "more $20-a-day customer", "more $20-a-day customers")}.
        </>
      ),
    });
  const hero = alerts[0] ?? {
    tone: "good" as Tone,
    headline: "The pool is healthy",
    body: (
      <>
        Capacity covers what customers asked for with <b>{n0(free)} emails a day</b> spare,{" "}
        {runwayText ? (
          <>
            the spare domains last <b>{runwayText} weeks</b> at the current burn,
          </>
        ) : (
          <>
            no domain has burned, <b>{plural(spares, "spare domain")}</b> {spares === 1 ? "is" : "are"} coming,
          </>
        )}{" "}
        and no domain scores as at risk.
      </>
    ),
  };

  return (
    <div className="pg">
      <Hero
        tone={hero.tone}
        headline={hero.headline}
        anchors={
          <>
            <Kpi label="Daily capacity" value={n0(capacity.total)} sub="emails a day the pool can send" spark={daily.map((d) => d.capacity)} sparkColor={TONE.gold} />
            <Kpi
              label={short ? "Short by" : "Free for new customers"}
              value={n0(Math.abs(free))}
              sub={short ? "emails a day more than we can send" : `room for ${plural(capacity.roomFor500PerDay, "more $20-a-day customer", "more $20-a-day customers")}`}
              tone={capTone}
            />
            <Kpi
              label="Burned mailboxes"
              value={n0(impact.mailboxes)}
              sub={`${exact(burnedShare)} of mailboxes · about ${n0(impact.capacityLost)} emails a day of capacity lost`}
              tone={impact.mailboxes ? "bad" : "good"}
            />
            <Kpi
              label="Live conversations on burned"
              value={n0(impact.liveConversations)}
              sub={`${plural(impact.sequencesRunning, "follow-up")} still going · ${plural(impact.customersAffected, "customer")}`}
              tone={impact.liveConversations + impact.sequencesRunning ? "warn" : "good"}
            />
          </>
        }
      >
        {hero.body}
        {alerts.length > 1 ? <em className="pg-hero-more">{plural(alerts.length - 1, "other thing", "other things")} to watch below.</em> : null}
      </Hero>

      <Section title="Capacity" verdict={<Verdict tone={capTone}>{capVerdict}</Verdict>}>
        <div className="pg-row wide">
          <Panel
            title="Today"
            hint="emails a day"
            read={
              !capacity.total ? (
                "No capacity yet, so nothing can be sent today."
              ) : capacity.sentToday ? (
                <>
                  <b>{n0(capacity.sentToday)}</b> sent so far today, {exact(usedToday)} of everything the pool can send.
                </>
              ) : (
                <>Nothing has gone out yet today. The pool can send {n0(capacity.total)}.</>
              )
            }
          >
            <Figures
              items={[
                { label: "Can send", value: n0(capacity.total) },
                { label: "Customers asked for", value: n0(capacity.committed) },
                { label: "Sent so far today", value: n0(capacity.sentToday) },
                {
                  label: short ? "Short" : "Free",
                  value: n0(Math.abs(free)),
                  tone: capTone,
                },
              ]}
            />
            <Meter parts={meterParts} total={Math.max(capacity.total, capacity.committed)} marker={capacity.total && capacity.sentToday ? { value: capacity.sentToday, label: "sent today" } : undefined} />
            {internal ? (
              <p className="pg-note">Internal outreach uses up to {n0(internal)} a day of the free capacity and hands it straight back when a customer needs it, so it never counts against what is free.</p>
            ) : null}
            <p className="pg-note">One domain sends at most {n0(capacity.domainDailyCap)} a day, so capacity grows only as warm domains go live.</p>
          </Panel>
          <Panel
            title="Last 30 days"
            hint="sent against capacity"
            read={
              avgSent ? (
                <>
                  The pool sent <b>{n0(avgSent)} a day</b> on the days it sent anything. The dashed line is what it can send, the dotted line is what customers asked for, so the space between them is room for new
                  customers.
                </>
              ) : (
                "Nothing has been sent in the last 30 days."
              )
            }
          >
            <LineChart
              labels={labels}
              endLabel
              series={[
                {
                  key: "sends",
                  label: "Sent",
                  color: TONE.gold,
                  values: daily.map((d) => d.sends),
                  area: true,
                },
                {
                  key: "capacity",
                  label: "Capacity",
                  color: TONE.ink3,
                  values: daily.map((d) => d.capacity),
                  ref: true,
                },
                {
                  key: "committed",
                  label: "Asked for",
                  color: TONE.ink4,
                  values: daily.map((d) => d.committed),
                  ref: true,
                },
              ]}
              counts
              empty="No emails sent in the last 30 days."
            />
            <Legend
              items={[
                { label: "Sent", color: TONE.gold },
                { label: "Capacity", color: TONE.ink3, dashed: true },
                {
                  label: "Customers asked for",
                  color: TONE.ink4,
                  dashed: true,
                },
              ]}
            />
          </Panel>
        </div>
      </Section>

      <Section title="Burned" verdict={<Verdict tone={burnTone}>{burnVerdict}</Verdict>}>
        <Panel
          title="What the pool is made of"
          hint={`${plural(allBoxes, "mailbox", "mailboxes")}`}
          read={
            allBoxes ? (
              <>
                <b>{n0(canSend)}</b> of {n0(allBoxes)} mailboxes can send. {n0(mb.REPLIES_ONLY)} {mb.REPLIES_ONLY === 1 ? "is" : "are"} burned and only carry replies, {exact(burnedShare)} of everything in
                service.
              </>
            ) : (
              "No mailboxes yet."
            )
          }
        >
          <StackBar
            unit="mailboxes"
            empty="No mailboxes yet. Add domains on the Domains page."
            parts={[
              { label: "Sending", value: mb.ACTIVE, color: RAMP.m1, note: "earning now" },
              { label: "Warming up", value: mb.WARMING, color: RAMP.m2, note: "small volumes, building reputation" },
              { label: "Setting up", value: mb.CONNECTING + mb.ERROR, color: RAMP.m3, note: "bought, not sending yet" },
              { label: "Burned", value: mb.REPLIES_ONLY, color: TONE.bad, note: "replies only" },
              { label: "Retired", value: mb.RETIRED, color: TONE.ink4, note: "switched off" },
            ]}
          />
        </Panel>
        <div className="pg-row c2">
          <Panel
            title="What burned mailboxes still carry"
            hint="right now"
            read={
              impact.mailboxes ? (
                <>
                  Burned mailboxes took away about <b>{n0(impact.capacityLost)} emails a day</b> of capacity and still cost <b>{money(impact.monthlyCostCents)} a month</b>, while holding {plural(impact.liveConversations, "live conversation")}{" "}
                  that cannot be moved.
                </>
              ) : (
                "Nothing is burned, so nothing is being paid for or held."
              )
            }
          >
            <Figures
              items={[
                {
                  label: "Capacity lost, a day",
                  value: n0(impact.capacityLost),
                  tone: impact.capacityLost ? "bad" : undefined,
                },
                {
                  label: "We still pay a month",
                  value: money(impact.monthlyCostCents),
                  tone: impact.monthlyCostCents ? "warn" : undefined,
                },
                {
                  label: "Live conversations",
                  value: n0(impact.liveConversations),
                  tone: impact.liveConversations ? "warn" : undefined,
                },
                {
                  label: "Follow-ups still going",
                  value: n0(impact.sequencesRunning),
                },
                {
                  label: "Customers affected",
                  value: n0(impact.customersAffected),
                },
                { label: "Burned domains", value: n0(impact.domains) },
              ]}
            />
            <p className="pg-note">A burned mailbox stops new cold email but keeps answering everyone already talking to it, so no conversation is lost. It is billed until it retires.</p>
          </Panel>
          <Panel
            title="Why they burned"
            hint="last 30 days"
            read={
              reasonTotal && topReason ? (
                <>
                  <b>{topReason.label.toLowerCase()}</b> caused {topReason.value} of the {reasonTotal} domains lost in the last 30 days.
                </>
              ) : (
                "No domain burned in the last 30 days."
              )
            }
          >
            {reasons.some((r) => r.value) ? <HBars rows={reasons.map((r) => ({ ...r, color: TONE.bad }))} /> : <p className="pg-empty">No domain burned in the last 30 days.</p>}
            <h4 className="pg-sub">Domains by stage</h4>
            <Meter
              parts={[
                {
                  label: "Aging",
                  value: dm.AGING + dm.REGISTERED,
                  color: RAMP.m3,
                },
                { label: "Warming", value: dm.WARMING, color: RAMP.m2 },
                { label: "Active", value: dm.ACTIVE, color: RAMP.m1 },
                { label: "Burned", value: dm.DEGRADED, color: TONE.bad },
                { label: "Retired", value: dm.RETIRED, color: TONE.ink4 },
              ]}
              total={0}
            />
          </Panel>
        </div>
        <Panel
          title="Domains burned per week"
          hint={`${n0(burn.predicted30.total)} expected in the next 30 days`}
          read={
            burn.ewmaWeeklyBurn && runwayText ? (
              <>
                Burn averages <b>{burn.ewmaWeeklyBurn.toFixed(1)} a week</b>. At that rate the {plural(spares, "spare domain")} {spares === 1 ? "lasts" : "last"} <b>{runwayText} weeks</b>, against the roughly {lead} weeks a
                new domain needs to be ready.
              </>
            ) : (
              "No domain has burned yet, so there is no burn rate to project."
            )
          }
        >
          <Figures
            cols={4}
            items={[
              { label: "Burn rate, 30 days", value: exact(burnRate30), tone: burnRate30 >= 0.2 ? "bad" : burnRate30 >= 0.1 ? "warn" : "good" },
              { label: "Burned this week", value: n0(burn.degraded7), tone: burn.degraded7 ? "warn" : undefined },
              { label: "Burned in 30 days", value: n0(burn.degraded30) },
              { label: "Average a week", value: burn.ewmaWeeklyBurn.toFixed(2) },
            ]}
          />
          <BarChart
            valueLabels
            labels={weekLabels}
            values={weeks}
            color={TONE.bad}
            unit="burned"
            line={ewma.length === weeks.length && weeks.length ? { label: "Running average", values: ewma, color: TONE.ink3 } : undefined}
            forecast={
              weeks.length
                ? {
                    label: "Next wk",
                    value: Number(burn.ewmaWeeklyBurn.toFixed(1)),
                  }
                : undefined
            }
            empty="No domain has burned yet."
          />
          <Legend
            items={[
              { label: "Burned", color: TONE.bad },
              { label: "Running average", color: TONE.ink3, dashed: true },
              {
                label: "Next week, forecast",
                color: TONE.bad,
                dashed: true,
              },
            ]}
          />
        </Panel>
      </Section>

      <Section title="Health" verdict={<Verdict tone={healthTone}>{healthVerdict}</Verdict>}>
        <div className="pg-row c2">
          <Panel
            title="Bad emails, whole pool"
            hint="hard bounces plus complaints counted ten times, per email"
            read={
              bad30 === null ? (
                "Nothing has been sent in the last 30 days, so there is no rate yet."
              ) : (
                <>
                  The pool averages <b>{exact(bad30)}</b> over 30 days,{" "}
                  {bad30 >= 0.05 ? "above 5%, the rate at which a single domain burns" : bad30 >= 0.03 ? "above 3%, where warming mailboxes stop moving up" : "under 3%"}. Each domain is judged on its own last 200 emails, so one
                  domain can burn while the pool average stays low.
                </>
              )
            }
          >
            <Figures
              cols={3}
              items={[
                { label: "Today", value: badToday === null ? "no sends" : exact(badToday), tone: badTone(badToday) },
                { label: "Last 7 days", value: bad7 === null ? "no sends" : exact(bad7), tone: badTone(bad7) },
                { label: "Last 30 days", value: bad30 === null ? "no sends" : exact(bad30), tone: badTone(bad30) },
              ]}
            />
            <LineChart
              endLabel
              labels={labels}
              series={[
                {
                  key: "bad",
                  label: "Bad rate",
                  color: TONE.gold,
                  values: daily.map((d) => d.badRate),
                  area: true,
                },
              ]}
              format={exact}
              thresholds={[
                { value: 0.03, label: "3% warmup holds", color: TONE.warn },
                { value: 0.05, label: "5% a domain burns", color: TONE.bad },
              ]}
              max={Math.max(0.06, ...daily.map((d) => d.badRate ?? 0))}
              empty="No emails sent in the last 30 days."
            />
          </Panel>
          <Panel
            title="Risk by domain"
            hint="a score from 0 (safe) to 1, not a forecast"
            read={
              atRisk.length ? (
                <>
                  <b>{plural(red, "domain")}</b> {red === 1 ? "sits" : "sit"} in the at-risk band (0.7 or more). {amber ? `${n0(amber)} more are in the watch band (0.4 to 0.7).` : "Nothing else is close."}
                </>
              ) : (
                "No domain is scored as at risk."
              )
            }
          >
            {atRisk.length ? (
              <HBars
                mono
                rows={atRisk.slice(0, 8).map((r) => ({
                  label: r.domain,
                  value: r.risk,
                  color: r.risk >= 0.7 ? TONE.bad : TONE.warn,
                  note: `${r.bounce7} bounces and complaints this week · ${r.band}`,
                }))}
                max={1}
                format={(v) => v.toFixed(2)}
                markers={[
                  { value: 0.4, label: "Watch", color: TONE.warn },
                  { value: 0.7, label: "At risk", color: TONE.bad },
                ]}
              />
            ) : (
              <p className="pg-empty">No domain is at risk. Domains with fewer than 200 emails in 30 days are not scored yet.</p>
            )}
          </Panel>
        </div>
      </Section>

      <ShelfSection data={data} />

      <CostSection s={data.economics} />

      <Section
        title="Mixing and safety"
        verdict={<Verdict tone={burn.dilution !== null && burn.dilution < 10 ? "warn" : "good"}>{burn.dilution === null ? "Not enough sending yet to measure mixing." : `Each domain carries ${burn.dilution.toFixed(1)} customers a day.`}</Verdict>}
      >
        <div className="pg-row c3">
          <Panel
            title="Mixing"
            hint="customers per domain per day"
            read={
              burn.dilution === null ? (
                "Not enough sending yet to measure how customers are mixed across domains."
              ) : (
                <>
                  Each domain carries <b>{burn.dilution.toFixed(1)} customers a day</b>, which counts as {burn.dilutionRegime.toLowerCase()}. At ten or more, one customer&apos;s bad list is only a small share of any
                  domain&apos;s mail.
                </>
              )
            }
          >
            <div className="pg-big">
              <b>{burn.dilution === null ? "n/a" : burn.dilution.toFixed(1)}</b>
              <span>{burn.dilutionRegime}</span>
            </div>
            <Bullet
              value={Math.min(burn.dilution ?? 0, 40)}
              target={10}
              targetLabel="10 is working"
              max={40}
              format={(v) => v.toFixed(0)}
              color={TONE.gold}
              bands={[
                {
                  to: 2,
                  color: "rgba(229,131,111,.28)",
                  label: "No protection",
                },
                { to: 10, color: "rgba(227,178,92,.22)", label: "Weak" },
                { to: 30, color: "rgba(212,174,114,.14)", label: "Working" },
                {
                  to: 40,
                  color: "rgba(140,203,159,.18)",
                  label: "Fully mixed",
                },
              ]}
            />
            <p className="pg-note">More customers on each domain means one bad list hurts any domain less.</p>
          </Panel>
          <Panel
            title="Authentication"
            hint="SPF, DKIM and DMARC"
            read={
              live ? (
                unverified ? (
                  <>
                    <b>{plural(unverified, "domain")}</b> {unverified === 1 ? "is" : "are"} missing a record. A domain without all three is far more likely to land in spam.
                  </>
                ) : (
                  <>
                    All <b>{n0(live)}</b> live domains pass SPF, DKIM and DMARC.
                  </>
                )
              ) : (
                "No live domains yet."
              )
            }
          >
            <Donut
              size={140}
              parts={[
                {
                  label: "All three pass",
                  value: Math.max(0, live - unverified),
                  color: TONE.gold,
                },
                {
                  label: "Missing a record",
                  value: unverified,
                  color: TONE.bad,
                },
              ]}
              center={n0(live)}
              sub="domains"
            />
          </Panel>
          <Panel
            title="Unmatched replies"
            hint={`${n0(unmatched.open)} waiting`}
            read={
              unmatched.open ? (
                <>
                  <b>{plural(unmatched.open, "reply", "replies")}</b> could not be matched to a contact and {unmatched.open === 1 ? "is" : "are"} waiting for someone to look at {unmatched.open === 1 ? "it" : "them"}.
                </>
              ) : (
                "Every reply was matched to a contact. Nothing is waiting."
              )
            }
          >
            <LineChart
              labels={unmatched.daily.map((d) => dayLabel(d.day))}
              series={[
                {
                  key: "open",
                  label: "Waiting",
                  color: TONE.gold,
                  values: unmatched.daily.map((d) => d.open),
                  area: true,
                },
              ]}
              height={150}
              counts
              endLabel
              empty="Nothing waiting."
            />
          </Panel>
        </div>
        <div className="pg-row c3">
          {(
            [
              ["registrar", "Registrars"],
              ["nameserverSet", "DNS providers"],
              ["ipPool", "Sending servers"],
            ] as const
          ).map(([k, title]) => (
            <Panel
              key={k}
              title={title}
              hint="share of domains"
              read={
                footprint[k].length ? (
                  <>
                    The biggest holds <b>{footprint[k][0].share}</b> of domains. Spreading them out means one provider going bad cannot take the pool with it.
                  </>
                ) : (
                  "No domains yet."
                )
              }
            >
              {footprint[k].length ? (
                <Meter
                  parts={footprint[k].map((f, i) => ({
                    label: f.value,
                    value: f.domains,
                    color: SHARE_COLORS[i % SHARE_COLORS.length],
                  }))}
                  total={0}
                />
              ) : (
                <p className="pg-empty">No domains yet.</p>
              )}
            </Panel>
          ))}
        </div>
      </Section>
      <p className="pg-foot">Live conversations: people who replied in the last 30 days and are tied to a burned mailbox. The bad-email rate counts a complaint as ten hard bounces, the same way the burn rule does.</p>
    </div>
  );
}
