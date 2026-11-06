"use client";

import Link from "next/link";
import { useState } from "react";
import { ImportCampaigns } from "@/components/app/ImportCampaigns";
import { useRole } from "@/store";
import { Button, ErrorState, Skeleton, ViewHead } from "@/components/ui/primitives";
import { CampaignsCard, PeriodSelect } from "@/components/app/CampaignsCard";
import { usePerformanceQuery } from "@/store/api";
import type { PerformancePeriod } from "@/lib/types";

/**
 * Every campaign (audience) in one place: its state, what it sent, the replies it got and what it cost, for the chosen
 * period. Who each one targets is edited under Setup → Targeting.
 */
export default function CampaignsPage() {
  const [period, setPeriod] = useState<PerformancePeriod>("30d");
  const [importing, setImporting] = useState(false);
  const { canManage } = useRole();
  const { data: p, isError, error, refetch } = usePerformanceQuery({ period, campaign: null }, { pollingInterval: 120_000, skipPollingIfUnfocused: true });
  const ready = !!p && p.period === period;
  const sending = p?.audiences.filter((a) => a.state === "sending").length ?? 0;
  return (
    <div className="cpt">
      <ViewHead
        title="Campaigns"
        sub={
          ready && p.audiences.length
            ? `${p.audiences.length} ${p.audiences.length === 1 ? "campaign" : "campaigns"}, ${sending} sending now. Who each one reaches is set under Targeting.`
            : "Each audience you send to, what it sent, the replies it got and what it cost."
        }
        actions={
          <div className="cpt-filters">
            <PeriodSelect value={period} onChange={setPeriod} />
            <Link className="btn btn-ghost btn-sm" href="/app/setup/targeting">
              Edit audiences
            </Link>
            {canManage ? (
              <Button size="sm" icon="upload" onClick={() => setImporting(true)}>
                Import CSV
              </Button>
            ) : null}
            <Link className="btn btn-primary btn-sm" href="/app/campaigns/new">
              New campaign
            </Link>
          </div>
        }
      />
      {importing ? <ImportCampaigns onClose={() => setImporting(false)} onDone={() => setImporting(false)} /> : null}
      {isError ? <ErrorState error={error} onRetry={refetch} /> : !ready ? <Skeleton h={260} r={16} /> : <CampaignsCard p={p} />}
    </div>
  );
}
