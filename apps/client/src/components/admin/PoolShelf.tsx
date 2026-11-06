"use client";

import { n0 } from "@/lib/format";
import type { AdminPoolView } from "@/lib/types";
import { TONE } from "./charts";
import { Panel, plural, Section, Verdict, type Tone } from "./poolParts";

/**
 * The shelf in the Graphs view: the spare domains still aging or warming, how long they last at the current burn,
 * when each one goes live, and how many to buy.
 */

const DAY = 86_400_000;
const dateOf = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

type Driver = NonNullable<AdminPoolView["shelf"]["reorderBecause"]["driver"]>;

export function ShelfSection({ data }: { data: AdminPoolView }) {
  const { shelf, burn, charts } = data;
  const t = shelf.targets;
  const now = new Date(data.cachedAt).getTime();
  const lifeDays = t.agingDays + t.warmupDays;
  const lead = t.leadTimeWeeks;
  const ewma = burn.ewmaWeeklyBurn;
  const rows = shelf.warming;
  const spares = shelf.warmShelf;
  const enough = spares >= t.spareDomainsMin;
  const runway = shelf.runwayWeeks;
  const runwayText = runway === null ? null : runway >= lead * 2 ? `${lead * 2}+` : runway.toFixed(1);
  const tone: Tone = shelf.reorderNeeded ? "bad" : "good";

  // A domain bought today sends nothing for its quiet days, then small warmup amounts, then full volume.
  const warmsIfBoughtToday = dateOf(now + t.agingDays * DAY);
  const readyIfBoughtToday = dateOf(now + lifeDays * DAY);

  const r = shelf.reorderBecause;
  const most = Math.max(r.burnReplacement, r.spareShortfall, r.demandShortfall);
  // Each reason in one plain line. The number on the right is what it would buy on its own.
  const checks: { key: Driver; text: string; need: number }[] = [
    {
      key: "spareShortfall",
      text: r.spareShortfall ? `Below the minimum: ${n0(spares)} of ${n0(t.spareDomainsMin)} spares` : `At least ${n0(t.spareDomainsMin)} spare domains ready`,
      need: r.spareShortfall,
    },
    {
      key: "burnReplacement",
      text:
        ewma === 0 || runwayText === null
          ? "No domain has burned yet, so none to replace"
          : r.burnReplacement
            ? `Spares last ${runwayText} weeks, a new one takes ${lead}`
            : `Spares last ${runwayText} weeks, longer than the ${lead} a new one takes`,
      need: r.burnReplacement,
    },
    {
      key: "demandShortfall",
      text: r.demandShortfall ? "Customers want more emails than the pool can send" : "Customers fit in today's capacity",
      need: r.demandShortfall,
    },
  ];

  const stages = [
    { label: "Aging", detail: `${t.agingDays} quiet days, no email yet`, count: shelf.pipeline.aging ?? 0, color: TONE.ink3 },
    { label: "Warmup days 1 to 7", detail: "5 emails a day per mailbox", count: shelf.pipeline["d1-7"] ?? 0, color: TONE.gold },
    { label: "Days 8 to 14", detail: "10 a day per mailbox", count: shelf.pipeline["d8-14"] ?? 0, color: TONE.gold },
    { label: "Days 15 to 21", detail: "20 a day per mailbox", count: shelf.pipeline["d15-21"] ?? 0, color: TONE.gold },
    { label: `Days 22 to ${t.warmupDays}`, detail: "30 a day, live within a week", count: shelf.pipeline["d22-28"] ?? 0, color: TONE.gold },
    { label: "Active", detail: "sending at full volume", count: charts.domains.ACTIVE, color: TONE.good },
  ];

  const held = rows.filter((x) => x.held).length;
  const shown = rows.slice(0, 10);
  const agingShare = (t.agingDays / lifeDays) * 100;

  const verdict = shelf.reorderNeeded ? `Buy ${plural(shelf.domainsToBuy, "domain")} today.` : `Nothing to buy. ${plural(spares, "spare")} on the shelf.`;

  return (
    <Section title="Spare domains and restock" verdict={<Verdict tone={tone}>{verdict}</Verdict>}>
      <Panel title="Restock" hint={`buys at most ${n0(t.maxBuyPerBatch)} at a time`}>
        <div className="rs">
          <div className="rs-stock">
            <small>Spare domains</small>
            <div className="rs-count">
              <b className={enough ? "good" : "bad"}>{n0(spares)}</b>
              <span>of {n0(t.spareDomainsMin)} minimum</span>
            </div>
            <div className="rs-bar" role="img" aria-label={`${n0(spares)} spare domains of a ${n0(t.spareDomainsMin)} minimum`}>
              <span className={enough ? "good" : "bad"} style={{ width: `${Math.min(100, t.spareDomainsMin ? (spares / t.spareDomainsMin) * 100 : 100)}%` }} />
            </div>
            <ul className="rs-parts">
              <li>
                <b>{n0(shelf.pipeline.aging ?? 0)}</b> aging
              </li>
              <li>
                <b>{n0(spares - (shelf.pipeline.aging ?? 0))}</b> warming
              </li>
              <li>
                <b>{n0(rows.filter((x) => x.daysRemaining <= 7).length)}</b> live this week
              </li>
              <li className={held ? "bad" : ""}>
                <b>{n0(held)}</b> stuck
              </li>
            </ul>
            <p className="rs-note">Spares are domains already bought that are not sending yet. A new one takes about {lead} weeks to be ready: {t.agingDays} quiet days, then {t.warmupDays} days of warmup.</p>
          </div>

          <div className="rs-decide">
            <small>Today</small>
            <div className={`rs-answer ${tone}`}>{shelf.domainsToBuy ? `Buy ${plural(shelf.domainsToBuy, "domain")}` : "Nothing to buy"}</div>
            <p className="rs-when">
              {shelf.domainsToBuy ? `Bought today, they start warming up around ${warmsIfBoughtToday} and reach full volume around ${readyIfBoughtToday}.` : "Spare domains, burn and customer demand are all covered."}
            </p>
            <ul className="rs-why">
              {checks.map((c) => (
                <li key={c.key} className={c.need ? "need" : "ok"}>
                  <i aria-hidden>{c.need ? "!" : "✓"}</i>
                  <span>{c.text}</span>
                  <em>{c.need ? `+${n0(c.need)}` : "ok"}</em>
                </li>
              ))}
            </ul>
            {shelf.domainsToBuy && most > shelf.domainsToBuy ? <p className="rs-cap">The biggest need is {n0(most)}. We buy {n0(t.maxBuyPerBatch)} at a time, so the rest comes in the next batch.</p> : null}
          </div>
        </div>
      </Panel>

        <Panel title="Stages" hint="where every domain is" read={<>Every domain walks this ladder once: {t.agingDays} quiet days, then {t.warmupDays} days of growing volume, then live.</>}>
          <ol className="pg-steps">
            {stages.map((s) => (
              <li key={s.label}>
                <i style={{ background: s.color }} />
                <div>
                  <b>{s.label}</b>
                  <span>{s.detail}</span>
                </div>
                <em className={s.count ? "" : "zero"}>{n0(s.count)}</em>
              </li>
            ))}
          </ol>
        </Panel>

      <Panel
        title="Every spare domain"
        hint="soonest live first"
        read={rows.length ? <>Each bar is how far one domain has walked from bought to live. <b>{n0(rows.filter((x) => x.daysRemaining <= 7).length)}</b> go live within 7 days.</> : undefined}
      >
        {rows.length ? (
          <div className="pg-gantt">
            <div className="scale">
              <span />
              <div>
                <span style={{ width: `${agingShare}%` }}>Aging · {t.agingDays} days</span>
                <span>Warmup · {t.warmupDays} days</span>
              </div>
              <span>Goes live</span>
            </div>
            {shown.map((x) => {
              const done = Math.max(0, Math.min(100, ((lifeDays - x.daysRemaining) / lifeDays) * 100));
              return (
                <div className={`row${x.held ? " held" : ""}`} key={x.id}>
                  <div className="name">
                    <b>{x.domain}</b>
                    <small>{x.held ? `held ${x.behindDays} days` : x.status === "AGING" ? "aging" : `warmup day ${x.warmupDay} of ${t.warmupDays}`}</small>
                  </div>
                  <div className="bar">
                    <i style={{ width: `${agingShare}%` }} />
                    <span style={{ width: `${done}%` }} />
                  </div>
                  <div className="when">
                    <b>{x.daysRemaining ? `in ${plural(x.daysRemaining, "day")}` : "today"}</b>
                    <small>{dateOf(new Date(x.activeOn).getTime())}</small>
                  </div>
                </div>
              );
            })}
            {rows.length > shown.length ? <p className="pg-note">and {n0(rows.length - shown.length)} more on the Details tab.</p> : null}
          </div>
        ) : (
          <p className="pg-empty">No spare domains. One bought today starts warming up around {warmsIfBoughtToday} and reaches full volume around {readyIfBoughtToday}.</p>
        )}
      </Panel>
    </Section>
  );
}
