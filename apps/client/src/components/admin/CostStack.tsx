"use client";

import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/store";
import { errorMessage, useAdminCostsQuery, useAdminUpdateCostsMutation } from "@/store/api";
import { n0 } from "@/lib/format";
import type { CostLineKey, CostPrices, CostStack as Stack, TokenPrice } from "@/lib/types";
import { Panel, Section, Verdict, type Tone } from "./poolParts";

/** Internal only. What one email really costs us, where that money goes, and the same per domain. */

const COLOR: Record<CostLineKey, string> = { infrastructure: "#8A6A3C", ai: "#B98DD9", data: "#6FA8DC", verification: "#7CC4B2", fees: "#C9A86A" };
const PURPOSE: Record<string, string> = { personalize: "Writing a person's 4 emails", "fact-check": "Fact check of a written email", reply: "Reading a reply and drafting the answer", analysis: "Website analysis (setup)", "sample-emails": "Sample emails (setup)" };

/** $0.0123 for a per-email figure, $1,234.56 for a monthly one. */
export const usd = (v: number | null, small = false) =>
  v === null ? "–" : `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", small ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Bar({ s }: { s: Stack }) {
  const margin = Math.max(0, s.margin.perEmail ?? 0);
  const scale = Math.max(s.price, s.total.perEmail ?? 0);
  return (
    <div className="cs-bar" role="img" aria-label={`Cost ${usd(s.total.perEmail, true)} of ${usd(s.price, true)} charged per email`}>
      {s.lines.map((l) => (l.perEmail ? <i key={l.key} style={{ width: `${(l.perEmail / scale) * 100}%`, background: COLOR[l.key] }} title={`${l.label}: ${usd(l.perEmail, true)}`} /> : null))}
      {margin ? <i className="m" style={{ width: `${(margin / scale) * 100}%` }} title={`Margin: ${usd(margin, true)}`} /> : null}
    </div>
  );
}

function Prices() {
  const { data } = useAdminCostsQuery();
  const [save, saving] = useAdminUpdateCostsMutation();
  const toast = useToast();
  const [draft, setDraft] = useState<CostPrices | null>(null);
  const [newModel, setNewModel] = useState("");
  if (!data) return null;
  const p = draft ?? data;
  const set = (patch: Partial<CostPrices>) => setDraft({ ...p, ...patch });
  const setModel = (name: string, patch: Partial<TokenPrice> | null) => {
    const next = { ...p.aiPrices };
    if (patch === null) delete next[name];
    else next[name] = { ...next[name], ...patch };
    set({ aiPrices: next });
  };
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const field = (label: string, value: number, onChange: (v: number) => void, step = "0.0001") => (
    <label className="cs-f">
      <span>{label}</span>
      <input className="input" type="number" min={0} step={step} value={value} onChange={(e) => onChange(num(e.target.value))} />
    </label>
  );
  return (
    <Panel title="Unit prices" hint="what suppliers charge us, change them when an invoice changes">
      <div className="cs-grid">
        {field("Apollo, per person revealed ($)", p.apolloPerEnrichUsd, (v) => set({ apolloPerEnrichUsd: v }))}
        {field("Apollo, per search ($)", p.apolloPerSearchUsd, (v) => set({ apolloPerSearchUsd: v }))}
        {field("MillionVerifier, per address ($)", p.verifyPerEmailUsd, (v) => set({ verifyPerEmailUsd: v }), "0.00001")}
        {field("Card fee (%)", p.paymentFeePercent, (v) => set({ paymentFeePercent: v }), "0.01")}
        {field("Card fee, per payment ($)", p.paymentFeeFixedUsd, (v) => set({ paymentFeeFixedUsd: v }), "0.01")}
        {field("Mailbox, per month ($)", p.mailboxMonthUsd, (v) => set({ mailboxMonthUsd: v }), "0.01")}
        {field("Burned mailbox, per month until retired ($)", p.repliesOnlyMailboxMonthUsd, (v) => set({ repliesOnlyMailboxMonthUsd: v }), "0.01")}
        {field("Domain, per year ($)", p.domainYearUsd, (v) => set({ domainYearUsd: v }), "0.01")}
      </div>
      <div className="tbl-scroll" style={{ marginTop: 14 }}>
        <table className="tbl cs-tbl">
          <thead>
            <tr>
              <th>AI model (name starts with)</th>
              <th className="right">Input, per 1M tokens</th>
              <th className="right">Cached input</th>
              <th className="right">Output</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {Object.entries(p.aiPrices).map(([name, t]) => (
              <tr key={name}>
                <td className="mono">{name === "default" ? "any other model" : name}</td>
                {(["input", "cachedInput", "output"] as const).map((k) => (
                  <td key={k} className="right">
                    <input className="input cs-num" type="number" min={0} step="0.01" aria-label={`${name} ${k}`} value={t[k]} onChange={(e) => setModel(name, { [k]: num(e.target.value) })} />
                  </td>
                ))}
                <td className="right">
                  {name === "default" ? null : (
                    <button type="button" className="btn btn-text btn-sm" onClick={() => setModel(name, null)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cs-actions">
        <input className="input cs-model" placeholder="Model name, e.g. gpt-6-luna" aria-label="New model name" value={newModel} onChange={(e) => setNewModel(e.target.value)} />
        <Button
          size="sm"
          variant="ghost"
          disabled={!newModel.trim() || !!p.aiPrices[newModel.trim()]}
          onClick={() => {
            setModel(newModel.trim(), { ...p.aiPrices.default });
            setNewModel("");
          }}
        >
          Add a model
        </Button>
        <span className="grow" />
        {draft ? (
          <>
            <Button size="sm" variant="text" onClick={() => setDraft(null)}>
              Discard
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={saving.isLoading}
              onClick={() =>
                save(draft)
                  .unwrap()
                  .then(() => (setDraft(null), toast("Prices saved. The cost card uses them now.", "good")))
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              Save prices
            </Button>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

export function CostSection({ s }: { s: Stack }) {
  const pct = s.margin.perEmailPct;
  const tone: Tone = pct === null ? "good" : pct < 30 ? "bad" : pct < 60 ? "warn" : "good";
  const verdict =
    s.total.perEmail === null
      ? "No emails in the last 30 days, so there is no cost per email yet."
      : `Each email costs us ${usd(s.total.perEmail, true)} and is charged ${usd(s.price, true)}: ${pct}% gross margin.`;
  const loss = s.perDomain.filter((d) => d.marginPerEmail !== null && d.marginPerEmail < 0);
  return (
    <Section title="Cost per email" verdict={<Verdict tone={tone}>{verdict}</Verdict>}>
      <Panel
        title="Where each $0.04 goes"
        hint={`last ${s.windowDays} days, ${n0(s.emails)} emails`}
        read={
          s.margin.monthPct !== null ? (
            <>
              Customers paid <b>{usd(s.margin.revenueMonth)}</b> in {s.windowDays} days. Everything together cost <b>{usd(s.total.month)}</b>, leaving <b>{usd(s.margin.month)}</b>, {s.margin.monthPct}% of revenue. Our own outreach is in the costs but pays nothing.
            </>
          ) : (
            "No customer revenue in the last 30 days."
          )
        }
      >
        <Bar s={s} />
        <div className="tbl-scroll" style={{ marginTop: 14 }}>
          <table className="tbl cs-tbl">
            <thead>
              <tr>
                <th>Cost</th>
                <th className="right">Per email</th>
                <th className="right">Per month</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <i className="cs-dot" style={{ background: COLOR[l.key] }} />
                    {l.label}
                  </td>
                  <td className="right mono">{usd(l.perEmail, true)}</td>
                  <td className="right mono">{usd(l.month)}</td>
                </tr>
              ))}
              <tr className="cs-sum">
                <td>Total cost</td>
                <td className="right mono">{usd(s.total.perEmail, true)}</td>
                <td className="right mono">{usd(s.total.month)}</td>
              </tr>
              <tr>
                <td>Charged</td>
                <td className="right mono">{usd(s.price, true)}</td>
                <td className="right mono">{usd(s.margin.revenueMonth)}</td>
              </tr>
              <tr className={`cs-sum ${(s.margin.month ?? 0) < 0 ? "bad" : "good"}`}>
                <td>Gross margin</td>
                <td className="right mono">
                  {usd(s.margin.perEmail, true)}
                  {pct !== null ? <small> {pct}%</small> : null}
                </td>
                <td className="right mono">
                  {usd(s.margin.month)}
                  {s.margin.monthPct !== null ? <small> {s.margin.monthPct}%</small> : null}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="pg-note">
          Usage in {s.windowDays} days: {n0(s.usage.peopleEnriched)} people revealed, {n0(s.usage.searches)} searches, {n0(s.usage.emailsVerified)} addresses checked, {n0(s.usage.payments)} card payments.
        </p>
      </Panel>

      <div className="cs-stack">
        <Panel title="AI by job" hint="priced from the tokens each call used" read={s.ai.unmeasuredCalls ? <>{n0(s.ai.unmeasuredCalls)} counted AI calls have no token record, so they are not in the AI cost: calls made before tokens were recorded, or calls that failed before the AI reported its tokens.</> : undefined}>
          {s.ai.byPurpose.length ? (
            <div className="tbl-scroll">
              <table className="tbl cs-tbl">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th className="right">Calls</th>
                    <th className="right">Tokens in / out</th>
                    <th className="right">Per call</th>
                    <th className="right">{s.windowDays} days</th>
                  </tr>
                </thead>
                <tbody>
                  {s.ai.byPurpose.map((a) => (
                    <tr key={a.purpose}>
                      <td>{PURPOSE[a.purpose] ?? a.purpose}</td>
                      <td className="right mono">{n0(a.calls)}</td>
                      <td className="right mono">
                        {n0(a.avgInputTokens)} / {n0(a.avgOutputTokens)}
                      </td>
                      <td className="right mono">{usd(a.perCall, true)}</td>
                      <td className="right mono">{usd(a.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="pg-empty">No AI calls recorded yet.</p>
          )}
        </Panel>
        <Prices />
      </div>

      <Panel
        title="Per domain"
        hint={`infrastructure spread over each domain's last ${s.paceDays} days of sending`}
        read={
          loss.length ? (
            <>
              <b>{n0(loss.length)}</b> {loss.length === 1 ? "domain costs" : "domains cost"} more per email than we charge right now, mostly warming domains that send only a few a day.
            </>
          ) : (
            "Every sending domain earns more per email than it costs."
          )
        }
      >
        {s.perDomain.length ? (
          <div className="tbl-scroll">
            <table className="tbl cs-tbl">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Stage</th>
                  <th className="right">Emails a day</th>
                  <th className="right">Infrastructure a month</th>
                  <th className="right">Infrastructure per email</th>
                  <th className="right">All-in per email</th>
                  <th className="right">Margin per email</th>
                </tr>
              </thead>
              <tbody>
                {s.perDomain.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.domain}</td>
                    <td>{d.status === "WARMING" && d.warmupDay !== null ? `warming, day ${d.warmupDay}` : d.status.toLowerCase()}</td>
                    <td className="right mono">{d.perDay ? d.perDay : "none"}</td>
                    <td className="right mono">{usd(d.monthlyInfra)}</td>
                    <td className="right mono">{usd(d.infraPerEmail, true)}</td>
                    <td className="right mono">{usd(d.costPerEmail, true)}</td>
                    <td className={`right mono ${d.marginPerEmail !== null && d.marginPerEmail < 0 ? "bad" : ""}`}>{usd(d.marginPerEmail, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="pg-empty">No domains with mailboxes yet.</p>
        )}
      </Panel>
    </Section>
  );
}
