"use client";

import { Select } from "@/components/ui/Select";
import { useState } from "react";
import { Button, Chip, Empty, ErrorState, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { useRole, useToast } from "@/store";
import { errorMessage, useResolveLogsMutation, useSourcingUsageQuery, useSystemLogsQuery } from "@/store/api";
import { dateShort, dateTime, n0 } from "@/lib/format";

const LEVEL_TONE = { INFO: "b", WARN: "y", ERROR: "r", CRITICAL: "r" } as const;

export default function SystemPage() {
  const { canManage } = useRole();
  const toast = useToast();
  const [level, setLevel] = useState("");
  const [open, setOpen] = useState(true);
  const { data, isLoading, isError, error, refetch } = useSystemLogsQuery({ level: level || undefined, open: open || undefined, limit: 200 });
  const { data: usage } = useSourcingUsageQuery();
  const [resolve, resolveState] = useResolveLogsMutation();
  const openBy = data?.meta.openByLevel ?? {};
  const openCount = Object.values(openBy).reduce((a, b) => a + b, 0);

  return (
    <>
      <ViewHead
        kicker="System"
        title="What's happening behind the scenes."
        sub="Problems with connections, sending and billing are logged here so nothing fails silently."
        actions={
          canManage && openCount ? (
            <Button
              loading={resolveState.isLoading && !resolveState.originalArgs?.id}
              onClick={() =>
                resolve({})
                  .unwrap()
                  .then((r) => toast(`${r.cleared} item${r.cleared === 1 ? "" : "s"} marked resolved`, "good"))
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              Resolve all
            </Button>
          ) : null
        }
      />
      <div className="stats4 glass">
        {(["CRITICAL", "ERROR", "WARN", "INFO"] as const).map((l) => (
          <div className="stat" key={l}>
            <div className="big num">{n0(openBy[l] ?? 0)}</div>
            <div className="sub">Open {l.toLowerCase()}</div>
          </div>
        ))}
      </div>
      <div className="toolbar">
        <Select className="select" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Level">
          <option value="">All levels</option>
          <option value="CRITICAL">Critical</option>
          <option value="ERROR">Error</option>
          <option value="WARN">Warning</option>
          <option value="INFO">Info</option>
        </Select>
        <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13.5 }}>
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
          Open only
        </label>
      </div>
      <div className="tbl-wrap glass">
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading || !data ? (
          <SkeletonRows rows={5} />
        ) : data.data.length ? (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Level</th>
                  <th>Source</th>
                  <th>Message</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {data.data.map((l) => (
                  <tr key={l.id}>
                    <td className="m" style={{ whiteSpace: "nowrap" }}>
                      {dateTime(l.createdAt)}
                    </td>
                    <td>
                      <Chip tone={LEVEL_TONE[l.level]}>{l.level.toLowerCase()}</Chip>
                    </td>
                    <td className="m">{l.source}</td>
                    <td style={{ color: l.resolvedAt ? "var(--ink-3)" : "var(--ink)" }}>{l.message}</td>
                    <td className="right">
                      {canManage && !l.resolvedAt ? (
                        <Button size="xs" variant="text" onClick={() => resolve({ id: l.id }).catch(() => undefined)}>
                          Resolve
                        </Button>
                      ) : l.resolvedAt ? (
                        <span className="m">resolved</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="check" title={open ? "Nothing open" : "No log entries"}>
            {open ? "Every issue has been resolved." : "Entries appear when something needs attention."}
          </Empty>
        )}
      </div>
      {usage?.days.length ? (
        <>
          <div className="section-h">
            <h2>Usage</h2>
            <span className="muted">last {usage.days.length} active days</span>
          </div>
          <div className="tbl-wrap glass">
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="right">Leads enriched</th>
                    <th className="right">Searches</th>
                    <th className="right">Emails verified</th>
                    <th className="right">AI calls</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.days.map((d) => (
                    <tr key={d.day}>
                      <td className="m">{dateShort(d.day)}</td>
                      <td className="num-cell">{n0(d.peopleEnriched)}</td>
                      <td className="num-cell">{n0(d.searches)}</td>
                      <td className="num-cell">{n0(d.emailsVerified)}</td>
                      <td className="num-cell">{n0(d.aiCalls)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
