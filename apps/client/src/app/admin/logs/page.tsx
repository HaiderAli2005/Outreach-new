"use client";

import { Chip, ViewHead } from "@/components/ui/primitives";
import { AdminTable } from "@/components/app/AdminTable";
import { dateTime } from "@/lib/format";

const TONE = { INFO: "b", WARN: "y", ERROR: "r", CRITICAL: "r" } as const;

export default function AdminLogs() {
  return (
    <>
      <ViewHead kicker="Admin" title="System logs." sub="Across all organizations and platform jobs." />
      <AdminTable
        resource="system-logs"
        filters={[
          { key: "level", label: "Any level", options: [["CRITICAL", "Critical"], ["ERROR", "Error"], ["WARN", "Warning"], ["INFO", "Info"]] },
          { key: "open", label: "Open and resolved", options: [["true", "Open only"]] },
        ]}
        columns={[
          { label: "When", render: (r) => <span className="m">{dateTime(String(r.createdAt))}</span> },
          { label: "Level", render: (r) => <Chip tone={TONE[r.level as keyof typeof TONE] ?? "v"}>{String(r.level).toLowerCase()}</Chip> },
          { label: "Source", render: (r) => <span className="m">{String(r.source)}</span> },
          { label: "Organization", render: (r) => <span className="m">{(r.organization as { name?: string } | null)?.name ?? "platform"}</span> },
          { label: "Message", render: (r) => String(r.message) },
        ]}
      />
    </>
  );
}
