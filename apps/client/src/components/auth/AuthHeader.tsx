"use client";

import Link from "next/link";
import { useRef } from "react";
import { useLiquidGlass } from "@/components/ui/liquidGlass";
import { Icon, Mark } from "@/components/ui/Icon";

/** The floating pill bar on every sign-in and sign-up screen, so they all share one header. */
export function AuthHeader({ href = "/", label = "Back to site" }: { href?: string | null; label?: string }) {
  const bar = useRef<HTMLDivElement>(null);
  useLiquidGlass(bar, { scale: 24, bezel: 20 });
  return (
    <header className="obh">
      <div className="obh-in nav-in glass lg" ref={bar}>
        <Link className="logo" href="/" aria-label="Aperture home">
          <Mark />
          <span>Aperture</span>
        </Link>
        <span style={{ flex: 1 }} />
        {href ? (
          <Link className="obh-exit" href={href}>
            <Icon id="back" />
            <span>{label}</span>
          </Link>
        ) : null}
      </div>
    </header>
  );
}
