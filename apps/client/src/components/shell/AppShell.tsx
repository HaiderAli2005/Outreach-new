"use client";

import { OutOfCredit } from "@/components/billing/OutOfCredit";
import { ThemeToggle } from "./ThemeToggle";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, Mark, type IconId } from "@/components/ui/Icon";
import { useAppDispatch, useAppSelector } from "@/store";
import { api, refreshSession, useCampaignsNavQuery, useLaunchViewQuery, useNavCountsQuery } from "@/store/api";
import { sessionReceived } from "@/store/authSlice";
import { FullPageLoader, useSignOut } from "./session";
import { useInboxLive } from "./useInboxLive";
import { RailToggle, useRailCollapse } from "./RailToggle";
import type { NavCounts } from "@/lib/types";
import { normDomain, validDomain } from "@/lib/format";
import { SiteNotice, useSiteCheck } from "@/components/domain/SiteCheck";

interface NavItem {
  href: string;
  label: string;
  icon: IconId;
  badge?: (c: NavCounts) => { n: number; tone?: "muted" | "bad" } | null;
}

const OUTREACH: NavItem[] = [
  { href: "/app", label: "Cockpit", icon: "home" },
  { href: "/app/inbox", label: "Inbox", icon: "inbox", badge: (c) => (c.inboxAwaiting ? { n: c.inboxAwaiting } : null) },
  { href: "/app/leads", label: "Leads", icon: "users", badge: (c) => (c.leadsPending ? { n: c.leadsPending } : null) },
];

/** The workspace's active campaign: what it says, who it reaches, what it sends and when. */
const SETUP: NavItem[] = [
  { href: "/app/setup/profile", label: "Business profile", icon: "building" },
  { href: "/app/setup/targeting", label: "Targeting", icon: "target" },
  { href: "/app/setup/sequence", label: "Email sequence", icon: "st-mail" },
  { href: "/app/setup/schedule", label: "Sending schedule", icon: "calendar" },
  { href: "/app/suppression", label: "Suppress list", icon: "ban", badge: (c) => (c.blocklist ? { n: c.blocklist, tone: "muted" } : null) },
];

const WORKSPACE: NavItem[] = [
  { href: "/app/billing/credits", label: "Credits", icon: "card" },
  { href: "/app/system", label: "System", icon: "pulse", badge: (c) => (c.systemAlerts ? { n: c.systemAlerts, tone: "bad" } : null) },
];

function isActive(path: string, href: string) {
  return href === "/app" ? path === "/app" : path === href || path.startsWith(`${href}/`);
}

function useReplyNotifications(counts: NavCounts | undefined) {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!counts?.browserNotifications || !counts.latestReplyAt || typeof Notification === "undefined") return;
    if (last.current && counts.latestReplyAt > last.current && Notification.permission === "granted") {
      new Notification("New reply in Aperture", { body: `${counts.inboxAwaiting} conversation${counts.inboxAwaiting === 1 ? "" : "s"} waiting for you`, tag: "ap-reply" });
    }
    last.current = counts.latestReplyAt;
  }, [counts?.browserNotifications, counts?.latestReplyAt, counts?.inboxAwaiting]);
}

/**
 * Shown on every page only when money needs attention: no card yet, under two days of budget once sending has
 * started, $2 or less (cold email paused, conversations running), or nothing left (everything paused). A new customer
 * on the free credit sees no warning.
 */
