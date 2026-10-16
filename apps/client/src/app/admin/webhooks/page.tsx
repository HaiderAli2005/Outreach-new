"use client";

import { Chip, ViewHead } from "@/components/ui/primitives";
import { AdminTable } from "@/components/app/AdminTable";
import { dateTime, titleCase } from "@/lib/format";

export default function AdminWebhooks() {
  return (
    <>
      <ViewHead kicker="Admin" title="Webhook events." sub="Every inbound event is stored once. Duplicates are recognised and skipped." />
      <AdminTable
        resource="webhook-events"
        filters={[
          { key: "provider", label: "Any provider", options: [["STRIPE", "Stripe"], ["CALENDLY", "Calendly"], ["APOLLO", "Apollo"]] },
          { key: "status", label: "Any status", options: [["RECEIVED", "Received"], ["PROCESSED", "Processed"], ["FAILED", "Failed"], ["IGNORED", "Ignored"]] },
        ]}
        columns={[
          { label: "Received", render: (r) => <span className="m">{dateTime(String(r.receivedAt))}</span> },
          { label: "Provider", render: (r) => titleCase(String(r.provider)) },
          { label: "Type", render: (r) => <span className="mono">{String(r.type)}</span> },
          { label: "Status", render: (r) => <Chip tone={r.status === "PROCESSED" ? "g" : r.status === "FAILED" ? "r" : r.status === "IGNORED" ? "v" : "y"}>{titleCase(String(r.status))}</Chip> },
          { label: "Error", render: (r) => <span className="m">{r.error ? String(r.error) : ""}</span> },
        ]}
      />
    </>
  );
}
