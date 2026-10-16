"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSessionBootstrap, FullPageLoader } from "@/components/shell/session";

function Callback() {
  const status = useSessionBootstrap();
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const n = params.get("next");
    const next = n && n.startsWith("/") && !n.startsWith("//") ? n : "/app";
    if (status === "authed") router.replace(next);
    if (status === "anon") router.replace("/signin?error=" + encodeURIComponent("Sign-in didn't complete, please try again"));
  }, [status, params, router]);
  return <FullPageLoader label="Signing you in" />;
}

export default function Page() {
  return (
    <Suspense fallback={<FullPageLoader label="Signing you in" />}>
      <Callback />
    </Suspense>
  );
}
