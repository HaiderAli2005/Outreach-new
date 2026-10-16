"use client";

import { useState } from "react";
import { Empty, ErrorState, Seg, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { useAdminIntentCorrectionsQuery } from "@/store/api";
import { ago, n0 } from "@/lib/format";

const label = (k: string | null) => (k ? k.toLowerCase().replace(/_/g, " ") : "none");

/**
 * Customers' one-click corrections of reply intents: the classifier's training data, reviewed weekly. The worst
 * mistake is NOT_INTERESTED read as INTERESTED, which has a customer chasing dead leads.
 */
export default function CorrectionsPage() {
  const [days, setDays] = useState(7);
  const { data, isLoading, isError, error, refetch } = useAdminIntentCorrectionsQuery(days);
  return (
    <>
      <ViewHead kicker="Admin" title="Reply corrections." sub="Where customers changed the status we gave a reply. Review weekly: each pattern here is a prompt or model change to make." actions={<Seg<number> label="Period" size="sm" value={days} onChange={setDays} options={[{ value: 7, label: "7 days" }, { value: 30, label: "30 days" }]} />} />
      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading || !data ? (
        <SkeletonRows rows={4} />
      ) : !data.total ? (
        <Empty icon="sliders" title="No corrections in this period">
          Customers agreed with every status, or haven&apos;t changed any.
        </Empty>
      ) : (
        <>
          <div className="panel glass">
            <h3>
              Most common mix-ups<small>{n0(data.total)} corrections</small>
            </h3>
            <div className="stack" style={{ marginTop: 12 }}>
              {data.confusions.map((c) => (
                <div className="kv" key={c.pair}>
                  <span>
                    {c.pair
                      .split(" -> ")
                      .map(label)
                      .join(" read, customer says ")}
                  </span>
                  <b>{n0(c.count)}</b>
                </div>
              ))}
            </div>
          </div>
          <div className="tbl-wrap glass">
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Workspace</th>
                    <th>We said</th>
                    <th>Customer says</th>
                    <th className="right">Confidence</th>
                    <th>Their reply</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="m">{ago(r.intentCorrectedAt)}</td>
                      <td>{r.organization.name}</td>
                      <td>{label(r.intent)}</td>
                      <td className="strong">{label(r.customerIntent)}</td>
                      <td className="num-cell">{r.intentConfidence === null ? "" : r.intentConfidence.toFixed(2)}</td>
                      <td className="m" style={{ maxWidth: 420, whiteSpace: "pre-wrap" }}>
                        {r.reply}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
