"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icon, Mark, type IconId } from "@/components/ui/Icon";
import { useAppSelector } from "@/store";
import { useSignOut } from "./session";

const NAV: [string, string, IconId][] = [
  ["/admin", "Overview", "home"],
  ["/admin/organizations", "Organizations", "building"],
  ["/admin/users", "Users", "users"],
  ["/admin/pool", "Sending pool", "globe"],
  ["/admin/domains", "Domains", "at"],
  ["/admin/unmatched", "Unmatched replies", "inbox"],
  ["/admin/corrections", "Reply corrections", "sliders"],
  ["/admin/payments", "Payments", "card"],
  ["/admin/webhooks", "Webhook events", "rotate"],
  ["/admin/logs", "System logs", "pulse"],
];

export function AdminShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const user = useAppSelector((s) => s.auth.user);
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  return (
    <div className="shell-bg" style={{ minHeight: "100vh" }}>
      <div className="ob no-aside">
        <aside className={`rail glass${open ? " open" : ""}`} aria-label="Admin navigation">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Link className="logo" href="/admin">
              <Mark />
              Aperture
            </Link>
            {open ? (
              <button className="btn btn-text btn-xs hide-lg" type="button" onClick={() => setOpen(false)} aria-label="Close menu">
                <Icon id="x" />
              </button>
            ) : null}
          </div>
          <div className="rail-dom">
            <span className="fav">
              <Icon id="shield" className="nav-ic" />
            </span>
            <div>
              <b>Admin console</b>
              <small className="muted">Platform-wide view</small>
            </div>
          </div>
          <ol className="steps">
            {NAV.map(([href, label, icon]) => {
              const on = href === "/admin" ? path === "/admin" : path.startsWith(href);
              return (
                <li key={href} className={on ? "cur" : ""}>
                  <Link href={href} aria-current={on ? "page" : undefined}>
                    <Icon id={icon} className="nav-ic" />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ol>
          <div className="rail-foot">
            <Link className="btn btn-ghost btn-sm" href="/app">
              <Icon id="back" />
              Back to the app
            </Link>
            <div className="kv">
              <span>{user?.email}</span>
            </div>
            <button className="btn btn-text btn-sm" type="button" onClick={signOut}>
              <Icon id="logout" />
              Sign out
            </button>
          </div>
        </aside>
        <div className="ob-main">
          <div className="rail-mob glass">
            <div className="rm-top">
              <Link className="logo" href="/admin">
                <Mark />
                Admin
              </Link>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(true)}>
                <Icon id="menu" />
                Menu
              </button>
            </div>
          </div>
          <main className="ob-view tight app-view">{children}</main>
        </div>
      </div>
    </div>
  );
}
