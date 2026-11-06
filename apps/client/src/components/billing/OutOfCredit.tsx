"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { useRole } from "@/store";
import { useTopupOptionsQuery } from "@/store/api";
import { n0 } from "@/lib/format";
import type { NavCounts } from "@/lib/types";

/**
 * The moment the balance runs out, once: what stopped, that nothing is lost, and the top-ups sized to the customer's
 * own daily budget. One click opens the payment with that amount chosen. Shown once a day per workspace and stage,
 * never on the Credits page itself (it has all of this already).
 */

const seenKey = (orgId: string, stage: string) => `ap-out-of-credit:${orgId}:${stage}`;
const today = () => new Date().toISOString().slice(0, 10);

function seenToday(orgId: string, stage: string): boolean {
  try {
    return localStorage.getItem(seenKey(orgId, stage)) === today();
  } catch {
    return false;
  }
}

function markSeen(orgId: string, stage: string) {
  try {
    localStorage.setItem(seenKey(orgId, stage), today());
  } catch {
    // Storage can be refused (private window); it then shows again next visit, which is harmless.
  }
}

export function OutOfCredit({ counts, orgId, path }: { counts: NavCounts; orgId: string; path: string }) {
  const stage = counts.balanceStage;
  const due = (stage === "empty" || stage === "reserve") && !path.startsWith("/app/billing");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (due && orgId && !seenToday(orgId, stage)) setOpen(true);
    if (!due) setOpen(false);
  }, [due, orgId, stage]);
  const { canManage } = useRole();
  const { data } = useTopupOptionsQuery(undefined, { skip: !open || !canManage });
  const options = data?.options ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const chosen = options.find((o) => o.deciCents === pick) ?? options.find((o) => o.recommended) ?? options[0];

  if (!open) return null;
  const close = () => {
    markSeen(orgId, stage);
    setOpen(false);
  };
  const empty = stage === "empty";
  const title = empty ? "You're out of credit" : `You're down to ${counts.balance}`;

  return (
    <Modal bare className="ooc" title={title} onClose={close}>
      <button type="button" className="ooc-x" onClick={close} aria-label="Close">
        <Icon id="x" />
      </button>

      <div className="ooc-hero">
        <span className={`ooc-badge${empty ? " is-empty" : ""}`} aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h10A1.5 1.5 0 0 1 18 6.5V8" />
            <rect x="3.5" y="8" width="17" height="11" rx="2.5" />
            <path d="M16 13.5h1.5" />
          </svg>
        </span>
        <h2>{title}</h2>
        <p>{empty ? "Add credit and everything picks up exactly where it stopped." : "New cold email has paused. Add credit to keep finding and emailing people."}</p>
      </div>

      <ul className="ooc-chips" aria-label="What is happening now">
        <li className="off">
          <i aria-hidden="true" />
          Sending paused
        </li>
        <li className={empty ? "off" : "on"}>
          <i aria-hidden="true" />
          {empty ? "Replies paused" : "Replies still running"}
        </li>
        <li className="ok">
          <Icon id="check" />
          Nothing is lost
        </li>
      </ul>

      {canManage ? (
        <>
          <div className="ooc-pick" role="radiogroup" aria-label="Top-up amount">
            <div className="ooc-pick-h">
              <span>Choose an amount</span>
              {data ? <small>{n0(data.emailsPerDay)} emails a day</small> : null}
            </div>
            {options.length
              ? options.map((o) => (
                  <button key={o.deciCents} type="button" role="radio" aria-checked={o === chosen} className={`ooc-row${o === chosen ? " on" : ""}`} onClick={() => setPick(o.deciCents)}>
                    <span className="ooc-dot" aria-hidden="true" />
                    <span className="ooc-amt">
                      <b>{o.amount}</b>
                      {o.recommended ? <em>Recommended</em> : null}
                    </span>
                    <span className="ooc-meta">
                      <span>Lasts {o.label}</span>
                      <small>{n0(o.emails)} emails</small>
                    </span>
                  </button>
                ))
              : Array.from({ length: 3 }, (_, i) => <div key={i} className="ooc-row skel" aria-hidden="true" />)}
          </div>

          <div className="ooc-foot">
            <Link className="btn btn-primary ooc-cta" href={chosen ? `/app/billing/credits?amount=${chosen.deciCents}` : "/app/billing/credits"} onClick={close}>
              {chosen ? `Add ${chosen.amount} and resume` : "Add credit"}
            </Link>
            <button type="button" className="ooc-later" onClick={close}>
              Not now
            </button>
            <p className="ooc-trust">
              <Icon id="lock" />
              Secure card payment. You confirm it on the next screen.
            </p>
          </div>
        </>
      ) : (
        <div className="ooc-foot">
          <p className="ooc-note">Ask a workspace owner to add credit. Sending resumes by itself once they do.</p>
          <button type="button" className="btn ooc-cta" onClick={close}>
            Got it
          </button>
        </div>
      )}
    </Modal>
  );
}
