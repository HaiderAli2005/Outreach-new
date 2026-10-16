"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Button, Chip, ErrorState, Notice, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { Confirm } from "@/components/ui/overlays";
import { useToast } from "@/store";
import { errorMessage, useAdminAdjustCreditsMutation, useAdminOrganizationQuery, useAdminSetOrgKindMutation, useAdminSendNowMutation, useAdminUnpauseMutation, useAdminUpdateOrgMutation } from "@/store/api";
import { dateLong, dateTime, money, n0, titleCase } from "@/lib/format";
import type { BalanceView, Payment, SystemLog } from "@/lib/types";

interface OrgDetail {
  id: string;
  name: string;
  primaryDomain: string | null;
  status: "ACTIVE" | "SUSPENDED";
  /** INTERNAL is our own outreach (Marketlytics, skimming.ai, RankHouse): unbilled, served after customers. */
  kind: "CUSTOMER" | "INTERNAL";
  createdAt: string;
  health: { status: "OK" | "WARNING" | "PAUSED"; bounceRate: string; windowSends: number; pausedReason: string | null; unpauseReason: string | null } | null;
  credits: BalanceView;
  memberships: { id: string; role: string; status: string; invitedEmail: string | null; user: { id: string; email: string; name: string | null } | null }[];
  settings: { autopilotEnabled: boolean; draftReplies: boolean; launchMode: string; firstBatchApprovedAt: string | null; dailyBudgetDecicents: string | null; timezone: string } | null;
  _count: { contacts: number; campaigns: number; messages: number; blocklist: number };
  payments: Payment[];
  logs: SystemLog[];
  verifying: boolean;
}

