"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Empty, ErrorState, Notice, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import { useRole, useToast } from "@/store";
import { errorMessage, useApproveFirstBatchMutation, useApprovePeopleMutation, useLaunchViewQuery } from "@/store/api";
import { dateLong, n0 } from "@/lib/format";
import type { LaunchEmail, LaunchView } from "@/lib/types";

/** An email as it will read. The server fills in the sender's name. */
function Body({ text }: { text: string | null }) {
  if (!text) return <p className="muted">Not written yet.</p>;
  return (
    <div className="body" dir="auto">
      {text}
    </div>
  );
}

function Person({ p, excluded, onToggle, canManage }: { p: LaunchView["people"][number]; excluded: boolean; onToggle: () => void; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const email: LaunchEmail | undefined = p.emails.find((e) => e.step === step);
  return (
    <div className={`apv-person glass${excluded ? " out" : ""}`}>
      <div className="apv-head">
        <button type="button" className="apv-who" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`apv-chev${open ? " open" : ""}`}>
            <Icon id="chev" />
          </span>
          <span>
            <b>{p.name ?? p.email}</b>
            <span className="muted">{[p.title, p.company].filter(Boolean).join(" at ")}</span>
          </span>
        </button>
        <span className="apv-meta">
          <span className="mono apv-email">{p.email}</span>
          <span className="chip-s v">
            via {p.emailSource ?? "import"}
            {p.verified ? ` · ${p.verified === "ok" ? "valid" : p.verified}` : ""}
          </span>
        </span>
        {canManage ? (
          <label className="apv-skip">
            <input type="checkbox" checked={excluded} onChange={onToggle} />
            Leave out
          </label>
        ) : null}
      </div>
      {open ? (
        <div className="apv-emails">
          <div className="tabs" role="tablist" aria-label="Emails in the sequence">
            {p.emails.map((e) => (
              <button key={e.step} type="button" role="tab" aria-selected={e.step === step} onClick={() => setStep(e.step)}>
                {e.step === 1 ? "First email" : `Follow-up ${e.step - 1}`}
                <span className="badge-n muted">day {e.day}</span>
              </button>
            ))}
          </div>
          <div className="msg out" style={{ marginTop: 10 }}>
            <div className="meta">
              <span>
                <b>Subject</b> · {email?.subject ?? "none"}
              </span>
            </div>
            <Body text={email?.body ?? null} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Approval before launch. The first 20 people and every email they would get, approved by a person before anything
 * is sent. There is no countdown: if nobody approves, nothing is ever sent.
 */
export default function ApprovePage() {
  const { data, isLoading, isError, error, refetch } = useLaunchViewQuery(undefined, { pollingInterval: 30_000, skipPollingIfUnfocused: true });
  const [approve, approving] = useApproveFirstBatchMutation();
  const [approveSome, approvingSome] = useApprovePeopleMutation();
  const [excluded, setExcluded] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const { canManage } = useRole();
  const toast = useToast();
  const head = <ViewHead kicker="Launch" title="Approve before anything sends." sub="Read the people we found and every email they would get. Nothing is sent until you approve, and no timer ever approves for you." />;
  if (isError)
    return (
      <>
        {head}
        <ErrorState error={error} onRetry={refetch} />
      </>
    );
  if (isLoading || !data)
    return (
      <>
        {head}
        <SkeletonRows rows={5} h={64} />
      </>
    );
  const each = data.launchMode === "APPROVE_EACH";
  // After the first batch, and with no first-batch step, people are approved one by one.
  const perPerson = each || data.approved || data.launchMode === "AUTO";
  const consented = !!data.consent || consent;
  const kept = data.people.filter((p) => !excluded.includes(p.id));
  const go = () => {
    const done = (n: number) => toast(`${n0(n)} ${n === 1 ? "person" : "people"} approved. They're emailed in their own working hours.`, "good");
    (perPerson ? approveSome({ ids: kept.map((p) => p.id), consent }).unwrap() : approve({ consent, excludeIds: excluded }).unwrap()).then((r) => done(r.approved)).catch((e) => toast(errorMessage(e), "bad"));
  };
  return (
    <>
      {head}
      {data.approved && !each ? (
        <Notice tone="good" icon="check" title="Your first batch is approved">
          Approved {data.approvedAt ? dateLong(data.approvedAt) : ""}. People we find from now on wait below for your approval, unless Approve weeks automatically is on in <Link href="/app/settings?tab=autopilot">Settings</Link>.
        </Notice>
      ) : data.launchMode === "AUTO" ? (
        <Notice tone="info" icon="plane" title="No first-20 step">
          People we find still wait here for your approval, unless Approve weeks automatically is on in <Link href="/app/settings?tab=autopilot">Settings</Link>. Uploaded lists never wait.
        </Notice>
      ) : (
        <div className="apv-progress glass">
          <div>
            <b className="num">
              {n0(data.ready)} of {n0(data.needed)}
            </b>
            <span className="muted">{data.ready >= data.needed ? "ready for you to read" : data.preparing ? `ready, ${n0(data.preparing)} more being found and written` : "ready"}</span>
          </div>
          <div className="apv-bar" aria-hidden>
            <span style={{ width: `${Math.min(100, (data.ready / data.needed) * 100)}%` }} />
          </div>
        </div>
      )}

      {data.people.length ? (
        <div className="stack">
          {data.people.map((p) => (
            <Person key={p.id} p={p} canManage={canManage} excluded={excluded.includes(p.id)} onToggle={() => setExcluded((x) => (x.includes(p.id) ? x.filter((i) => i !== p.id) : [...x, p.id]))} />
          ))}
        </div>
      ) : (
        <Empty icon="users" title="Nobody is ready yet">
          {data.approved ? "Nobody is waiting for approval. New people appear here as soon as their emails are written." : "We're finding your first people and writing to them. They appear here as soon as their emails are ready."}
        </Empty>
      )}

      {canManage && data.people.length ? (
        <div className="panel glass apv-go">
          {!data.consent ? (
            <label className="apv-consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{data.consentText}</span>
            </label>
          ) : (
            <p className="fine">Your confirmation is on record from {dateLong(data.consent.at)}.</p>
          )}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
            <span className="muted" style={{ alignSelf: "center", fontSize: 13.5 }}>
              {n0(kept.length)} to approve{excluded.length ? `, ${n0(excluded.length)} left out` : ""}
            </span>
            <Button variant="primary" icon="check" disabled={!consented || !kept.length} loading={approving.isLoading || approvingSome.isLoading} onClick={go}>
              {perPerson ? "Approve these people" : "Approve and start sending"}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
