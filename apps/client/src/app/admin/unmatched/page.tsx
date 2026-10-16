"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Empty, ErrorState, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { useToast } from "@/store";
import { errorMessage, useAdminAssignUnmatchedMutation, useAdminHandleUnmatchedMutation, useAdminPoolQuery, useAdminPoolUnmatchedQuery, useAdminUnmatchedCandidatesQuery } from "@/store/api";
import { ago, dateLong, n0, titleCase } from "@/lib/format";
import type { AdminUnmatchedInbound } from "@/lib/types";

/** Daily size of the queue, last 30 days. A rising line means thread matching broke somewhere. */
function Trend({ daily }: { daily: { day: string; open: number }[] }) {
  if (daily.length < 2) return <p className="m">The trend starts after a couple of daily snapshots.</p>;
  const max = Math.max(1, ...daily.map((d) => d.open));
  return (
    <div className="pool-burn" role="img" aria-label={`Unmatched messages open per day: ${daily.map((d) => d.open).join(", ")}`}>
      {daily.map((d) => (
        <span key={d.day} style={{ height: `${Math.max(4, (d.open / max) * 100)}%` }} title={`${d.day}: ${d.open} open`} />
      ))}
    </div>
  );
}

function Candidates({ m, onDone }: { m: AdminUnmatchedInbound; onDone: () => void }) {
  const { data, isLoading } = useAdminUnmatchedCandidatesQuery(m.id);
  const [assign, assigning] = useAdminAssignUnmatchedMutation();
  const toast = useToast();
  if (isLoading) return <SkeletonRows rows={2} h={40} />;
  if (!data?.length) return <p className="m">No conversation from this address or its company was found. Mark it handled if it needs nothing.</p>;
  return (
    <div className="stack">
      {data.map((c) => (
        <div className="kv" key={c.id}>
          <span>
            <b>{c.fullName ?? c.email}</b> <span className="mono m">{c.email}</span>
            <span className="m"> · {c.company ?? "no company"} · {c.organization.name} · {titleCase(c.status)}{c.lastContactedAt ? ` · emailed ${ago(c.lastContactedAt)}` : ""}</span>
          </span>
          <Button
            size="sm"
            loading={assigning.isLoading && assigning.originalArgs?.contactId === c.id}
            onClick={() =>
              assign({ id: m.id, contactId: c.id })
                .unwrap()
                .then(() => (toast("Attached. It now counts as their reply: their sequence stopped and the reply is being sorted.", "good"), onDone()))
                .catch((e) => toast(errorMessage(e), "bad"))
            }
          >
            Attach here
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Messages the mailboxes read that matched no thread, for an operator to attach or close. Operator-only. */
export default function UnmatchedPage() {
  const { data, isLoading, isError, error, refetch } = useAdminPoolUnmatchedQuery(undefined, { pollingInterval: 60_000 });
  const { data: pool } = useAdminPoolQuery();
  const [handle, handling] = useAdminHandleUnmatchedMutation();
  const [open, setOpen] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string | null>(null);
  const toast = useToast();
  return (
    <>
      <ViewHead kicker="Admin" title="Unmatched replies." sub="Messages our mailboxes received that we couldn't tie to an email we sent. Attach each to its conversation, or mark it handled. A growing queue means thread matching is broken." />
      <div className="grid2">
        <div className="panel glass">
          <h3>
            Open now<small>{pool ? `as of ${ago(pool.cachedAt)}` : ""}</small>
          </h3>
          <div className="big num" style={{ marginTop: 8 }}>
            {n0(data?.length ?? pool?.unmatched.open ?? 0)}
          </div>
        </div>
        <div className="panel glass">
          <h3>
            Last 30 days<small>open at each daily snapshot</small>
          </h3>
          <div style={{ marginTop: 10 }}>{pool ? <Trend daily={pool.unmatched.daily} /> : <SkeletonRows rows={1} h={60} />}</div>
        </div>
      </div>
      <div className="stack">
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading || !data ? (
          <SkeletonRows rows={4} h={70} />
        ) : !data.length ? (
          <Empty icon="inbox" title="Nothing unmatched">
            Every reply and bounce matched an email we sent. Back to <Link href="/admin/pool">the pool</Link>.
          </Empty>
        ) : (
          data.map((m) => (
            <div className="panel glass" key={m.id}>
              <div className="kv">
                <span>
                  <b className="mono">{m.fromEmail}</b>
                  <span className="m"> to {m.mailbox.address} · {dateLong(m.receivedAt)}</span>
                </span>
                <span style={{ display: "flex", gap: 8 }}>
                  <Button size="sm" onClick={() => setOpen(open === m.id ? null : m.id)}>
                    {open === m.id ? "Close" : "Find its conversation"}
                  </Button>
                  <Button
                    size="sm"
                    variant="text"
                    loading={handling.isLoading && handling.originalArgs === m.id}
                    onClick={() =>
                      handle(m.id)
                        .unwrap()
                        .then(() => toast("Marked handled", "good"))
                        .catch((e) => toast(errorMessage(e), "bad"))
                    }
                  >
                    Handled
                  </Button>
                </span>
              </div>
              <b style={{ display: "block", marginTop: 10 }}>{m.subject ?? "(no subject)"}</b>
              {m.bodyText ? (
                <div className="body m" dir="auto" style={{ whiteSpace: "pre-wrap", marginTop: 6, maxHeight: 220, overflow: "auto" }}>
                  {m.bodyText}
                </div>
              ) : null}
              {m.rawHeaders ? (
                <button type="button" className="btn btn-text btn-xs" style={{ marginTop: 6 }} onClick={() => setHeaders(headers === m.id ? null : m.id)}>
                  {headers === m.id ? "Hide headers" : "Show headers"}
                </button>
              ) : null}
              {headers === m.id ? <pre className="code" style={{ marginTop: 6, maxHeight: 240, overflow: "auto" }}>{m.rawHeaders}</pre> : null}
              {open === m.id ? (
                <div style={{ marginTop: 12 }}>
                  <Candidates m={m} onDone={() => setOpen(null)} />
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </>
  );
}
