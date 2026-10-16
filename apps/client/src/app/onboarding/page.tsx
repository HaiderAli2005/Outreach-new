import { Suspense } from "react";
import type { Metadata } from "next";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { FullPageLoader } from "@/components/shell/session";

export const metadata: Metadata = { title: "Setup" };

export default function Page() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <Onboarding />
    </Suspense>
  );
}
