"use client";

import { AuthHeader } from "@/components/auth/AuthHeader";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard } from "@/components/onboarding/AuthStep";
import { useSessionBootstrap, FullPageLoader } from "@/components/shell/session";
import { useAppDispatch } from "@/store";
import { api } from "@/store/api";
import type { Session } from "@/lib/types";

function safeNext(v: string | null): string | null {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : null;
}

function SignIn() {
  const params = useSearchParams();
  const router = useRouter();
  const status = useSessionBootstrap();
  const [mode, setMode] = useState<"up" | "in">(params.get("mode") === "up" ? "up" : "in");
  const next = safeNext(params.get("next"));
  const oauthError = params.get("error");
  const dispatch = useAppDispatch();
  const signedInHere = useRef(false);

  async function afterSignIn(session: Session) {
    if (next) return router.replace(next);
    if (!session.organizations.length) return router.replace("/onboarding");
    const query = dispatch(api.endpoints.onboarding.initiate(undefined, { forceRefetch: true }));
    try {
      const state = await query.unwrap();
      router.replace(state.onboarding?.launchedAt ? "/app" : "/onboarding");
    } catch {
      router.replace("/app");
    } finally {
      query.unsubscribe();
    }
  }

  useEffect(() => {
    if (status === "authed" && !signedInHere.current) router.replace(next ?? "/app");
  }, [status, next, router]);

  if (status === "idle" || status === "loading" || status === "authed") return <FullPageLoader />;

  return (
    <div id="onboard" className="is-auth" style={{ minHeight: "100vh" }}>
      <AuthHeader />
      {oauthError ? (
        <div style={{ width: "min(460px, calc(100% - 32px))", margin: "24px auto -12px" }}>
          <div className="banner bad" role="alert">
            {oauthError}
          </div>
        </div>
      ) : null}
      <AuthCard mode={mode} onMode={setMode} next={next ?? "/app"} onDone={(s) => {
          signedInHere.current = true;
          if (mode === "up") router.replace("/onboarding");
          else void afterSignIn(s);
        }}
      />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <SignIn />
    </Suspense>
  );
}
