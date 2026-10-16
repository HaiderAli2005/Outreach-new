import type { Metadata } from "next";
import { AuthGate } from "@/components/shell/session";
import { AdminShell } from "@/components/shell/AdminShell";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate admin>
      <AdminShell>{children}</AdminShell>
    </AuthGate>
  );
}
