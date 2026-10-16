"use client";

import Link from "next/link";
import { ErrorState, SkeletonRows, ViewHead } from "@/components/ui/primitives";
import { useAdminOverviewQuery } from "@/store/api";
import { money, n0 } from "@/lib/format";

export default function AdminOverview() {
  const { data, isLoading, isError, error, refetch } = useAdminOverviewQuery();
  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data) return <SkeletonRows rows={4} h={90} />;
  const v = (k: string) => Number(data[k] ?? 0);
  return (
    <>
      <ViewHead kicker="Admin" title="Platform overview." sub="Figures across every organization. Top-ups are recorded Stripe payments; charged is emails sent at the per-email price, last 30 days." />
      <div className="stats4 glass">
        <div className="stat">
          <div className="big num">{n0(v("organizations"))}</div>
          <div className="sub">Organizations · {n0(v("users"))} users</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(v("fundedCustomers"))}</div>
          <div className="sub">Funded customers</div>
          {v("pausedCustomers") || v("warningCustomers") ? (
            <div className="delta down">
              {v("pausedCustomers")} paused · {v("warningCustomers")} warned
            </div>
          ) : null}
        </div>
        <div className="stat">
          <div className="big num">{money(v("charged30dCents"))}</div>
          <div className="sub">Charged in 30 days · {n0(v("emailsCharged30d"))} emails</div>
        </div>
        <div className="stat">
          <div className="big num">{money(v("revenue30dCents"))}</div>
          <div className="sub">Top-ups in 30 days · {money(v("refunded30dCents"))} refunded</div>
        </div>
      </div>
      <div className="stats4 glass">
        <div className="stat">
          <div className="big num">{n0(v("sent30d"))}</div>
          <div className="sub">Emails sent in 30 days</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(v("replies30d"))}</div>
          <div className="sub">Replies in 30 days</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(v("failedWebhooks"))}</div>
          <div className="sub">Failed webhook events</div>
        </div>
        <div className="stat">
          <div className="big num">{n0(v("openCriticalLogs"))}</div>
          <div className="sub">Open critical alerts</div>
        </div>
      </div>
      {v("pendingRestock") ? (
        <div className="banner bad" role="alert">
          <span>
            {v("pendingRestock")} pool restock request{v("pendingRestock") === 1 ? "" : "s"} waiting for approval.
          </span>
          <Link className="btn btn-sm btn-primary" href="/admin/pool">
            Open the pool console
          </Link>
        </div>
      ) : null}
    </>
  );
}
