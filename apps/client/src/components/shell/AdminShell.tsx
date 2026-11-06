"use client";

import { ThemeToggle } from "./ThemeToggle";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icon, Mark, type IconId } from "@/components/ui/Icon";
import { useAppSelector } from "@/store";
import { useSignOut } from "./session";
import { RailToggle, useRailCollapse } from "./RailToggle";

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

const isOn = (path: string, href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));

/** The admin console wears the same rail as the app, so moving between them feels like one product. */
export function AdminShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const user = useAppSelector((s) => s.auth.user);
  const signOut = useSignOut();
  const [open, setOpen] = useState(false);
  const [meOpen, setMeOpen] = useState(false);
  const [mini, toggleMini] = useRailCollapse(() => setMeOpen(false));

  useEffect(() => {
    setOpen(false);
    setMeOpen(false);
  }, [path]);

  const initials = (user?.name ?? user?.email ?? "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
  const title = NAV.find(([href]) => isOn(path, href))?.[1] ?? "Admin";

  return (
    <div className={`ap-shell${mini ? " mini" : ""}`}>
      <aside className={`ap-rail${open ? " open" : ""}`} aria-label="Admin navigation">
        <div className="ap-brand-row">
          <Link className="ap-brand" href="/admin" title={mini ? "Aperture" : undefined}>
            <Mark />
            <span className="lb">Aperture</span>
          </Link>
          <RailToggle mini={mini} onClick={toggleMini} />
        </div>
        <div className="ap-ws static" title={mini ? "Admin console" : undefined}>
          <span className="fav">
            <Icon id="shield" />
          </span>
          <span className="n">
            <b>Admin console</b>
            <small>Platform-wide view</small>
          </span>
        </div>
        <div className="ap-sec">Console</div>
        <ul className="ap-nav">
          {NAV.map(([href, label, icon]) => {
            const on = isOn(path, href);
            return (
              <li key={href}>
                <Link href={href} className={on ? "on" : ""} aria-current={on ? "page" : undefined} title={mini ? label : undefined}>
                  <Icon id={icon} />
                  <span className="lb">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="ap-sec">Workspace</div>
        <ul className="ap-nav">
          <li>
            <Link href="/app" title={mini ? "Back to the app" : undefined}>
              <Icon id="back" />
              <span className="lb">Back to the app</span>
            </Link>
          </li>
        </ul>
        <div className="ap-rail-foot">
          {meOpen ? (
            <div className="ap-pop" role="menu">
              <button type="button" role="menuitem" onClick={signOut}>
                <Icon id="logout" />
                Sign out
              </button>
            </div>
          ) : null}
          <button type="button" className="ap-me" title={mini ? (user?.name ?? user?.email) : undefined} aria-expanded={meOpen} aria-haspopup="menu" onClick={() => setMeOpen((o) => !o)}>
            <span className="av">{initials}</span>
            <span className="n">
              <b>{user?.name ?? user?.email}</b>
              <small>Platform admin</small>
            </span>
            <Icon id="chev" className="ap-chev" />
          </button>
        </div>
      </aside>

      <div className="ap-main">
        <header className="ap-top">
          <button className="btn btn-ghost btn-sm ap-burger" type="button" onClick={() => setOpen(true)} aria-label="Open menu">
            <Icon id="menu" />
          </button>
          <h1>{title}</h1>
          <span className="sp" />
          <ThemeToggle />
        </header>
        <main className="ob-view tight app-view adm-view">{children}</main>
      </div>
      {open ? <button type="button" className="ap-scrim" aria-label="Close menu" onClick={() => setOpen(false)} /> : null}
    </div>
  );
}