function CreditsBanner({ counts }: { counts: NavCounts }) {
  if (counts.balanceStage === "unfunded")
    return (
      <div className="ap-banner warn" role="status">
        <span>Add a card to start sending. You get free credit and nothing is charged.</span>
        <Link className="btn btn-sm btn-primary" href="/app/billing/credits">
          Add your card
        </Link>
      </div>
    );
  if (counts.balanceStage === "empty")
    return (
      <div className="ap-banner bad" role="alert">
        <span>Your balance is used up. Everything is paused, including replies to your live conversations. Add credits to resume.</span>
        <Link className="btn btn-sm btn-primary" href="/app/billing/credits">
          Add credits
        </Link>
      </div>
    );
  if (counts.balanceStage === "reserve")
    return (
      <div className="ap-banner warn" role="status">
        <span>Cold email is paused. Your live conversations are still running. Add credits to resume sending.</span>
        <Link className="btn btn-sm btn-primary" href="/app/billing/credits">
          Add credits
        </Link>
      </div>
    );
  if (counts.balanceStage === "low")
    return (
      <div className="ap-banner warn">
        <span>
          {counts.runsOut
            ? `Sending pauses ${counts.runsOut === "today" || counts.runsOut === "tomorrow" ? counts.runsOut : `on ${counts.runsOut}`} at your daily budget. Add credits to keep it going.`
            : `Your balance is getting low: ${counts.balance} left. Add credits to keep sending.`}
        </span>
        <Link className="btn btn-sm btn-ghost" href="/app/billing/credits">
          Add credits
        </Link>
      </div>
    );
  return null;
}

/** Until the first batch is approved, nothing sends: say so on every page, with no countdown of any kind. */
function LaunchBanner({ path }: { path: string }) {
  const { data } = useLaunchViewQuery(undefined, { pollingInterval: 120_000, skipPollingIfUnfocused: true });
  if (!data || data.approved || data.launchMode === "AUTO" || path.startsWith("/app/approve") || !data.ready) return null;
  // The dashboard's own status card already says this, with the same numbers; two messages that disagree confuse.
  if (path === "/app") return null;
  // While the first people are still being written, "ready" would be premature.
  if (data.launchMode === "APPROVE_FIRST_BATCH" && data.ready < data.needed && data.preparing > 0) return null;
  return (
    <div className="ap-banner">
      <span>
        {data.launchMode === "APPROVE_EACH" ? `${data.ready} people are waiting for your approval.` : `Your first ${data.ready >= data.needed ? data.needed : data.ready} people and their emails are ready.`} Nothing is sent until you approve them.
      </span>
      <Link className="btn btn-sm btn-primary" href="/app/approve">
        Review and approve
      </Link>
    </div>
  );
}

const TITLES: [string, string][] = [
  ["/app/inbox", "Inbox"],
  ["/app/leads", "Leads"],
  ["/app/setup/profile", "Business profile"],
  ["/app/setup/targeting", "Targeting"],
  ["/app/setup/sequence", "Email sequence"],
  ["/app/setup/schedule", "Sending schedule"],
  ["/app/campaigns", "Campaigns"],
  ["/app/campaign", "Campaign"],
  ["/app/suppression", "Suppress list"],
  ["/app/settings", "Settings"],
  ["/app/billing", "Credits"],
  ["/app/system", "System"],
  ["/app/approve", "Approve"],
];

function titleFor(path: string): string {
  return TITLES.find(([p]) => path === p || path.startsWith(`${p}/`))?.[1] ?? "Cockpit";
}

/** The balance, always in view in the top bar. It opens Credits, where topping up lives. */
function BalanceChip({ counts }: { counts: NavCounts | undefined }) {
  if (!counts) return null;
  return (
    <Link className={`ap-chip${counts.balanceStage === "empty" ? " bad" : counts.balanceStage === "low" || counts.balanceStage === "reserve" ? " warn" : ""}`} href="/app/billing/credits" title={`About ${counts.emailsLeft.toLocaleString("en-US")} emails left`}>
      <Icon id="coins" />
      <b>{counts.balance}</b>
    </Link>
  );
}

