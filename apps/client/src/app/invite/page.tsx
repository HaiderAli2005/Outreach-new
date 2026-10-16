"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthGate } from "@/components/shell/session";
import { Button } from "@/components/ui/primitives";
import { Mark } from "@/components/ui/Icon";
import { errorMessage, refreshSession, useAcceptInviteMutation } from "@/store/api";
import { useAppDispatch, useAppSelector } from "@/store";
import { sessionReceived } from "@/store/authSlice";

function Accept() {
  const token = useSearchParams().get("token") ?? "";
  const [accept, { isLoading }] = useAcceptInviteMutation();
  const [err, setErr] = useState("");
  const dispatch = useAppDispatch();
  const router = useRouter();
  const email = useAppSelector((s) => s.auth.user?.email);

  async function go() {
    setErr("");
    try {
      const r = await accept({ token }).unwrap();
      const s = await refreshSession(r.organizationId);
      if (s) dispatch(sessionReceived(s));
      router.replace("/app");
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  return (
    <div className="shell-bg" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card glass" style={{ width: "min(460px, 100%)", padding: 30 }}>
        <Mark className="loader-mark" />
        <h1 className="ob-h sm">Join the team.</h1>
        <p className="ob-p">
          You were invited to an Aperture workspace. You are signed in as <b>{email}</b>, which must match the invited address.
        </p>
        {!token ? <div className="banner bad" style={{ marginTop: 16 }}>This invite link is missing its token.</div> : null}
        {err ? (
          <div className="banner bad" role="alert" style={{ marginTop: 16 }}>
            {err}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          <Button variant="primary" arrow loading={isLoading} disabled={!token} onClick={go}>
            Accept invite
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <Suspense>
        <Accept />
      </Suspense>
    </AuthGate>
  );
}
