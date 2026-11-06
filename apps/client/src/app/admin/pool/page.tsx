"use client";

import { usd } from "@/components/admin/CostStack";
import { useState } from "react";
import { Button, Chip, Empty, ErrorState, Notice, Seg, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { useToast } from "@/store";
import Link from "next/link";
import { errorMessage, useAdminDecideReorderMutation, useAdminPoolQuery, useAdminPoolRecomputeMutation, useAdminResumeDomainMutation } from "@/store/api";
import { ago, n0, titleCase } from "@/lib/format";
import type { AdminPoolView } from "@/lib/types";
import { BurnedTable, DRIVER_TEXT, ForcedTable, PoolSettingsPanel, WarmingTable } from "@/components/admin/PoolOperator";
import { PoolGraphs } from "@/components/admin/PoolGraphs";

const REORDER_TONE: Record<AdminPoolView["reorders"][number]["status"], "g" | "b" | "v" | "y" | "r"> = { PENDING: "y", APPROVED: "b", DONE: "g", DISMISSED: "v" };
const PIPE: [string, string][] = [
  ["aging", "Aging (quiet days)"],
  ["d1-7", "Warmup days 1 to 7"],
  ["d8-14", "Days 8 to 14"],
  ["d15-21", "Days 15 to 21"],
  ["d22-28", "Day 22 and on"],
];

/** A tiny bar chart, oldest first. */
function Burn({ weekly, what = "domains burned per week", unit = "burned", take = 12 }: { weekly: number[]; what?: string; unit?: string; take?: number }) {
  const last = weekly.slice(-take);
  const max = Math.max(1, ...last);
  if (!last.length) return <p className="m">Nothing recorded yet.</p>;
  return (
    <div className="pool-burn" role="img" aria-label={`${what}, last ${last.length}: ${last.join(", ")}`}>
      {last.map((w, i) => (
        <span key={i} style={{ height: `${Math.max(4, (w / max) * 100)}%` }} title={`${w} ${unit}`} />
      ))}
    </div>
  );
}

/** "4.0 weeks", or why there is no runway: with nothing burning there is no rate to measure it by. */
const runwayText = (w: number | null) => (w === null ? "no burn yet" : `${w.toFixed(1)} weeks`);

export default function AdminPool() {
  const { data, isLoading, isError, error, refetch } = useAdminPoolQuery(undefined, { pollingInterval: 60_000 });
  const [recompute, recomputing] = useAdminPoolRecomputeMutation();
  const [decide] = useAdminDecideReorderMutation();
  const [resume] = useAdminResumeDomainMutation();

  const [view, setView] = useState<"graphs" | "details">("graphs");
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const toast = useToast();

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data) return <SkeletonRows rows={5} h={90} />;

  const act = (id: string, approve: boolean) => {
    setBusy(`${id}:${approve}`);
    decide({ id, approve, note: notes[id]?.trim() || undefined })
      .unwrap()
      .then(() => toast(approve ? "Noted. Add the domains on the Domains page; this closes by itself once they are in." : "Dismissed.", "good"))
      .catch((e) => toast(errorMessage(e), "bad"))
      .finally(() => setBusy(null));
  };

  const resumeDomain = (id: string, domain: string) => {
    setBusy(`resume:${id}`);
    resume({ id, reason: notes[id]?.trim() ?? "" })
      .unwrap()
      .then(() => toast(`${domain} is sending again.`, "good"))
      .catch((e) => toast(errorMessage(e), "bad"))
      .finally(() => setBusy(null));
  };

  const { health, burn, shelf, capacity, cost, atRisk, footprint, reorders, paused, authentication } = data;
  const t = shelf.targets;

  return (
    <>
      <ViewHead
        kicker="Admin"
        title="Sending pool."
        sub={`The shared domains every customer sends from: what they can send, what has burned, which spare domains are coming, and what it costs. You buy domains yourself and add them on the Domains page. Figures from ${ago(data.cachedAt)}.`}
        actions={
          <>
            <Seg label="How to show the numbers" size="sm" value={view} onChange={setView} options={[{ value: "graphs", label: "Charts" }, { value: "details", label: "Numbers" }]} />
            <Button
              size="sm"
              icon="rotate"
              loading={recomputing.isLoading}
              onClick={() =>
                recompute()
                  .unwrap()
                  .then(() => toast("Figures recalculated.", "good"))
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
              title="Recalculates every figure now. They also recalculate by themselves every 15 minutes."
            >
              Recalculate
            </Button>
          </>
        }
      />

      {reorders
        .filter((r) => r.status === "PENDING" || r.status === "APPROVED")
        .map((r) => (
          <Notice key={r.id} tone={r.status === "PENDING" ? "bad" : "info"} title={`Restock: add ${r.domainsToBuy} domain${r.domainsToBuy === 1 ? "" : "s"}`}>
            {shelf.reorderBecause.driver ? `Why: ${DRIVER_TEXT[shelf.reorderBecause.driver]}. ` : ""}
            {r.runwayWeeks === null ? "No domain has burned, so this is about the spare minimum or demand, not burn. " : `At the current burn the spare domains last ${r.runwayWeeks.toFixed(1)} weeks. `}
            A new domain takes about {t.leadTimeWeeks} weeks to be ready ({t.agingDays} quiet days, then {t.warmupDays} days of warmup, plus a little margin). Raised {ago(r.createdAt)}. Buy them yourself, 3 to 5 at a time, from more than one registrar, then add them on the{" "}
            <Link href="/admin/domains">Domains page</Link>. Names you could buy: {r.suggestions.join(", ")}.
            {r.status === "PENDING" ? (
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <input className="input sm" style={{ flex: "1 1 220px" }} placeholder="Note (optional, logged)" value={notes[r.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                <Button size="sm" variant="primary" loading={busy === `${r.id}:true`} disabled={!!busy} onClick={() => act(r.id, true)}>
                  I&apos;ll add them
                </Button>
                <Button size="sm" loading={busy === `${r.id}:false`} disabled={!!busy} onClick={() => act(r.id, false)}>
                  Dismiss
                </Button>
              </div>
            ) : null}
          </Notice>
        ))}

      {paused.map((d) => (
        <Notice key={d.id} tone="bad" title={`${d.domain} is paused`}>
          {d.reason ?? "Authentication failed."} Paused {ago(d.since)}. This is our own setup, not a customer&apos;s list: check its SPF, DKIM and DMARC, then resume it. Nobody new is routed to it until then; conversations already on it carry on.
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <input className="input sm" style={{ flex: "1 1 220px" }} placeholder="What was fixed? (logged)" value={notes[d.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [d.id]: e.target.value }))} />
            <Button size="sm" variant="primary" loading={busy === `resume:${d.id}`} disabled={!!busy || (notes[d.id]?.trim().length ?? 0) < 5} onClick={() => resumeDomain(d.id, d.domain)}>
              Resume sending
            </Button>
          </div>
        </Notice>
      ))}

      {view === "graphs" ? (
        <PoolGraphs data={data} />
      ) : (
        <>
          <div className="stats4 glass">
            <div className="stat">
              <div className="big num">{n0(health.activeDomains)}</div>
              <div className="sub">Active domains · {n0(health.activeMailboxes)} mailboxes</div>
            </div>
            <div className="stat">
              <div className="big num">{n0(health.warmingDomains)}</div>
              <div className="sub">Warming up · {n0(health.warmingMailboxes)} mailboxes</div>
            </div>
            <div className="stat">
              <div className="big num">{n0(health.repliesOnlyMailboxes)}</div>
              <div className="sub">Burned mailboxes (replies only)</div>
            </div>
            <div className="stat">
              <div className="big num">{n0(health.retiredThisMonth)}</div>
              <div className="sub">Domains retired, 30 days</div>
            </div>
          </div>

          <div className="grid2">
            <div className="panel glass">
              <h3>
                Burned domains<small>{burn.burnRatePerMonth} of sending domains in 30 days</small>
              </h3>
              <div className="kvgrid" style={{ marginTop: 12 }}>
                <div title="A running average of domains burned per week: recent weeks count more than older ones.">
                  <small>Average a week</small>
                  <b>{burn.ewmaWeeklyBurn.toFixed(2)}</b>
                </div>
                <div>
                  <small>Burned, 7 days</small>
                  <b>{n0(burn.degraded7)}</b>
                </div>
                <div>
                  <small>Burned, 30 days</small>
                  <b>{n0(burn.degraded30)}</b>
                </div>
              </div>
              <Burn weekly={burn.weekly} />
            </div>
            <div className="panel glass">
              <h3>
                Spare domains<small>{shelf.reorderNeeded ? `buy ${n0(shelf.domainsToBuy)}` : "enough coming"}</small>
              </h3>
              <div className="kvgrid" style={{ marginTop: 12 }}>
                <div title="Domains already bought that are not sending yet: aging plus warming up.">
                  <small>Spare domains</small>
                  <b>
                    {n0(shelf.warmShelf)} <span className="m">of {n0(t.spareDomainsMin)} minimum</span>
                  </b>
                </div>
                <div title="How long the spares last at the current burn.">
                  <small>Last for</small>
                  <b style={{ color: shelf.reorderNeeded && shelf.runwayWeeks !== null ? "var(--bad)" : undefined }}>{runwayText(shelf.runwayWeeks)}</b>
                </div>
              </div>
              <div className="restock-why">
                <small>Why buy</small>
                <p>{shelf.reorderBecause.driver ? DRIVER_TEXT[shelf.reorderBecause.driver] : "nothing: spares, burn and demand are all covered"}</p>
                <div className="kvgrid kv3">
                  {(
                    [
                      ["burnReplacement", "To replace burn"],
                      ["spareShortfall", `Below the minimum of ${n0(t.spareDomainsMin)}`],
                      ["demandShortfall", `For demand (keep ${t.spareMultiplier}x)`],
                    ] as const
                  ).map(([k, l]) => (
                    <div key={k} className={shelf.reorderBecause.driver === k ? "driver" : ""}>
                      <small>{l}</small>
                      <b>{n0(shelf.reorderBecause[k])}</b>
                    </div>
                  ))}
                </div>
                {shelf.reorderNeeded ? <p className="fine">At most {n0(t.maxBuyPerBatch)} at a time.</p> : null}
              </div>
              <div className="stack" style={{ marginTop: 12 }}>
                {PIPE.map(([k, l]) => (
                  <div className="kv" key={k}>
                    <span>{k === "aging" ? `Aging (${t.agingDays} quiet days)` : l}</span>
                    <b>{n0(shelf.pipeline[k] ?? 0)}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid2">
            <div className="panel glass">
              <h3>
                Capacity<small>{capacity.headroom} free</small>
              </h3>
              <div className="stack" style={{ marginTop: 12 }}>
                <div className="kv">
                  <span>Can send today</span>
                  <b>{n0(capacity.total)} emails</b>
                </div>
                <div className="kv">
                  <span>Customers asked for</span>
                  <b>{n0(capacity.committed)} a day</b>
                </div>
                <div className="kv">
                  <span>Room for more $20-a-day customers (500 emails a day each)</span>
                  <b>{n0(capacity.roomFor500PerDay)}</b>
                </div>
                <div className="kv" title="Internal outreach only uses capacity no customer needs, and gives it back when one does.">
                  <span>Internal outreach (uses only spare capacity)</span>
                  <b>{n0(capacity.internal)} a day</b>
                </div>
                <div className="kv">
                  <span>Most one domain sends, all customers together</span>
                  <b>{n0(capacity.domainDailyCap)} a day</b>
                </div>
              </div>
            </div>
            <div className="panel glass">
              <h3>
                Cost and margin<small>internal only, last 30 days</small>
              </h3>
              <div className="stack" style={{ marginTop: 12 }}>
                <div className="kv">
                  <span>All-in cost per email</span>
                  <b>{usd(data.economics.total.perEmail, true)}</b>
                </div>
                <div className="kv">
                  <span>Gross margin per email</span>
                  <b>
                    {usd(data.economics.margin.perEmail, true)}
                    {data.economics.margin.perEmailPct !== null ? ` (${data.economics.margin.perEmailPct}%)` : ""}
                  </b>
                </div>
                <div className="kv">
                  <span>All costs</span>
                  <b>{usd(data.economics.total.month)}</b>
                </div>
                <div className="kv">
                  <span>Charged to customers</span>
                  <b>{cost.monthlyRevenue}</b>
                </div>
                <div className="kv">
                  <span>Gross margin</span>
                  <b>
                    {usd(data.economics.margin.month)}
                    {data.economics.margin.monthPct !== null ? ` (${data.economics.margin.monthPct}%)` : ""}
                  </b>
                </div>
              </div>
            </div>
          </div>

          <div className="section-h">
            <h2>Domains at risk</h2>
          </div>
          <div className="tbl-wrap glass">
            {atRisk.length ? (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Domain</th>
                      <th className="right">Sends, 7 days</th>
                      <th className="right">Bounces and complaints, 7 days</th>
                      <th className="right">Change vs 30 days</th>
                      <th className="right" title="0 is safe, 1 is the worst. 0.4 and up is watched, 0.7 and up is at risk. A score, not a forecast.">
                        Risk score
                      </th>
                      <th>Band</th>
                    </tr>
                  </thead>
                  <tbody>
                    {atRisk.map((r) => (
                      <tr key={r.domain}>
                        <td className="strong mono">{r.domain}</td>
                        <td className="num-cell">{n0(r.sends7)}</td>
                        <td className="num-cell">{r.bounce7}</td>
                        <td className="num-cell">{r.trend}</td>
                        <td className="num-cell">
                          <Chip tone={r.risk >= 0.7 ? "r" : "y"}>{r.risk.toFixed(2)}</Chip>
                        </td>
                        <td>{r.band}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="shield" title="No domain at risk">
                Domains with fewer than 200 sends in 30 days are not scored yet.
              </Empty>
            )}
          </div>

          <div className="section-h">
            <h2>Authentication</h2>
          </div>
          <div className="tbl-wrap glass">
            {authentication.unverified.length ? (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Domain</th>
                      <th>SPF</th>
                      <th>DKIM</th>
                      <th>DMARC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {authentication.unverified.map((d) => (
                      <tr key={d.domain}>
                        <td className="strong mono">{d.domain}</td>
                        {([d.spf, d.dkim, d.dmarc] as const).map((ok, i) => (
                          <td key={i}>
                            <Chip tone={ok ? "g" : "r"}>{ok ? "Pass" : "Missing"}</Chip>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="shield" title="Every domain resolves SPF, DKIM and DMARC">
                Checked daily. A domain only leaves warmup once the seed inbox also confirms our own DKIM signature.
              </Empty>
            )}
          </div>

          <div className="section-h">
            <h2>Unmatched replies</h2>
          </div>
          <div className="engine glass">
            <div style={{ display: "grid", gap: 6 }}>
              <b style={{ font: "600 20px var(--f-display)", letterSpacing: "-.02em" }}>{n0(data.unmatched.open)} waiting</b>
              <span className="muted" style={{ fontSize: 13.5 }}>Messages we couldn&apos;t tie to an email we sent. A growing number means thread matching broke.</span>
            </div>
            <div style={{ display: "flex", gap: 14, alignItems: "end", flex: "0 1 420px" }}>
              <Burn weekly={data.unmatched.daily.map((d) => d.open)} what="Unmatched replies open per day" unit="open" take={30} />
              <Link className="btn btn-sm btn-ghost" href="/admin/unmatched">
                Open the queue
              </Link>
            </div>
          </div>

          <div className="section-h">
            <h2>Where the domains are</h2>
          </div>
          <div className="grid3">
            {(
              [
                ["registrar", "Registrars"],
                ["nameserverSet", "DNS providers"],
                ["ipPool", "Sending servers"],
              ] as const
            ).map(([k, l]) => (
              <div className="panel glass" key={k}>
                <h3>{l}</h3>
                <div className="stack" style={{ marginTop: 12 }}>
                  {footprint[k].length ? (
                    footprint[k].map((f) => (
                      <div className="kv" key={f.value}>
                        <span className="mono">{f.value}</span>
                        <b>
                          {n0(f.domains)} · {f.share}
                        </b>
                      </div>
                    ))
                  ) : (
                    <p className="m">No domains yet.</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* What an operator acts on. Shown under both views, so switching how numbers are drawn never hides a control. */}
      <div className="section-h">
        <h2>Spare domains, one by one</h2>
      </div>
      <div className="tbl-wrap glass">
        <WarmingTable rows={shelf.warming} />
      </div>

      <div className="section-h">
        <h2>Burned in the last 30 days</h2>
      </div>
      <div className="tbl-wrap glass">
        <BurnedTable rows={data.burned} />
      </div>

      {data.forced.length ? (
        <>
          <div className="section-h">
            <h2>Promoted early</h2>
          </div>
          <div className="tbl-wrap glass">
            <ForcedTable rows={data.forced} />
          </div>
        </>
      ) : null}

      <div className="section-h">
        <h2>Restock</h2>
      </div>
      <PoolSettingsPanel />
      <div className="tbl-wrap glass">
        {reorders.length ? (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Raised</th>
                  <th>Status</th>
                  <th className="right">Domains</th>
                  <th className="right">Spares lasted</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {reorders.map((r) => (
                  <tr key={r.id}>
                    <td className="m">{ago(r.createdAt)}</td>
                    <td>
                      <Chip tone={REORDER_TONE[r.status]}>{titleCase(r.status)}</Chip>
                    </td>
                    <td className="num-cell">{n0(r.domainsToBuy)}</td>
                    <td className="num-cell">{runwayText(r.runwayWeeks)}</td>
                    <td>{r.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="list" title="No restock requests yet">
            A daily check raises one when spare domains fall below the minimum, when burn would use them up before new domains are ready, or when customers ask for more than the pool can send.
          </Empty>
        )}
      </div>
    </>
  );
}