export default function AdminOrganization() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError, error, refetch } = useAdminOrganizationQuery(id);
  const [update, { isLoading: saving }] = useAdminUpdateOrgMutation();
  const [ask, setAsk] = useState(false);
  const [unpause, unpausing] = useAdminUnpauseMutation();
  const [adjust, adjusting] = useAdminAdjustCreditsMutation();
  const [setKind, settingKind] = useAdminSetOrgKindMutation();
  const [sendNow, sending] = useAdminSendNowMutation();
  const [askSend, setAskSend] = useState(false);
  const [why, setWhy] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const toast = useToast();
  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data) return <SkeletonRows rows={5} h={70} />;
  const o = data as unknown as OrgDetail;
  const suspend = o.status === "ACTIVE";
  const confirmSend = askSend ? (
    <Confirm
      title={`Send now for ${o.name}?`}
      danger
      confirmLabel="Send now"
      loading={sending.isLoading}
      onClose={() => setAskSend(false)}
      onConfirm={() =>
        sendNow(id)
          .unwrap()
          .then((r) => (setAskSend(false), toast(`${n0(r.pushed)} sent${r.reason ? ` (${r.reason.replace(/[-_]/g, " ")})` : ""}`, "good")))
          .catch((e) => toast(errorMessage(e), "bad"))
      }
      body="Emails go out now, ignoring each prospect's sending hours. On a shared pool, a send at the wrong hour can hurt every customer on those domains. Use it only to test or to help this customer."
    />
  ) : null;
  return (
    <>
      {confirmSend}
      <Link href="/admin/organizations" className="btn btn-text btn-sm" style={{ justifySelf: "start" }}>
        <Icon id="back" />
        Organizations
      </Link>
      <ViewHead
        kicker={
          <>
            <Chip tone={o.status === "ACTIVE" ? "g" : "r"}>{titleCase(o.status)}</Chip>
            {o.kind === "INTERNAL" ? <Chip tone="v">Internal</Chip> : null}
          </>
        }
        title={o.name}
        sub={`${o.primaryDomain ?? "No domain"} · created ${dateLong(o.createdAt)}`}
        actions={
          <Button variant={suspend ? "danger" : "primary"} onClick={() => setAsk(true)}>
            {suspend ? "Suspend" : "Reactivate"}
          </Button>
        }
      />
      {!o.verifying ? (
        <Notice tone="warn" icon="alert" title="Email verification is not running">
          No email checker is set up for this workspace, so addresses go out unchecked. Add a MillionVerifier key on the server or in the workspace&apos;s Settings, Integrations.
        </Notice>
      ) : null}
      <div className="stats4 glass">
        <div className="stat">
          <div className="big num">{n0(o._count.contacts)}</div>
          <div className="sub">Leads</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(o._count.campaigns)}</div>
          <div className="sub">Campaigns</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(o._count.messages)}</div>
          <div className="sub">Messages</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(o._count.blocklist)}</div>
          <div className="sub">Blocklist entries</div>
        </div>
      </div>
      <div className="grid2">
        <div className="panel glass">
          <h3>Credits and health</h3>
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="kv"><span>Balance</span><b>{o.credits.balance} · about {n0(o.credits.emailsLeft)} emails</b></div>
            <div className="kv"><span>Held for queued emails</span><b>{o.credits.held}</b></div>
            <div className="kv"><span>Sending</span><b>{n0(o.credits.sendRatePerDay)} a day</b></div>
            <div className="kv"><span>Health</span><b>{o.health ? `${titleCase(o.health.status)} · ${(Number(o.health.bounceRate) * 100).toFixed(1)}% of last ${o.health.windowSends}` : "no sends yet"}</b></div>
          </div>
          {o.health?.status === "PAUSED" ? (
            <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
              <p className="m" style={{ margin: 0 }}>{o.health.pausedReason}</p>
              <input className="input" placeholder="Why lift the pause? (logged)" value={why} onChange={(e) => setWhy(e.target.value)} />
              <Button
                size="sm"
                loading={unpausing.isLoading}
                disabled={why.trim().length < 5}
                onClick={() =>
                  unpause({ id, reason: why.trim() })
                    .unwrap()
                    .then(() => (setWhy(""), toast("Pause lifted", "good")))
                    .catch((e) => toast(errorMessage(e), "bad"))
                }
              >
                Lift the pause
              </Button>
            </div>
          ) : null}
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr auto", gap: 8, marginTop: 14 }}>
            <input className="input" inputMode="numeric" placeholder="Deci-cents" aria-label="Amount in deci-cents (1000 is $1, negative takes back)" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9-]/g, ""))} />
            <input className="input" placeholder="Reason (logged)" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button
              size="sm"
              loading={adjusting.isLoading}
              disabled={!/^-?\d+$/.test(amount) || amount === "0" || note.trim().length < 3}
              onClick={() =>
                adjust({ id, amount, reason: note.trim() })
                  .unwrap()
                  .then((r) => (setAmount(""), setNote(""), toast(`Balance is now ${r.balance}`, "good")))
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              Adjust
            </Button>
          </div>
          <p className="m" style={{ margin: "6px 0 0" }}>1000 deci-cents is $1. A negative amount takes credit back, never below zero.</p>
        </div>
        <div className="panel glass">
          <h3>Settings</h3>
          {o.settings ? (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="kv"><span>Autopilot</span><b>{o.settings.autopilotEnabled ? "on" : "off"}</b></div>
              <div className="kv"><span>Reply drafts</span><b>{o.settings.draftReplies ? "on, sent only by a person" : "off"}</b></div>
              <div className="kv"><span>Launch</span><b>{titleCase(o.settings.launchMode)}{o.settings.firstBatchApprovedAt ? ` · approved ${dateLong(o.settings.firstBatchApprovedAt)}` : ""}</b></div>
              <div className="kv"><span>Daily budget</span><b>{o.settings.dailyBudgetDecicents === null ? "No cap" : o.settings.dailyBudgetDecicents === "0" ? "Paused" : `$${(Number(BigInt(o.settings.dailyBudgetDecicents) / 10n) / 100).toFixed(2)} a day`}</b></div>
              <div className="kv"><span>Time zone</span><b>{o.settings.timezone}</b></div>
            </div>
          ) : null}
          <div className="kv" style={{ marginTop: 14 }}>
            <span>
              Workspace type
              <small className="m" style={{ display: "block" }}>
                {o.kind === "INTERNAL" ? "Our own outreach: not billed, not in revenue, sends only after customers." : "A paying customer."}
              </small>
            </span>
            <Button
              size="sm"
              loading={settingKind.isLoading}
              onClick={() =>
                setKind({ id, kind: o.kind === "INTERNAL" ? "CUSTOMER" : "INTERNAL" })
                  .unwrap()
                  .then((r) => toast(r.kind === "INTERNAL" ? "Marked as internal outreach" : "Marked as a customer", "good"))
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              {o.kind === "INTERNAL" ? "Make it a customer" : "Mark as internal"}
            </Button>
          </div>
          <div className="kv" style={{ marginTop: 14 }}>
            <span>
              Send now
              <small className="m" style={{ display: "block" }}>
                Support and testing only. Starts whoever is ready now, outside their sending hours. Logged with your name.
              </small>
            </span>
            <Button size="sm" variant="danger" loading={sending.isLoading} onClick={() => setAskSend(true)}>
              Send now
            </Button>
          </div>
        </div>
      </div>
      <div className="panel glass">
        <h3>Members</h3>
        <div className="stack" style={{ marginTop: 12 }}>
          {o.memberships.map((m) => (
            <div className="kv" key={m.id}>
              <span>{m.user ? `${m.user.name ?? m.user.email} · ${m.user.email}` : `${m.invitedEmail} (invited)`}</span>
              <b>{m.role.toLowerCase()}</b>
            </div>
          ))}
        </div>
      </div>
      <div className="grid2">
        <div className="panel glass">
          <h3>Recent payments</h3>
          <div className="stack" style={{ marginTop: 12 }}>
            {o.payments.length ? o.payments.map((p) => (
              <div className="kv" key={p.id}>
                <span>{dateLong(p.createdAt)} · {titleCase(p.status)}</span>
                <b>{money(p.amountCents, { exact: true })}</b>
              </div>
            )) : <p>No payments.</p>}
          </div>
        </div>
        <div className="panel glass">
          <h3>Recent logs</h3>
          <div className="stack" style={{ marginTop: 12 }}>
            {o.logs.length ? o.logs.map((l) => (
              <div key={l.id} style={{ fontSize: 13.5 }}>
                <span className="m">{dateTime(l.createdAt)} · {l.level.toLowerCase()} · {l.source}</span>
                <div>{l.message}</div>
              </div>
            )) : <p>No log entries.</p>}
          </div>
        </div>
      </div>
      {ask ? (
        <Confirm
          title={suspend ? `Suspend ${o.name}?` : `Reactivate ${o.name}?`}
          danger={suspend}
          confirmLabel={suspend ? "Suspend" : "Reactivate"}
          loading={saving}
          onClose={() => setAsk(false)}
          onConfirm={() =>
            update({ id, status: suspend ? "SUSPENDED" : "ACTIVE" })
              .unwrap()
              .then(() => {
                setAsk(false);
                toast(suspend ? "Organization suspended" : "Organization reactivated", "good");
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body={suspend ? "Members lose access, autopilot and automatic replies are switched off and queued replies are cancelled. Billing is not changed." : "Members regain access. Autopilot stays off until they turn it back on."}
        />
      ) : null}
    </>
  );
}
