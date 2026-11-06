"use client";

import { n0 } from "@/lib/format";
import type { CostLineKey, CostStack as Stack } from "@/lib/types";
import { Panel, Section, Verdict, type Tone } from "./poolParts";

/** Internal only. What one email really costs us, where that money goes, and the same per domain. */

const COLOR: Record<CostLineKey, string> = { infrastructure: "#8A6A3C", ai: "#B98DD9", data: "#6FA8DC", verification: "#7CC4B2", fees: "#C9A86A" };

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