/** A new domain is a new workspace. Setup creates it (or switches to the one you already have) and runs its own setup. */
function AddWorkspace({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  const site = useSiteCheck();
  const go = (d: string) => {
    onDone();
    router.push(`/onboarding?domain=${encodeURIComponent(d)}`);
  };
  if (!open)
    return (
      <button type="button" role="menuitem" onClick={() => setOpen(true)}>
        <Icon id="plus" />
        Add a workspace
      </button>
    );
  return (
    <form
      className="ap-pop-add"
      onSubmit={(e) => {
        e.preventDefault();
        const d = normDomain(v);
        if (!validDomain(d)) return setErr("Enter a website, like acme.com");
        void site.run(d).then((r) => {
          if (r?.status === "missing") setErr(r.message ?? "We can't find that domain.");
          else if (r?.status !== "unreadable") go(d);
        });
      }}
    >
      <input className="input" autoFocus value={v} placeholder="yourcompany.com" aria-label="Website for the new workspace" onChange={(e) => (setV(e.target.value), setErr(""), site.clear())} />
      <button type="submit" className="btn btn-sm btn-primary" disabled={site.busy}>
        {site.busy ? "Checking" : "Add"}
      </button>
      {err ? <small role="alert">{err}</small> : null}
      {site.result?.status === "unreadable" ? (
        <SiteNotice check={site.result} retrying={site.busy} onContinue={() => go(site.result!.domain)} onRetry={() => void site.run(site.result!.domain, true).then((r) => r?.status === "ok" && go(r.domain))} />
      ) : null}
    </form>
  );
}

/** Pages put their own action in the top bar (the Cockpit's Start / Stop outreach) through this slot. */
export const TOP_ACTIONS_ID = "ap-top-actions";

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { user, organizations, activeOrgId } = useAppSelector((s) => s.auth);
  const org = organizations.find((o) => o.id === activeOrgId) ?? null;
  const noOrg = organizations.length === 0;
  const { data: counts } = useNavCountsQuery(undefined, { pollingInterval: 60_000, skipPollingIfUnfocused: true, refetchOnFocus: true, skip: noOrg });
  const { data: campaignsNav } = useCampaignsNavQuery(undefined, { pollingInterval: 120_000, skipPollingIfUnfocused: true, skip: noOrg });
  const [open, setOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [meOpen, setMeOpen] = useState(false);
  const [mini, toggleMini] = useRailCollapse(() => (setWsOpen(false), setMeOpen(false)));
  const signOut = useSignOut();
  useReplyNotifications(counts);
  useInboxLive(!noOrg);

  useEffect(() => {
    setOpen(false);
    setWsOpen(false);
    setMeOpen(false);
  }, [path]);

  // Without a workspace there is nothing for the app to show: every page and the whole menu belong to one. Setup
  // starts from the domain, so anyone who lands here (a typed /app, an old bookmark, a deleted last workspace) goes there.
  useEffect(() => {
    if (noOrg) router.replace("/onboarding");
  }, [noOrg, router]);

  async function switchOrg(id: string) {
    setWsOpen(false);
    const s = await refreshSession(id);
    if (s) {
      dispatch(sessionReceived(s));
      dispatch(api.util.resetApiState());
      router.push("/app");
    }
  }

  const renderItem = (it: NavItem) => {
    const b = counts && it.badge ? it.badge(counts) : null;
    const on = isActive(path, it.href);
    return (
      <li key={it.href}>
        <Link href={it.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined} title={mini ? it.label : undefined}>
          <Icon id={it.icon} />
          <span className="lb">{it.label}</span>
          {b ? <span className={`n${b.tone === "bad" ? " bad" : b.tone === "muted" ? " muted" : ""}`}>{b.n > 999 ? "999+" : b.n}</span> : null}
        </Link>
      </li>
    );
  };
  const initials = (user?.name ?? user?.email ?? "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");

  if (noOrg) return <FullPageLoader label="Opening setup" />;

  return (
    <div className={`ap-shell${mini ? " mini" : ""}`}>
      <aside className={`ap-rail${open ? " open" : ""}`} aria-label="Main navigation">
        <div className="ap-brand-row">
          <Link className="ap-brand" href="/app" title={mini ? "Aperture" : undefined}>
            <Mark />
            <span className="lb">Aperture</span>
          </Link>
          <RailToggle mini={mini} onClick={toggleMini} />
        </div>
        <div style={{ position: "relative" }}>
          <button type="button" className="ap-ws" title={mini ? (org?.primaryDomain ?? org?.name ?? "Workspace") : undefined} aria-expanded={wsOpen} aria-haspopup="menu" onClick={() => setWsOpen((o) => !o)}>
            <span className="fav">{(org?.name ?? "A").charAt(0).toUpperCase()}</span>
            <span className="n">
              <b>{org?.primaryDomain ?? org?.name ?? "Workspace"}</b>
              <small>{counts ? (counts.autopilotEnabled ? "Autopilot on" : "Autopilot off") : " "}</small>
            </span>
            <Icon id="chev" className="ap-chev" />
          </button>
          {wsOpen ? (
            <div className="ap-pop" role="menu" style={{ top: "calc(100% + 6px)", bottom: "auto" }}>
              <div className="ap-pop-h">Workspaces</div>
              {organizations.map((o) => (
                <button key={o.id} type="button" role="menuitem" onClick={() => (o.id === activeOrgId ? setWsOpen(false) : void switchOrg(o.id))}>
                  {o.id === activeOrgId ? <Icon id="check" /> : <Icon id="building" />}
                  {o.primaryDomain ?? o.name}
                </button>
              ))}
              {user ? <AddWorkspace onDone={() => setWsOpen(false)} /> : null}
            </div>
          ) : null}
        </div>
        <div className="ap-rail-scroll">
        <div className="ap-sec">Outreach</div>
        <ul className="ap-nav">{OUTREACH.map(renderItem)}</ul>
        {/* Each campaign has its own workspace; the section title opens the overview of all of them. */}
        <div className="ap-sec ap-sec-link">
          <Link href="/app/campaigns" aria-current={path === "/app/campaigns" ? "page" : undefined}>
            Campaigns
          </Link>
        </div>
        <ul className="ap-nav ap-camp-nav">
          {(campaignsNav ?? []).map((cp) => {
            const href = `/app/campaign/${encodeURIComponent(cp.id)}`;
            const on = path === href;
            const said = cp.state === "on" ? "sending" : cp.state === "paused" ? "paused" : "off";
            return (
              <li key={cp.id}>
                <Link href={href} className={on ? "on" : ""} aria-current={on ? "page" : undefined} title={mini ? `${cp.name} (${said})` : said === "sending" ? undefined : `${cp.name} is ${said}`}>
                  <span className={`ap-cdot is-${cp.state}`} aria-label={said} />
                  <span className="lb">{cp.name}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <Link href="/app/campaigns/new" className={`ap-new${path === "/app/campaigns/new" ? " on" : ""}`} title={mini ? "New campaign" : undefined}>
              <Icon id="plus" />
              <span className="lb">New campaign</span>
            </Link>
          </li>
        </ul>
        <div className="ap-sec">Setup</div>
        <ul className="ap-nav">{SETUP.map(renderItem)}</ul>
        <div className="ap-sec">Workspace</div>
        <ul className="ap-nav">
          {WORKSPACE.map(renderItem)}
          {user?.isPlatformAdmin ? renderItem({ href: "/admin", label: "Admin console", icon: "shield" }) : null}
        </ul>
        </div>
        <div className="ap-rail-foot">
          {meOpen ? (
            <div className="ap-pop" role="menu">
              <Link href="/app/settings" role="menuitem">
                <Icon id="gear" />
                Settings
              </Link>
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
              <small>{org?.role.toLowerCase()}</small>
            </span>
            <Icon id="chev" className="ap-chev" />
          </button>
        </div>
      </aside>

      <div className="ap-main">
        <header className="ap-top">
          <button className="btn btn-ghost btn-sm ap-burger" type="button" onClick={() => setOpen(true)} aria-label="Open menu">
            <Icon id="menu" />
            {counts?.inboxAwaiting ? <span className="badge-n" style={{ marginLeft: 4 }}>{counts.inboxAwaiting}</span> : null}
          </button>
          <h1>{titleFor(path)}</h1>
          <span className="sp" />
          <div className="ap-actions">
            <ThemeToggle />
            <BalanceChip counts={counts} />
            <div id={TOP_ACTIONS_ID} className="ap-actions" />
          </div>
        </header>
        <main className="ap-view">
          {counts ? <CreditsBanner counts={counts} /> : null}
          {counts && activeOrgId ? <OutOfCredit counts={counts} orgId={activeOrgId} path={path} /> : null}
          <LaunchBanner path={path} />
          {children}
        </main>
      </div>
      {open ? <button type="button" className="ap-scrim" aria-label="Close menu" onClick={() => setOpen(false)} /> : null}
    </div>
  );
}
