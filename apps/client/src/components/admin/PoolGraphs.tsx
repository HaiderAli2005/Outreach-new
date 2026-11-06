"use client";

import { CostSection } from "./CostStack";
import type { ReactNode } from "react";
import { money, n0 } from "@/lib/format";
import type { AdminPoolView } from "@/lib/types";
import { BarChart, Donut, HBars, Legend, LineChart, Meter, RAMP, StackBar, TONE } from "./charts";
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

/**
 * The three lines on "Last 30 days", one hue each. Checked together on the dark panel surface for lightness,
 * chroma, colour-blind separation and contrast; the brand gold itself is too pale to pass as a line colour.
 */
const SENT_COLOR = "#c98500";
const CAPACITY_COLOR = "#3987e5";
const ASKED_COLOR = "#d55181";

const SHARE_COLORS =[TONE.gold, RAMP.m1, TONE.ink2, RAMP.m3, TONE.ink3];

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
  // The 30 days in one read: how capacity moved, and on how many days customers asked for more than it could send.
  const caps = daily.map((d) => d.capacity).filter((v): v is number => v !== null);
  const capFrom = caps.find((v) => v > 0) ?? caps[0] ?? null;
  const capTo = caps.length ? caps[caps.length - 1] : null;
  const shortDays = daily.filter((d) => d.capacity !== null && d.committed !== null && d.committed > d.capacity).length;
  const usedToday = capacity.total ? capacity.sentToday / capacity.total : 0;

  // ── burn ──
  const weeks = burn.weekly.slice(-12);
  const weekLabels = weeks.map((_, i) => {
    const back = weeks.length - 1 - i;
    return back === 0 ? "This wk" : dayLabel(new Date(new Date(data.cachedAt).getTime() - back * 7 * 86_400_000).toISOString().slice(0, 10));
  });
  // Anything burned now, in the last 30 days, or in the weeks the chart covers.
  const anyBurn = impact.mailboxes > 0 || impact.domains > 0 || burn.degraded30 > 0 || weeks.some((w) => w > 0);
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
  // Health is the bad-email rate. Domains on the way to burning are shown, and judged, in the Burned section.
  const healthTone: Tone = bad30 === null ? "good" : badTone(bad30) ?? "good";
  const healthVerdict =
    bad30 === null ? "Nothing sent in the last 30 days." : bad30 >= 0.05 ? `Bad emails at ${exact(bad30)}, above 5%.` : bad30 >= 0.03 ? `Bad emails at ${exact(bad30)}, above 3%.` : `Bad emails at ${exact(bad30)}, under 3%.`;
  // The Burned section answers two things: what has burned, and what is on the way.
  const burnedSectionTone: Tone = impact.mailboxes || red ? "bad" : amber ? "warn" : "good";
  const burnedSectionVerdict = impact.mailboxes
    ? `${burnVerdict}${red ? ` ${plural(red, "more domain")} on the way.` : ""}`
    : red
      ? `Nothing burned. ${plural(red, "domain")} on the way to burning, ${n0(amber)} more to watch.`
      : amber
        ? `Nothing burned. ${plural(amber, "domain")} to watch.`
        : "Nothing is burned and no domain is close.";

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
              capTo === null ? (
                "No capacity was recorded in the last 30 days."
              ) : (
                <>
                  {capFrom !== null && capFrom !== capTo ? (
                    <>
                      Capacity went from <b>{n0(capFrom)}</b> to <b>{n0(capTo)} a day</b>.{" "}
                    </>
                  ) : (
                    <>
                      Capacity held at <b>{n0(capTo)} a day</b>.{" "}
                    </>
                  )}
                  {shortDays ? (
                    <>
                      Customers asked for more than it could send on <b>{plural(shortDays, "day")}</b>.{" "}
                    </>
                  ) : (
                    "It covered what customers asked for every day. "
                  )}
                  {avgSent ? <>On days it sent, it sent {n0(avgSent)} a day.</> : "Nothing was sent."}
                </>
              )
            }
          >
            <LineChart
              labels={labels}
              endLabels
              series={[
                // Sent last so its line and area draw on top of the other two.
                // Levels move in steps (a domain goes live, a customer launches), so they are drawn as steps, not slopes.
                { key: "capacity", label: "Capacity", color: CAPACITY_COLOR, values: daily.map((d) => d.capacity), step: true },
                { key: "committed", label: "Asked for", color: ASKED_COLOR, values: daily.map((d) => d.committed), step: true },
                { key: "sends", label: "Sent", color: SENT_COLOR, values: daily.map((d) => d.sends), area: true },
              ]}
              counts
              empty="No emails sent in the last 30 days."
            />
            <Legend
              items={[
                { label: "Sent", color: SENT_COLOR },
                { label: "Capacity", color: CAPACITY_COLOR },
                { label: "Customers asked for", color: ASKED_COLOR },
              ]}
            />
          </Panel>
        </div>
        {/* What the pool is made of decides what it can send, so it lives with capacity, not under "Burned". */}
        <Panel
          title="What the pool is made of"
          hint={`${plural(allBoxes, "mailbox", "mailboxes")}`}
          read={
            allBoxes ? (
              <>
                <b>{n0(canSend)}</b> of {n0(allBoxes)} mailboxes can send (sending or warming up).
                {mb.CONNECTING + mb.ERROR ? ` ${n0(mb.CONNECTING + mb.ERROR)} ${mb.CONNECTING + mb.ERROR === 1 ? "is" : "are"} still being set up.` : ""}
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
          <h4 className="pg-sub">Domains by stage</h4>
          <Meter
            parts={[
              { label: "Aging", value: dm.AGING + dm.REGISTERED, color: RAMP.m3 },
              { label: "Warming", value: dm.WARMING, color: RAMP.m2 },
              { label: "Active", value: dm.ACTIVE, color: RAMP.m1 },
              { label: "Burned", value: dm.DEGRADED, color: TONE.bad },
              { label: "Retired", value: dm.RETIRED, color: TONE.ink4 },
            ]}
            total={0}
          />
        </Panel>
      </Section>

      {/* Only burned things live here. With nothing burned there is one plain sentence, not a wall of zeros. */}
      <Section title="Burned" verdict={<Verdict tone={burnedSectionTone}>{burnedSectionVerdict}</Verdict>}>
        <Panel
          title="On the way to burning"
          hint="risk score from 0 (safe) to 1, not a forecast"
          read={
            atRisk.length ? (
              <>
                <b>{plural(red, "domain")}</b> {red === 1 ? "sits" : "sit"} in the at-risk band (0.7 or more): check {red === 1 ? "it" : "them"} first.{" "}
                {amber ? `${n0(amber)} more ${amber === 1 ? "is" : "are"} in the watch band (0.4 to 0.7).` : "Nothing else is close."} The score mixes this week&apos;s bounces and complaints with how fast they are rising.
              </>
            ) : (
              "No domain is on the way to burning."
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
            <p className="pg-empty">Every scored domain is healthy. Domains with fewer than 200 emails in 30 days are not scored yet.</p>
          )}
        </Panel>
        {!anyBurn ? (
          <Panel title="Nothing has burned" hint="last 12 weeks">
            <p className="pg-empty">
              No mailbox or domain has burned in the last 12 weeks. A burned mailbox stops new cold email and only answers people already talking to it. When one burns, this section shows each burned
              domain with the conversations it still carries, what it costs, why it burned and how many burn each week.
            </p>
          </Panel>
        ) : (
        <>
        <Panel
          title="Burned domains still carrying conversations"
          hint="right now"
          read={
            impact.byDomain.length ? (
              <>
                These burned mailboxes send no new cold email but still answer the people below, so those conversations are never lost. Each burned mailbox is billed until it retires.
              </>
            ) : (
              "No burned mailbox is carrying a conversation right now."
            )
          }
        >
          {impact.byDomain.length ? (
            <div className="tbl-scroll">
              <table className="tbl cs-tbl">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Burned on</th>
                    <th className="right">Burned mailboxes</th>
                    <th className="right">Live conversations</th>
                    <th className="right">Follow-ups still going</th>
                    <th className="right">Customers</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.byDomain.map((d) => (
                    <tr key={d.domain}>
                      <td className="mono">
                        {d.domain}
                        {d.domainBurned ? null : <small> mailbox only, domain still sending</small>}
                      </td>
                      <td>{d.burnedOn ? dayLabel(d.burnedOn.slice(0, 10)) : "–"}</td>
                      <td className="right mono">{n0(d.mailboxes)}</td>
                      <td className={`right mono${d.liveConversations ? " bad" : ""}`}>{n0(d.liveConversations)}</td>
                      <td className="right mono">{n0(d.sequencesRunning)}</td>
                      <td className="right mono">{n0(d.customers)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
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
          </Panel>
        <Panel
          title="Domains burned per week"
          hint="what actually burned"
          read={
            burn.degraded30 ? (
              <>
                <b>{plural(burn.degraded30, "domain")}</b> burned in the last 30 days{burn.degraded7 ? <>, {n0(burn.degraded7)} of them this week</> : ", none this week"}.
              </>
            ) : (
              "No domain burned in the last 30 days."
            )
          }
        >
          <Figures
            cols={3}
            items={[
              { label: "Burn rate, 30 days", value: exact(burnRate30), tone: burnRate30 >= 0.2 ? "bad" : burnRate30 >= 0.1 ? "warn" : "good" },
              { label: "Burned this week", value: n0(burn.degraded7), tone: burn.degraded7 ? "warn" : undefined },
              { label: "Burned in 30 days", value: n0(burn.degraded30) },
            ]}
          />
          <BarChart valueLabels labels={weekLabels} values={weeks} color={TONE.bad} unit="burned" empty="No domain has burned yet." />
        </Panel>
        </>
        )}
      </Section>

      <Section title="Health" verdict={<Verdict tone={healthTone}>{healthVerdict}</Verdict>}>
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
      </Section>

      <ShelfSection data={data} />

      <CostSection s={data.economics} />

      <Section
        title="Safety"
        verdict={<Verdict tone={unverified || unmatched.open ? "warn" : "good"}>{unverified ? `${plural(unverified, "domain")} missing a DNS record` : unmatched.open ? `${plural(unmatched.open, "reply", "replies")} waiting to be matched` : "Every domain authenticated, no reply waiting"}</Verdict>}
      >
        <div className="pg-row c2">
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
