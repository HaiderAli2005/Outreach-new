"use client";

import Link from "next/link";
import { useAppDispatch, useAppSelector } from "@/store";
import { upgradeClosed } from "@/store/upgradeSlice";
import { Modal } from "@/components/ui/overlays";
import { dateShort, n0 } from "@/lib/format";
import type { CreditsPanel } from "@/lib/types";

/** Plain words for each line of activity. */
export function activityLabel(r: CreditsPanel["activity"][number]): string {
  if (r.kind === "sent") return `${n0(r.emails ?? 0)} email${r.emails === 1 ? "" : "s"} sent`;
  return { topup: "Credits added", bonus: "Free credit", refund: "Refund", correction: "Correction" }[r.kind];
}

/** "about 9 days" or "no sending yet". The server works it out; this only words it. */
export function runwayText(days: number | null): string {
  if (days === null) return "no sending yet";
  if (days < 1) return "less than a day";
  return `about ${n0(days)} day${days === 1 ? "" : "s"}`;
}

/** Where the money went, one row per day of sending and one per top-up. */
export function ActivityTable({ rows }: { rows: CreditsPanel["activity"] }) {
  if (!rows.length) return null;
  return (
    <div className="tbl-wrap glass">
      <div className="tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>Date</th>
              <th>What happened</th>
              <th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.day}-${r.kind}-${i}`}>
                <td className="m">{dateShort(r.day)}</td>
                <td>{activityLabel(r)}</td>
                <td className="num-cell">{r.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The single "add credits" prompt, opened by the API layer whenever the server refuses a spend. */
export function UpgradePrompt() {
  const { open, message } = useAppSelector((s) => s.upgrade);
  const dispatch = useAppDispatch();
  if (!open) return null;
  const close = () => dispatch(upgradeClosed());
  return (
    <Modal
      title="Add credits to keep sending"
      onClose={close}
      actions={
        <>
          <button type="button" className="btn btn-text btn-sm" onClick={close}>
            Not now
          </button>
          <Link className="btn btn-primary btn-sm" href="/app/billing/credits" onClick={close}>
            Add credits
          </Link>
        </>
      }
    >
      <p style={{ margin: 0 }}>{message}</p>
      <p className="muted" style={{ margin: "10px 0 0", fontSize: 13.5 }}>
        You pay per email sent, from a prepaid balance. Run out of credit and your cold email pauses. Your live conversations don&apos;t.
      </p>
    </Modal>
  );
}
