"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAppDispatch, useAppSelector } from "@/store";
import { api, refreshSession, useLogoutMutation } from "@/store/api";
import { restoring, sessionReceived, signedOut } from "@/store/authSlice";
import { Mark } from "@/components/ui/Icon";

export function useSessionBootstrap() {
  const dispatch = useAppDispatch();
  const status = useAppSelector((s) => s.auth.status);
  useEffect(() => {
    if (status !== "idle") return;
    dispatch(restoring());
    refreshSession().then((s) => dispatch(s ? sessionReceived(s) : signedOut()));
  }, [dispatch, status]);
  return status;
}

export function useSignOut() {
  const [logout] = useLogoutMutation();
  const dispatch = useAppDispatch();
  const router = useRouter();
  return async () => {
    await logout().catch(() => undefined);
    dispatch(signedOut());
    dispatch(api.util.resetApiState());
    router.replace("/signin");
  };
}

export function FullPageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }} aria-busy="true">
      <div style={{ display: "grid", justifyItems: "center", gap: 14, color: "var(--ink-3)", fontSize: 14 }}>
        <Mark className="loader-mark" />
        <span>{label}</span>
      </div>
    </div>
  );
}

export function AuthGate({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const status = useSessionBootstrap();
  const user = useAppSelector((s) => s.auth.user);
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (status === "anon") router.replace(`/signin?next=${encodeURIComponent(path + window.location.search)}`);
  }, [status, router, path]);
  if (status !== "authed" || !user) return <FullPageLoader />;
  if (admin && !user.isPlatformAdmin)
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
        <div className="card glass" style={{ maxWidth: 420, textAlign: "center" }}>
          <h5>Not available</h5>
          <p style={{ color: "var(--ink-2)", margin: "0 0 16px" }}>The admin console is only for platform administrators.</p>
          <a className="btn btn-ghost btn-sm" href="/app">
            Back to the app
          </a>
        </div>
      </div>
    );
  return <>{children}</>;
}
