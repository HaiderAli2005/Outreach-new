"use client";

import { Select } from "@/components/ui/Select";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Avatar, Button, Chip, Empty, ErrorState, Field, Pager, SkeletonRows, ViewHead, useDebounced } from "@/components/ui/primitives";
import { Drawer, Modal } from "@/components/ui/overlays";
import { useExport, useRole, useToast } from "@/store";
import {
  errorMessage,
  useApproveBatchMutation,
  useBatchesQuery,
  useCampaignsQuery,
  useContactQuery,
  useContactsQuery,
  useDailyQuery,
  useExcludeFromBatchMutation,
  useImportContactsMutation,
  useNavCountsQuery,
  useRestoreContactMutation,
} from "@/store/api";
import { REPLY_LABEL, REPLY_TONE, ago, clock, dateLong, dateTime, n0, placeOf, titleCase, when } from "@/lib/format";
import type { Batch, Contact } from "@/lib/types";

const STATUS_TONE: Record<string, "g" | "b" | "v" | "y" | "r"> = {
  NEW: "v",
  PERSONALIZED: "b",
  QUEUED: "b",
  CONTACTED: "y",
  REPLIED: "g",
  NO_RESPONSE: "v",
  BLOCKLISTED: "r",
  UNSUBSCRIBED: "r",
  BOUNCED: "r",
  REJECTED: "r",
};

const STATUSES = ["NEW", "PERSONALIZED", "QUEUED", "CONTACTED", "REPLIED", "NO_RESPONSE", "BLOCKLISTED", "UNSUBSCRIBED", "BOUNCED", "REJECTED"];

function useParams() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const set = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    router.replace(`${path}?${p.toString()}`, { scroll: false });
  };
  return { params, set };
}

