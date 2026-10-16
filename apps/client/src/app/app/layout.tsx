import type { Metadata } from "next";
import { AuthGate } from "@/components/shell/session";
import { AppShell } from "@/components/shell/AppShell";

export const metadata: Metadata = { title: "App" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}
