"use client";

import { useRef, type ReactNode } from "react";
import { useLiquidGlass } from "@/components/ui/liquidGlass";

/** The sign-in and sign-up card, in the same liquid glass as the navbar. */
export function AuthShell({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLiquidGlass(ref, { scale: 24, bezel: 20 });
  return (
    <div className="au-shell lg" ref={ref}>
      <section className="au-col">{children}</section>
    </div>
  );
}
