"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { Chip } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { n0 } from "@/lib/format";
import type { CampaignState, Performance, PerformancePeriod } from "@/lib/types";

/** Each audience the customer sends to, shown as a campaign: its state in plain words and what it did in the period. */

export const CAMPAIGN_STATE: Record<CampaignState, { label: string; tone: "g" | "b" | "v" | "y" | "r"; text: string }> = {
  sending: { label: "Sending", tone: "g", text: "Emails go out every working day." },
  "lined-up": { label: "Lined up", tone: "b", text: "People are found. Their emails are looked up and written as your daily budget reaches them." },
  finding: { label: "Finding people", tone: "b", text: "Searching for people who match. A new campaign's first search starts within a minute." },
  waiting: { label: "Waiting for approval", tone: "y", text: "Nothing sends until you approve the first people." },
  paused: { label: "Paused", tone: "v", text: "Outreach is stopped. Start it again from the top bar." },
  off: { label: "Off", tone: "v", text: "This audience is turned off." },
  exhausted: { label: "Out of people", tone: "r", text: "Everyone who matches has been emailed. Widen this audience to keep going." },
};

export const PERIODS: { value: PerformancePeriod; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
];

/** The period picker shared by the cockpit and the campaigns page. */
export function PeriodSelect({ value, onChange }: { value: PerformancePeriod; onChange: (p: PerformancePeriod) => void }) {
  return (
    <Select className="select cpt-filter" aria-label="Period" value={value} onChange={(e) => onChange(e.target.value as PerformancePeriod)}>
      {PERIODS.map((x) => (
        <option key={x.value} value={x.value}>
          {x.label}
        </option>
      ))}
    </Select>
  );
}

export function CampaignsCard({ p, link }: { p: Performance; link?: { href: string; label: string } }) {
  const n = p.audiences.length;
  return (
    <div className="ap-card cpt-camps">
      <div className="ap-card-h">
        <h2>Campaigns</h2>
        <span className="meta">{n ? `${n0(n)} ${n === 1 ? "campaign" : "campaigns"}` : ""}</span>
        <span className="sp" />
        {link ? (
          <Link className="meta" href={link.href}>
            {link.label}
          </Link>
        ) : null}
      </div>
      {n ? (
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
                      <Link href={`/app/campaign/${encodeURIComponent(a.id || "own")}`}>{a.name}</Link>
                      {a.state === "sending" && a.perDay ? <small>about {n0(a.perDay)} a day</small> : a.state === "lined-up" && a.inLine ? <small>{n0(a.inLine)} people lined up</small> : null}
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
