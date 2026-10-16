"use client";

import { useRouter } from "next/navigation";
import { Chip, ViewHead } from "@/components/ui/primitives";
import { AdminTable } from "@/components/app/AdminTable";
import { dateLong, n0, titleCase } from "@/lib/format";

type Org = { id: string; name: string; primaryDomain: string | null; status: string; createdAt: string; verifying: boolean; health: { status: string; bounceRate: string } | null; _count: { memberships: number; contacts: number; campaigns: number } };

export default function AdminOrganizations() {
  const router = useRouter();
  return (
    <>
      <ViewHead kicker="Admin" title="Organizations." />
      <AdminTable
        resource="organizations"
        searchable
        filters={[{ key: "status", label: "Any status", options: [["ACTIVE", "Active"], ["SUSPENDED", "Suspended"]] }]}
        onRowClick={(r) => router.push(`/admin/organizations/${String(r.id)}`)}
        columns={[
          { label: "Organization", render: (r) => { const o = r as unknown as Org; return (<><b>{o.name}</b><div className="m">{o.primaryDomain ?? "no domain"}</div></>); } },
          { label: "Status", render: (r) => <Chip tone={r.status === "ACTIVE" ? "g" : "r"}>{titleCase(String(r.status))}</Chip> },
          { label: "Verification", render: (r) => ((r as unknown as Org).verifying ? <span className="m">running</span> : <Chip tone="y">Not running</Chip>) },
          { label: "Health", render: (r) => { const o = r as unknown as Org; return o.health ? titleCase(o.health.status) : <span className="m">no sends</span>; } },
          { label: "Members", right: true, render: (r) => n0((r as unknown as Org)._count.memberships) },
          { label: "Leads", right: true, render: (r) => n0((r as unknown as Org)._count.contacts) },
          { label: "Created", render: (r) => <span className="m">{dateLong(String(r.createdAt))}</span> },
        ]}
      />
    </>
  );
}
