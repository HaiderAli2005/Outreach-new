"use client";

import { Button, Chip, ViewHead } from "@/components/ui/primitives";
import { AdminTable } from "@/components/app/AdminTable";
import { useAppSelector, useToast } from "@/store";
import { errorMessage, useAdminUpdateUserMutation } from "@/store/api";
import { ago, dateLong } from "@/lib/format";

type U = { id: string; email: string; name: string | null; status: string; isPlatformAdmin: boolean; lastLoginAt: string | null; createdAt: string; memberships: { role: string; organization: { id: string; name: string } }[] };

export default function AdminUsers() {
  const [update, { isLoading }] = useAdminUpdateUserMutation();
  const toast = useToast();
  const me = useAppSelector((s) => s.auth.user?.id);
  const act = (id: string, patch: { status?: string; isPlatformAdmin?: boolean }, msg: string) =>
    update({ id, patch })
      .unwrap()
      .then(() => toast(msg, "good"))
      .catch((e) => toast(errorMessage(e), "bad"));
  return (
    <>
      <ViewHead kicker="Admin" title="Users." sub="Disabling a user signs them out everywhere." />
      <AdminTable
        resource="users"
        searchable
        filters={[{ key: "status", label: "Any status", options: [["ACTIVE", "Active"], ["DISABLED", "Disabled"]] }]}
        columns={[
          { label: "User", render: (r) => { const u = r as unknown as U; return (<><b>{u.name ?? u.email}</b><div className="m">{u.email}</div></>); } },
          { label: "Organizations", render: (r) => <span className="m">{(r as unknown as U).memberships.map((m) => `${m.organization.name} (${m.role.toLowerCase()})`).join(", ") || "none"}</span> },
          { label: "Status", render: (r) => { const u = r as unknown as U; return (<div style={{ display: "flex", gap: 6 }}><Chip tone={u.status === "ACTIVE" ? "g" : "r"}>{u.status.toLowerCase()}</Chip>{u.isPlatformAdmin ? <Chip tone="b">admin</Chip> : null}</div>); } },
          { label: "Last sign in", render: (r) => <span className="m">{r.lastLoginAt ? ago(String(r.lastLoginAt)) : "never"}</span> },
          { label: "Joined", render: (r) => <span className="m">{dateLong(String(r.createdAt))}</span> },
          {
            label: "Actions",
            render: (r) => {
              const u = r as unknown as U;
              if (u.id === me) return <span className="m">you</span>;
              return (
                <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  <Button size="xs" variant="text" disabled={isLoading} onClick={() => act(u.id, { status: u.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }, u.status === "ACTIVE" ? "User disabled" : "User enabled")}>
                    {u.status === "ACTIVE" ? "Disable" : "Enable"}
                  </Button>
                  <Button size="xs" variant="text" disabled={isLoading} onClick={() => act(u.id, { isPlatformAdmin: !u.isPlatformAdmin }, u.isPlatformAdmin ? "Admin access removed" : "Admin access granted")}>
                    {u.isPlatformAdmin ? "Remove admin" : "Make admin"}
                  </Button>
                </div>
              );
            },
          },
        ]}
      />
    </>
  );
}
