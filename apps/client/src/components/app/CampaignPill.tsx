import { StatePill } from "@/components/ui/primitives";
import type { Campaign } from "@/lib/types";

export function CampaignPill({ c }: { c: Campaign }) {
  if (c.status === "ACTIVE" && c.saturatedAt) return <StatePill tone="warm">Resting · audience used up</StatePill>;
  if (c.status === "ACTIVE")
    return (
      <StatePill tone="go" pulse>
        Active
      </StatePill>
    );
  if (c.status === "PAUSED") return <StatePill tone="off">Paused</StatePill>;
  if (c.status === "ARCHIVED") return <StatePill tone="off">Archived</StatePill>;
  return <StatePill tone="warm">Draft</StatePill>;
}
