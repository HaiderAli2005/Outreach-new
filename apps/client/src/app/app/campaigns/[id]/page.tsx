"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Button, Chip, Empty, ErrorState, Pager, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { Confirm } from "@/components/ui/overlays";
import { CampaignForm, initialCampaign, toPayload, type CampaignInput } from "@/components/app/CampaignForm";
import { CampaignPill } from "@/components/app/CampaignPill";
import { useExport, useRole, useToast } from "@/store";
import {
  errorMessage,
  useCampaignQuery,
  useContactsQuery,
  useSetCampaignStatusMutation,
  useSourcingImportMutation,
  useSourcingSearchMutation,
  useUpdateCampaignMutation,
} from "@/store/api";
import { REPLY_LABEL, REPLY_TONE, ago, n0, titleCase } from "@/lib/format";

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const { data: c, isLoading, isError, error, refetch } = useCampaignQuery(id);
  const { canManage } = useRole();
  const toast = useToast();
  const { run, busy } = useExport();
  const [setStatus, statusState] = useSetCampaignStatusMutation();
  const [update, updateState] = useUpdateCampaignMutation();
  const [search, searchState] = useSourcingSearchMutation();
  const [importNow, importState] = useSourcingImportMutation();
  const [form, setForm] = useState<CampaignInput | null>(null);
  const [archive, setArchive] = useState(false);
  const [page, setPage] = useState(1);
  const { data: leads, isLoading: leadsLoading } = useContactsQuery({ campaignId: id, page, limit: 25 });

  useEffect(() => {
    if (c) setForm((f) => f ?? initialCampaign(c));
  }, [c]);

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !c) return <SkeletonRows rows={6} h={60} />;

  const changeStatus = (status: "ACTIVE" | "PAUSED" | "ARCHIVED") =>
    setStatus({ id, status })
      .unwrap()
      .then(() => {
        toast(status === "ACTIVE" ? "Campaign resumed" : status === "PAUSED" ? "Campaign paused" : "Campaign archived", "good");
        setArchive(false);
      })
      .catch((e) => toast(errorMessage(e), "bad"));

  return (
    <>
      <Link href="/app" className="btn btn-text btn-sm" style={{ justifySelf: "start" }}>
        <Icon id="back" />
        Cockpit
      </Link>
      <ViewHead
        kicker={<CampaignPill c={c} />}
        title={c.name}
        sub={c.niche ?? undefined}
        actions={
          <>
            <Button size="sm" icon="download" loading={busy !== null} onClick={() => run(`/campaigns/${id}/export`, `campaign-${id}.csv`)}>
              Export
            </Button>
            {canManage && c.status !== "ARCHIVED" ? (
              <>
                {c.status === "ACTIVE" ? (
                  <Button size="sm" loading={statusState.isLoading} onClick={() => changeStatus("PAUSED")}>
                    Pause
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" loading={statusState.isLoading} onClick={() => changeStatus("ACTIVE")}>
                    {c.status === "DRAFT" ? "Activate" : "Resume"}
                  </Button>
                )}
                <Button size="sm" variant="danger" onClick={() => setArchive(true)}>
                  Archive
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="stats4 glass">
        <div className="stat">
          <div className="big num">{n0(c.leadCount)}</div>
          <div className="sub">Leads · {n0(c.verifiedCount)} verified</div>
        </div>
        <div className="stat">
          <div className="big num">
            {n0(c.tierACount)}
            <small> / {n0(c.tierBCount ?? 0)}</small>
          </div>
          <div className="sub">Tier A / Tier B</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(c.contactedCount)}</div>
          <div className="sub">Contacted</div>
        </div>
        <div className="stat">
          <div className="big num">{c.replyRate === null ? "n/a" : `${c.replyRate}%`}</div>
          <div className="sub">{n0(c.replyCount)} replies</div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel glass">
          <h3>
            Sending<small>{c.status === "ACTIVE" ? "on" : "off"}</small>
          </h3>
          <p style={{ marginTop: 8 }}>
            {c.status === "ACTIVE"
              ? "Emails go out from our warmed senders inside your sending hours, within your daily budget. Replies land in your inbox here."
              : "Nothing goes out while this campaign is paused. Resume it to start sending again."}
          </p>
        </div>
        <div className="panel glass">
          <h3>
            Find leads<small>uses your lead credits</small>
          </h3>
          <p style={{ marginTop: 8 }}>Search this campaign&apos;s audience, or pull a batch of verified leads into this week&apos;s list now.</p>
          {searchState.data ? (
            <div className="ok-line g" style={{ marginTop: 10 }}>
              <Icon id="search" />
              <span>{n0(searchState.data.totalEntries)} people match this targeting.</span>
            </div>
          ) : null}
          {searchState.error ? (
            <div className="banner bad" style={{ marginTop: 10 }}>
              {errorMessage(searchState.error)}
            </div>
          ) : null}
          {canManage ? (
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <Button size="sm" icon="search" loading={searchState.isLoading} onClick={() => search({ campaignId: id })}>
                Preview audience
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={importState.isLoading}
                disabled={c.status !== "ACTIVE"}
                onClick={() =>
                  importNow({ campaignId: id, maxEnrich: 25 })
                    .unwrap()
                    .then((r) => toast(`Added ${r.inserted} new lead${r.inserted === 1 ? "" : "s"}. ${r.duplicates} duplicates, ${r.blocked} blocked, ${r.noEmail} without an email.${r.saturated ? " This audience is used up." : ""}`, "good"))
                    .catch((e) => toast(errorMessage(e), "bad"))
                }
              >
                Find 25 leads now
              </Button>
            </div>
          ) : null}
          {searchState.data?.people.length ? (
            <div className="stack" style={{ marginTop: 12, maxHeight: 220, overflow: "auto" }}>
              {searchState.data.people.slice(0, 10).map((p) => (
                <div key={p.id} className="kv">
                  <span>
                    {p.name} · {p.title}
                  </span>
                  <b>{p.company}</b>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {canManage && form && c.status !== "ARCHIVED" ? (
        <div className="panel glass">
          <h3>
            Settings<small>changes apply to new leads and emails</small>
          </h3>
          {c.status === "ACTIVE" ? (
            <div className="banner info" style={{ marginTop: 12 }}>
              <span>Pause the campaign to change its targeting.</span>
            </div>
          ) : null}
          <div style={{ marginTop: 16 }}>
            <CampaignForm value={form} onChange={setForm} disabled={c.status === "ACTIVE"} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Button variant="text" onClick={() => setForm(initialCampaign(c))}>
              Reset
            </Button>
            <Button
              variant="primary"
              loading={updateState.isLoading}
              disabled={!form.name.trim() || c.status === "ACTIVE"}
              onClick={() =>
                update({ id, patch: toPayload(form) })
                  .unwrap()
                  .then(() => toast("Campaign saved", "good"))
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              Save changes
            </Button>
          </div>
        </div>
      ) : null}

      <div className="section-h">
        <h2>Leads in this campaign</h2>
        <Link className="btn btn-text btn-sm" href={`/app/leads?tab=all&campaign=${id}`}>
          Open in Leads
          <Icon id="arr" className="arr" />
        </Link>
      </div>
      <div className="tbl-wrap glass">
        {leadsLoading ? (
          <SkeletonRows rows={5} />
        ) : leads?.data.length ? (
          <>
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Company</th>
                    <th>Status</th>
                    <th className="right">Fit</th>
                    <th>Reply</th>
                    <th>Contacted</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.data.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <Link href={`/app/leads?tab=all&campaign=${id}&lead=${l.id}`}>
                          <b>{l.fullName ?? l.email}</b>
                        </Link>
                        <div className="m">{l.title}</div>
                      </td>
                      <td>{l.company}</td>
                      <td className="m">{titleCase(l.status)}</td>
                      <td className="num-cell">{l.fitScore}</td>
                      <td>{l.replyClass ? <Chip tone={REPLY_TONE[l.replyClass] ?? "v"}>{REPLY_LABEL[l.replyClass] ?? l.replyClass}</Chip> : null}</td>
                      <td className="m">{l.lastContactedAt ? ago(l.lastContactedAt) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} limit={25} total={leads.meta.total ?? 0} onPage={setPage} />
          </>
        ) : (
          <Empty icon="users" title="No leads yet">
            Leads appear as sourcing runs for this campaign, or when you import a CSV into it.
          </Empty>
        )}
      </div>

      {archive ? (
        <Confirm
          title="Archive this campaign?"
          danger
          confirmLabel="Archive"
          loading={statusState.isLoading}
          onClose={() => setArchive(false)}
          onConfirm={() => changeStatus("ARCHIVED")}
          body="It stops sourcing and sending for good. Leads and conversations stay where they are."
        />
      ) : null}
    </>
  );
}