function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, isError, error, refetch } = useContactQuery(id);
  const [restore, { isLoading: restoring }] = useRestoreContactMutation();
  const toast = useToast();
  const c = data?.contact;
  return (
    <Drawer
      onClose={onClose}
      title={
        c ? (
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Avatar name={c.fullName ?? c.email} url={c.photoUrl} size={44} />
            <div style={{ minWidth: 0 }}>
              <b style={{ fontSize: 17 }}>{c.fullName ?? c.email}</b>
              <div className="muted" style={{ fontSize: 13 }}>{[c.title, c.company].filter(Boolean).join(" at ")}</div>
            </div>
          </div>
        ) : (
          <b>Lead</b>
        )
      }
    >
      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading || !data || !c ? (
        <SkeletonRows rows={5} />
      ) : (
        <div className="stack">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Chip tone={STATUS_TONE[c.status] ?? "v"}>{titleCase(c.status)}</Chip>
            {c.tier ? <Chip tone={c.tier === "A" ? "g" : c.tier === "B" ? "b" : "v"}>Tier {c.tier}</Chip> : null}
            {c.replyClass ? <Chip tone={REPLY_TONE[c.replyClass] ?? "v"}>{REPLY_LABEL[c.replyClass] ?? c.replyClass}</Chip> : null}
          </div>
          {["BLOCKLISTED", "UNSUBSCRIBED", "REJECTED", "NO_RESPONSE"].includes(c.status) ? (
            <div className="banner">
              <span>This lead is suppressed and won&apos;t be emailed.</span>
              <Button
                size="sm"
                loading={restoring}
                onClick={() =>
                  restore(c.id)
                    .unwrap()
                    .then((r) => toast(r.message, "good"))
                    .catch((e) => toast(errorMessage(e), "bad"))
                }
              >
                Restore
              </Button>
            </div>
          ) : null}
          <div className="kvgrid">
            {(
              [
                ["Email", c.email],
                ["Found via", `${c.emailSource ?? c.source}${c.verifyResult ? ` · ${c.verifyResult === "ok" ? "valid" : c.verifyResult}` : c.emailStatus ? ` · ${c.emailStatus}` : " · not checked"}`],
                ["Fit score", String(c.fitScore)],
                ["Campaign", c.campaign?.name ?? "none"],
                ["Location", c.location ?? ""],
                ["Industry", c.industry ?? ""],
                ["Sequence", c.sequenceStopReason ? `ended: ${c.sequenceStopReason.replace(/_/g, " ")}` : c.lastContactedAt ? "running" : "not started"],
                ["Added", dateLong(c.createdAt)],
                ["Last contacted", c.lastContactedAt ? dateLong(c.lastContactedAt) : "not yet"],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k}>
                <small>{k}</small>
                <b title={v}>{v || "n/a"}</b>
              </div>
            ))}
          </div>
          {c.linkedinUrl || c.website ? (
            <div style={{ display: "flex", gap: 8 }}>
              {c.linkedinUrl ? (
                <a className="btn btn-ghost btn-xs" href={c.linkedinUrl} target="_blank" rel="noopener noreferrer">
                  LinkedIn
                </a>
              ) : null}
              {c.website ? (
                <a className="btn btn-ghost btn-xs" href={c.website.startsWith("http") ? c.website : `https://${c.website}`} target="_blank" rel="noopener noreferrer">
                  Website
                </a>
              ) : null}
            </div>
          ) : null}
          {data.company?.description ? (
            <div className="panel glass">
              <h3>About {data.company.name ?? c.company}</h3>
              <p style={{ marginTop: 8 }}>{data.company.description}</p>
            </div>
          ) : null}
          {c.personalization ? (
            <div className="panel glass">
              <h3>
                Written sequence<small>{c.personalizationStatus}</small>
              </h3>
              <div className="msg out" style={{ marginTop: 12 }}>
                <div className="meta">
                  <b>{c.messageSubject}</b>
                  <span>Email 1</span>
                </div>
                <div className="body" dir="auto">{c.personalization}</div>
              </div>
              {c.followup2 ? (
                <div className="msg out" style={{ marginTop: 10 }}>
                  <div className="meta">
                    <b>Follow up</b>
                    <span>Email 2</span>
                  </div>
                  <div className="body" dir="auto">{c.followup2}</div>
                </div>
              ) : null}
              {c.followup3 ? (
                <div className="msg out" style={{ marginTop: 10 }}>
                  <div className="meta">
                    <b>Last note</b>
                    <span>Email 3</span>
                  </div>
                  <div className="body" dir="auto">{c.followup3}</div>
                </div>
              ) : null}
            </div>
          ) : null}
          {data.messages.length ? (
            <div className="stack">
              <div className="h5">Conversation</div>
              {data.messages.map((m) => (
                <div key={m.id} className={`msg${m.direction === "OUTBOUND" ? " out" : ""}`}>
                  <div className="meta">
                    <b>{m.direction === "OUTBOUND" ? "Sent" : "Reply"}</b>
                    <span>{dateTime(m.createdAt)}</span>
                  </div>
                  <div className="body" dir="auto">{m.body}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const { data: campaigns } = useCampaignsQuery();
  const [run, { isLoading }] = useImportContactsMutation();
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState("");
  return (
    <Modal
      title="Import leads from CSV"
      onClose={onClose}
      actions={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="text" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="upload"
              loading={isLoading}
              disabled={!text}
              onClick={() =>
                run({ text, campaignId: campaignId || undefined })
                  .unwrap()
                  .then((r) => setResult(r.message))
                  .catch((e) => setErr(errorMessage(e)))
              }
            >
              Import
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="ok-line g">
          <Icon id="check" />
          <span>{result}</span>
        </div>
      ) : (
        <div className="stack">
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Columns are matched by name (email, first name, last name, company, title, website and more). Duplicates, blocklisted addresses and companies over your per-company limit are skipped.
          </p>
          <Field label="CSV file" htmlFor="csvFile" hint={fileName ? `${fileName} · ${n0(text.length / 1024)} KB` : "Up to about 4 MB"}>
            <input
              id="csvFile"
              className="input"
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                setErr("");
                if (!f) return;
                if (f.size > 4_400_000) return setErr("That file is too large. Split it into smaller files.");
                setFileName(f.name);
                setText(await f.text());
              }}
            />
          </Field>
          <Field label="Add to campaign" htmlFor="csvCampaign">
            <Select id="csvCampaign" className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">No campaign</option>
              {(campaigns ?? [])
                .filter((c) => c.status !== "ARCHIVED")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </Field>
          {err ? (
            <div className="banner bad" role="alert">
              {err}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/** The next scheduled email: the customer's own time, the prospect's local time beside it. */
function Scheduled({ c }: { c: Contact }) {
  if (!c.nextTouchAt) return <span className="m">–</span>;
  const tz = c.prospectTz ?? c.timezone ?? null;
  return (
    <>
      {when(c.nextTouchAt)}
      {tz ? (
        <div className="m">
          {clock(c.nextTouchAt, tz)} in {placeOf(tz)}
        </div>
      ) : null}
    </>
  );
}

function LeadTable({
  rows,
  onOpen,
  selectable,
  selected,
  onToggle,
  sortedByScheduled,
  onSortScheduled,
}: {
  rows: Contact[];
  onOpen: (id: string) => void;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  sortedByScheduled?: boolean;
  onSortScheduled?: () => void;
}) {
  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <thead>
          <tr>
            {selectable ? <th style={{ width: 36 }} aria-label="Exclude" /> : null}
            <th>Name</th>
            <th>Company</th>
            <th>Status</th>
            <th className="right">Fit</th>
            <th>Reply</th>
            <th aria-sort={sortedByScheduled ? "ascending" : "none"}>
              {onSortScheduled ? (
                <button type="button" className="th-sort" onClick={onSortScheduled} title={sortedByScheduled ? "Back to the usual order" : "Soonest first"}>
                  Scheduled{sortedByScheduled ? " ↑" : ""}
                </button>
              ) : (
                "Scheduled"
              )}
            </th>
            <th>Last contacted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="click" onClick={() => onOpen(c.id)}>
              {selectable ? (
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Exclude ${c.fullName ?? c.email}`} checked={selected?.has(c.id) ?? false} onChange={() => onToggle?.(c.id)} />
                </td>
              ) : null}
              <td>
                <b>{c.fullName ?? c.email}</b>
                {c.title ? <div className="m">{c.title}</div> : null}
                <div className="m mono">
                  {c.email}
                  {c.emailSource ? <span className="lead-src"> · via {c.emailSource}{c.verifyResult === "ok" ? " · valid" : ""}</span> : null}
                </div>
              </td>
              <td>{c.company}</td>
              <td>
                <Chip tone={STATUS_TONE[c.status] ?? "v"}>{titleCase(c.status)}</Chip>
              </td>
              <td className="num-cell">
                {c.fitScore}
                {c.tier ? <span className="m"> · {c.tier}</span> : null}
              </td>
              <td>{c.replyClass ? <Chip tone={REPLY_TONE[c.replyClass] ?? "v"}>{REPLY_LABEL[c.replyClass] ?? c.replyClass}</Chip> : null}</td>
              <td>
                <Scheduled c={c} />
              </td>
              <td className="m">{c.lastContactedAt ? ago(c.lastContactedAt) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WeekReview({ open }: { open: (id: string) => void }) {
  const { params, set } = useParams();
  const { canManage } = useRole();
  const toast = useToast();
  const { data: batches, isLoading, isError, error, refetch } = useBatchesQuery();
  const current = useMemo<Batch | null>(() => {
    if (!batches?.length) return null;
    const id = params.get("batch");
    return batches.find((b) => b.id === id) ?? batches.find((b) => b.status === "REVIEW") ?? batches[0];
  }, [batches, params]);
  const page = Number(params.get("page") ?? 1) || 1;
  const sort = params.get("sort") === "scheduled" ? "scheduled" : undefined;
  const { data: leads, isLoading: leadsLoading } = useContactsQuery({ batchId: current?.id, sort, page, limit: 100 }, { skip: !current });
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [approve, approveState] = useApproveBatchMutation();
  const [exclude, excludeState] = useExcludeFromBatchMutation();

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading) return <SkeletonRows rows={4} />;
  if (!batches?.length || !current)
    return (
      <div className="glass" style={{ borderRadius: 22 }}>
        <Empty icon="calendar" title="No weekly lists yet">
          Each week, new leads are gathered into a list you can review before anything is sent. The first one appears once sourcing runs.
        </Empty>
      </div>
    );

  const st = current.stats;
  // The server approves a week while it is still being filled too, so the customer never has to wait for sourcing.
  const approvable = canManage && (current.status === "REVIEW" || current.status === "SOURCING");
  const toggle = (id: string) =>
    setExcluded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <div className="toolbar">
        <Select className="select" value={current.id} onChange={(e) => set({ batch: e.target.value, page: null })} aria-label="Week">
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              Week of {b.label} · {titleCase(b.status)}
            </option>
          ))}
        </Select>
        <span className="grow" />
        {approvable ? (
          <>
            <Button
              size="sm"
              disabled={!excluded.size}
              loading={excludeState.isLoading}
              onClick={() =>
                exclude({ id: current.id, contactIds: [...excluded] })
                  .unwrap()
                  .then((r) => {
                    toast(`${r.excluded} lead${r.excluded === 1 ? "" : "s"} excluded`, "good");
                    setExcluded(new Set());
                  })
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              Exclude {excluded.size || ""} selected
            </Button>
            <Button
              size="sm"
              variant="primary"
              arrow
              loading={approveState.isLoading}
              onClick={() =>
                approve({ id: current.id, excludeContactIds: [...excluded] })
                  .unwrap()
                  .then((r) => {
                    toast(`Approved ${n0(r.approved)} leads. About ${n0(r.perDay)} go out each working day.`, "good");
                    setExcluded(new Set());
                  })
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              Approve week
            </Button>
          </>
        ) : null}
      </div>
      <div className="stats4 glass">
        <div className="stat">
          <div className="big num">{n0(st.sendable)}</div>
          <div className="sub">Ready to send</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(st.excluded)}</div>
          <div className="sub">Excluded</div>
        </div>
        <div className="stat">
          <div className="big num">
            {n0(st.tierA)}
            <small> / {n0(st.tierB)}</small>
          </div>
          <div className="sub">Tier A / Tier B</div>
        </div>
        <div className="stat">
          <div className="big num">{st.avgFit ?? "n/a"}</div>
          <div className="sub">Average fit score</div>
        </div>
      </div>
      {st.belowFloor ? (
        <div className="banner">
          <span>{n0(st.belowFloor)} leads score below the sending floor and won&apos;t be emailed.</span>
        </div>
      ) : null}
      <div className="tbl-wrap glass">
        {leadsLoading ? (
          <SkeletonRows rows={6} />
        ) : leads?.data.length ? (
          <>
            <LeadTable rows={leads.data} onOpen={open} selectable={approvable} selected={excluded} onToggle={toggle} sortedByScheduled={!!sort} onSortScheduled={() => set({ sort: sort ? null : "scheduled", page: null })} />
            <Pager page={page} limit={100} total={leads.meta.total ?? 0} onPage={(p) => set({ page: String(p) })} />
          </>
        ) : (
          <Empty icon="users" title="No leads in this week">
            {current.status === "SOURCING" ? "Leads are still being gathered for this week." : "Everything in this week was excluded or already sent."}
          </Empty>
        )}
      </div>
    </>
  );
}

function AllLeads({ open }: { open: (id: string) => void }) {
  const { params, set } = useParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const q = useDebounced(search, 350);
  const status = params.get("status") ?? "";
  const campaignId = params.get("campaign") ?? "";
  const reply = params.get("reply") ?? "";
  const suppressed = params.get("suppressed") === "1";
  const page = Number(params.get("page") ?? 1) || 1;
  const sort = params.get("sort") === "scheduled" ? "scheduled" : undefined;
  const filters = { search: q || undefined, status: status || undefined, campaignId: campaignId || undefined, reply: reply || undefined, suppressed: suppressed ? "true" : undefined };
  const { data, isLoading, isFetching, isError, error, refetch } = useContactsQuery({ ...filters, sort, page, limit: 50 });
  const { data: campaigns } = useCampaignsQuery();
  const { run, busy } = useExport();
  const exportQs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <>
      <div className="toolbar">
        <input className="input sm grow" placeholder="Search name, email or company" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search leads" />
        <Select className="select" value={status} onChange={(e) => set({ status: e.target.value || null, page: null })} aria-label="Status">
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
        <Select className="select" value={campaignId} onChange={(e) => set({ campaign: e.target.value || null, page: null })} aria-label="Campaign">
          <option value="">All campaigns</option>
          {(campaigns ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select className="select" value={reply} onChange={(e) => set({ reply: e.target.value || null, page: null })} aria-label="Reply">
          <option value="">Any reply</option>
          <option value="replied">Replied</option>
          <option value="lead">Interested</option>
          <option value="urgent">Urgent</option>
          {Object.keys(REPLY_LABEL).map((k) => (
            <option key={k} value={k}>
              {REPLY_LABEL[k]}
            </option>
          ))}
        </Select>
        <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13.5 }}>
          <input type="checkbox" checked={suppressed} onChange={(e) => set({ suppressed: e.target.checked ? "1" : null, page: null })} />
          Suppressed only
        </label>
        <Button size="sm" icon="download" loading={busy !== null} onClick={() => run(`/contacts/export${exportQs ? `?${exportQs}` : ""}`, "leads.csv")}>
          Export
        </Button>
        <Button size="sm" variant="text" icon="download" loading={busy !== null} onClick={() => run("/contacts/export?all=1", "all-leads.csv")} title="Every person, every status, full email addresses. Free.">
          Export everyone
        </Button>
      </div>
      <div className="tbl-wrap glass" style={{ opacity: isFetching && !isLoading ? 0.7 : 1 }}>
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading || !data ? (
          <SkeletonRows rows={8} />
        ) : data.data.length ? (
          <>
            <LeadTable rows={data.data} onOpen={open} sortedByScheduled={!!sort} onSortScheduled={() => set({ sort: sort ? null : "scheduled", page: null })} />
            <Pager page={page} limit={50} total={data.meta.total ?? 0} onPage={(p) => set({ page: String(p) })} />
          </>
        ) : (
          <Empty icon="users" title="No leads match">
            {q || status || campaignId || reply || suppressed ? "Try clearing a filter." : "Import a CSV or let a campaign source leads for you."}
          </Empty>
        )}
      </div>
    </>
  );
}

function Today({ open }: { open: (id: string) => void }) {
  const { params, set } = useParams();
  const date = params.get("date") ?? undefined;
  const { data, isLoading, isError, error, refetch } = useDailyQuery({ date });
  const { run, busy } = useExport();
  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <>
      <div className="toolbar">
        <input className="input sm" type="date" value={data?.date ?? date ?? ""} onChange={(e) => set({ date: e.target.value || null })} aria-label="Day" style={{ width: 180 }} />
        <span className="grow" />
        <Button size="sm" icon="download" loading={busy !== null} disabled={!data?.counts.sent} onClick={() => run(`/daily/export${data ? `?date=${data.date}` : ""}`, "sent.csv")}>
          Export sent
        </Button>
      </div>
      {isLoading || !data ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          <div className="section-h">
            <h2>Sent on {dateLong(`${data.date}T12:00:00Z`)}</h2>
            <span className="muted">{n0(data.counts.sent)} leads</span>
          </div>
          <div className="tbl-wrap glass">
            {data.sent.length ? (
              <LeadTable rows={data.sent} onOpen={open} />
            ) : (
              <Empty icon="plane" title="Nothing sent this day">
                Sends happen inside your sending window on working days.
              </Empty>
            )}
          </div>
          <div className="section-h">
            <h2>Written and waiting to send</h2>
            <span className="muted">{n0(data.counts.queued)} leads</span>
          </div>
          <div className="tbl-wrap glass">
            {data.queued.length ? (
              <LeadTable rows={data.queued} onOpen={open} />
            ) : (
              <Empty icon="list" title="Queue is empty">
                New leads are written and queued as sourcing runs.
              </Empty>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Leads() {
  const { params, set } = useParams();
  const tab = params.get("tab") ?? (params.get("batch") ? "week" : "week");
  const [importing, setImporting] = useState(false);
  const lead = params.get("lead");
  const open = (id: string) => set({ lead: id });
  const { data: nav } = useNavCountsQuery();
  const finding = nav ? nav.leadSourcing === "AUTOMATIC" : null;
  return (
    <>
      <ViewHead
        kicker="Leads"
        title="Your prospects."
        sub={
          <>
            Review each week&apos;s list before it sends, search everyone you&apos;ve found, and see what went out today.
            {finding !== null ? (
              <span className="leads-sourcing" role="status">
                <span className={`ap-dot${finding ? " is-go" : ""}`} />
                {finding ? "Finding new people automatically: on. New prospects are added every day." : "Finding new people automatically: off. Only people already on your list are emailed."}{" "}
                <Link href="/app/settings?tab=autopilot">Change</Link>
              </span>
            ) : null}
          </>
        }
        actions={
          <Button variant="primary" icon="upload" onClick={() => setImporting(true)}>
            Import CSV
          </Button>
        }
      />
      <div className="tabs" role="tablist">
        {[
          ["week", "Week review"],
          ["all", "All leads"],
          ["today", "Sent by day"],
        ].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => set({ tab: k, page: null })}>
            {l}
          </button>
        ))}
      </div>
      {tab === "all" ? <AllLeads open={open} /> : tab === "today" ? <Today open={open} /> : <WeekReview open={open} />}
      {lead ? <LeadDrawer id={lead} onClose={() => set({ lead: null })} /> : null}
      {importing ? <ImportModal onClose={() => setImporting(false)} /> : null}
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<SkeletonRows rows={6} />}>
      <Leads />
    </Suspense>
  );
}
