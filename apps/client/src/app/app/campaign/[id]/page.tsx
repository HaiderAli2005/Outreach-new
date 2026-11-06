"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { Icon, type IconId } from "@/components/ui/Icon";
import { Button, Chip, ErrorState, Skeleton } from "@/components/ui/primitives";
import { CAMPAIGN_STATE } from "@/components/app/CampaignsCard";
import { useRole, useToast } from "@/store";
import { errorMessage, useCampaignWorkspaceQuery, useSaveTargetingMutation, useTargetingQuery } from "@/store/api";
import { ago, n0 } from "@/lib/format";
import type { CampaignWorkspace } from "@/lib/types";

/**
 * One campaign's workspace. The header says what it is and whether it is sending; the story on the left says what
 * happened, day by day; the tabs on the right hold its brief (who and why), its leads, and its results.
 */

type Tab = "brief" | "leads" | "results";
const EVENT: Record<CampaignWorkspace["timeline"][number]["kind"], { icon: IconId; tone: string }> = {
  launch: { icon: "flame", tone: "gold" },
  found: { icon: "users", tone: "ink" },
  approved: { icon: "check", tone: "warn" },
  sent: { icon: "plane", tone: "blue" },
  reply: { icon: "inbox", tone: "good" },
};
const sizeBand = (n: number | null) => (n === null ? "–" : n <= 10 ? "1–10" : n <= 50 ? "11–50" : n <= 200 ? "51–200" : n <= 1000 ? "201–1,000" : "1,000+");
const STEP_NAME = ["First email", "Follow-up 1", "Follow-up 2", "Follow-up 3"];

function dayHeading(at: string) {
  const d = new Date(at);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** A titled group of chips; renders nothing when the list is empty, so the brief never shows hollow labels. */
function Chips({ icon, title, items, tone }: { icon: IconId; title: string; items: string[]; tone?: "bad" }) {
  if (!items.length) return null;
  return (
    <div className="cw-group">
      <h4>
        <Icon id={icon} />
        {title}
      </h4>
      <div className="cw-chips">
        {items.map((x) => (
          <span key={x} className={`cw-chip${tone ? ` ${tone}` : ""}`}>
            {x}
          </span>
        ))}
      </div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="ap-card cw-sec">
      <div className="ap-card-h">
        <h2>{title}</h2>
        <span className="sp" />
        {action}
      </div>
      <div className="cw-sec-b">{children}</div>
    </section>
  );
}

function Brief({ w }: { w: CampaignWorkspace }) {
  const b = w.brief;
  const edit = (
    <Link className="meta" href="/app/setup/targeting">
      Edit in Targeting
    </Link>
  );
  return (
    <div className="cw-stack">
      <Section
        title="The offer"
        action={
          <Link className="meta" href="/app/setup/profile">
            Edit in Business profile
          </Link>
        }
      >
        {w.offer.valueProp ? <p className="cw-lead">{w.offer.valueProp}</p> : <p className="cw-muted">No offer written yet. Add one in your Business profile so every email leads with it.</p>}
        {w.offer.proof.length ? (
          <ul className="cw-proof">
            {w.offer.proof.map((p) => (
              <li key={p.claim}>
                <Icon id="check" />
                <span>
                  {p.claim}
                  {p.source ? <small>{p.source}</small> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="cw-note">Shared by all your campaigns.</p>
      </Section>
      {b ? (
        <>
          <Section title="Why they buy" action={edit}>
            {b.why ? <p className="cw-lead">{b.why}</p> : null}
            <Chips icon="target" title="What they want" items={b.goals} />
            <Chips icon="alert" title="What hurts today" items={b.pains} />
            <Chips icon="shield" title="Likely objections" items={b.objections} />
          </Section>
          <Section title="Who to contact" action={edit}>
            <Chips icon="users" title={b.includeSimilarTitles ? "Job titles, and similar ones" : "Job titles"} items={b.titles} />
            <Chips icon="briefcase" title="Seniority" items={b.seniorities} />
            <Chips icon="globe" title="Where" items={b.regions} />
            <Chips icon="building" title="Company size" items={b.sizes.map((s) => `${s} people`)} />
          </Section>
          <Section title="How we find them" action={edit}>
            <Chips icon="search" title="Keywords" items={b.keywords} />
            <Chips icon="cpu" title="Technologies they use" items={b.technologies} />
            <Chips icon="link" title="Companies like" items={b.lookalikeDomains} />
            <Chips icon="ban" title="Never contact" items={b.excludeDomains} tone="bad" />
            {!b.keywords.length && !b.technologies.length && !b.lookalikeDomains.length && !b.excludeDomains.length ? <p className="cw-muted">Found by job title, seniority, place and company size alone.</p> : null}
          </Section>
        </>
      ) : (
        <Section title="Who these people are">
          <p className="cw-muted">People you uploaded yourself. They have no audience brief: they are emailed as they are.</p>
        </Section>
      )}
    </div>
  );
}

/** A small ranked breakdown: label, a bar against the largest, and the count. */
function Breakdown({ icon, title, rows }: { icon: IconId; title: string; rows: [string, number][] }) {
  const top = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div className="ap-card cw-break">
      <h4>
        <Icon id={icon} />
        {title}
      </h4>
      {rows.length ? (
        <ul>
          {rows.map(([label, n]) => (
            <li key={label}>
              <span className="l">{label}</span>
              <span className="t">
                <i style={{ width: `${(n / top) * 100}%` }} />
              </span>
              <b>{n0(n)}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="cw-muted">Nothing to break down yet.</p>
      )}
    </div>
  );
}

function Leads({ w }: { w: CampaignWorkspace }) {
  const [view, setView] = useState<"companies" | "people">("companies");
  const EMAIL: Record<CampaignWorkspace["people"][number]["email"], { label: string; tone: "g" | "r" | "v" }> = { ok: { label: "Can email", tone: "g" }, bad: { label: "No usable address", tone: "r" }, checking: { label: "Checking", tone: "v" } };
  return (
    <div className="cw-stack">
      <div className="cw-breaks">
        <Breakdown icon="globe" title="Where they are" rows={w.breakdown.countries} />
        <Breakdown icon="building" title="Company size" rows={w.breakdown.sizes} />
      </div>
      <section className="ap-card">
        <div className="ap-card-h">
          <div className="cw-seg" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={view === "companies"} onClick={() => setView("companies")}>
              Companies <span>{n0(w.companies.length)}</span>
            </button>
            <button type="button" role="tab" aria-selected={view === "people"} onClick={() => setView("people")}>
              People <span>{n0(w.progress.found)}</span>
            </button>
          </div>
          <span className="sp" />
          <Link className="meta" href="/app/leads">
            Open all leads
          </Link>
        </div>
        <div className="ap-tbl-wrap">
          {view === "companies" ? (
            w.companies.length ? (
              <table className="ap-tbl cw-tbl">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>What they do</th>
                    <th>Country</th>
                    <th>Size</th>
                    <th className="r">People</th>
                  </tr>
                </thead>
                <tbody>
                  {w.companies.map((c) => (
                    <tr key={c.domain}>
                      <td className="s">
                        {c.name}
                        <small>{c.domain}</small>
                      </td>
                      <td className="cw-desc">{c.description ?? "–"}</td>
                      <td>{c.country ?? "–"}</td>
                      <td>{sizeBand(c.employees)}</td>
                      <td className="r">{n0(c.people)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="cw-muted cw-pad">No companies yet. They appear as people are found.</p>
            )
          ) : w.people.length ? (
            <table className="ap-tbl cw-tbl">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Company</th>
                  <th>Country</th>
                  <th>Email</th>
                  <th className="r">Latest</th>
                </tr>
              </thead>
              <tbody>
                {w.people.map((p) => (
                  <tr key={p.id}>
                    <td className="s">
                      {p.fullName ?? "Unnamed"}
                      {p.title ? <small>{p.title}</small> : null}
                    </td>
                    <td>{p.company ?? p.companyDomain ?? "–"}</td>
                    <td>{p.country ?? "–"}</td>
                    <td>
                      <Chip tone={EMAIL[p.email].tone}>{EMAIL[p.email].label}</Chip>
                    </td>
                    <td className="r cw-when">{p.repliedAt ? `replied ${ago(p.repliedAt)}` : p.firstContactedAt ? `emailed ${ago(p.firstContactedAt)}` : "not emailed yet"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="cw-muted cw-pad">No people yet.</p>
          )}
        </div>
        {view === "people" && w.progress.found > w.people.length ? <p className="cw-note cw-pad">Showing the {n0(w.people.length)} most recent of {n0(w.progress.found)}. Open all leads to search them.</p> : null}
      </section>
    </div>
  );
}

function Results({ w }: { w: CampaignWorkspace }) {
  const p = w.progress;
  const pc = (n: number) => (p.found ? `${(n / p.found) * 100}%` : "0%");
  const funnel = [
    { label: "Found", n: p.found },
    { label: "Can be emailed", n: p.canEmail },
    { label: "Emailed", n: p.emailed },
    { label: "Replied", n: p.replied },
    { label: "Hot leads", n: p.hot },
  ];
  const stepTop = Math.max(1, ...p.steps.map((s) => s.sent));
  return (
    <div className="cw-stack">
      <Section title="People found">
        <div className="cw-big">
          <b>{n0(p.found)}</b>
          <span>people match this campaign</span>
        </div>
        <div className="cw-split" role="img" aria-label={`${n0(p.canEmail)} can be emailed, ${n0(p.noAddress)} have no usable address, ${n0(p.checking)} still being checked`}>
          <i className="ok" style={{ width: pc(p.canEmail) }} />
          <i className="check" style={{ width: pc(p.checking) }} />
          <i className="bad" style={{ width: pc(p.noAddress) }} />
        </div>
        <ul className="cw-legend">
          <li>
            <i className="ok" />
            Can be emailed <b>{n0(p.canEmail)}</b>
          </li>
          <li>
            <i className="check" />
            Still being checked <b>{n0(p.checking)}</b>
          </li>
          <li>
            <i className="bad" />
            No usable address <b>{n0(p.noAddress)}</b>
          </li>
        </ul>
        <p className="cw-note">Every address is checked before anyone is emailed. People without a usable one are never emailed, so they never cost you anything.</p>
      </Section>
      <Section title="From found to hot lead">
        <ol className="cw-funnel">
          {funnel.map((f, i) => (
            <li key={f.label}>
              <span className="l">{f.label}</span>
              <span className="t">
                <i style={{ width: p.found ? `${Math.max(f.n ? 1.5 : 0, (f.n / p.found) * 100)}%` : "0%", animationDelay: `${i * 80}ms` }} className={i === funnel.length - 1 ? "hot" : ""} />
              </span>
              <b>{n0(f.n)}</b>
              <small>{i && funnel[i - 1].n ? `${Math.round((f.n / funnel[i - 1].n) * 100)}% of ${funnel[i - 1].label.toLowerCase()}` : ""}</small>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Email sequence">
        <div className="cw-steps">
          {p.steps.map((s, i) => (
            <div key={s.step} className={`cw-step${i === 0 ? " first" : ""}`}>
              <span>{STEP_NAME[i]}</span>
              <b>{n0(s.sent)}</b>
              <span className="t">
                <i style={{ width: `${(s.sent / stepTop) * 100}%` }} />
              </span>
              <small>sent, all time</small>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Story({ w }: { w: CampaignWorkspace }) {
  const days = useMemo(() => {
    const out: { day: string; items: CampaignWorkspace["timeline"] }[] = [];
    for (const e of w.timeline) {
      const day = dayHeading(e.at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [w.timeline]);
  return (
    <aside className="cw-story" aria-label="What happened">
      <div className="cw-rail">
        <h2>What happened</h2>
        <span className="meta">Last 30 days</span>
      </div>
      <div className="ap-card cw-story-card">
      {days.length ? (
        <div className="cw-story-b">
          {days.map((d) => (
            <div key={d.day} className="cw-day">
              <h5>{d.day}</h5>
              <ol>
                {d.items.map((e, i) => {
                  const ev = EVENT[e.kind];
                  return (
                    <li key={`${e.at}-${i}`} className={`is-${ev.tone}`}>
                      <span className="ic">
                        <Icon id={ev.icon} />
                      </span>
                      <span className="t">{e.text}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      ) : (
        <p className="cw-muted cw-pad">Nothing yet. Finding people, emails and replies show up here as they happen.</p>
      )}
      </div>
    </aside>
  );
}

export default function CampaignWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const cid = decodeURIComponent(id);
  const { data: w, isError, error, refetch } = useCampaignWorkspaceQuery(cid, { pollingInterval: 120_000, skipPollingIfUnfocused: true });
  const { data: targeting } = useTargetingQuery(undefined, { skip: cid === "own" });
  const [save, saving] = useSaveTargetingMutation();
  const { canManage } = useRole();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("brief");

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (!w)
    return (
      <div className="cw" aria-busy="true">
        <Skeleton h={120} r={16} />
        <div className="cw-body">
          <Skeleton h={420} r={16} />
          <Skeleton h={420} r={16} />
        </div>
      </div>
    );

  const st = CAMPAIGN_STATE[w.state];
  const group = targeting?.groups.find((g) => g.id === w.id);
  // Pausing one campaign switches its audience off in Targeting; nothing already queued is dropped.
  const toggle = () => {
    if (!group) return;
    save({ groups: [{ id: group.id, on: !group.on, titles: group.titles, keywords: group.keywords, sizes: group.sizes, regions: group.regions }], dropQueued: false })
      .unwrap()
      .then(() => toast(group.on ? `${w.name} is paused. People already emailed still get their follow-ups.` : `${w.name} is on again.`, "good"))
      .catch((e) => toast(errorMessage(e), "bad"));
  };
  const p = w.progress;

  return (
    <div className="cw">
      <header className="ap-card cw-head">
        <div className="cw-head-top">
          <div className="cw-title">
            <nav className="cw-crumb" aria-label="Breadcrumb">
              <Link href="/app/campaigns">Campaigns</Link>
              <Icon id="chev" />
              <span>{w.name}</span>
            </nav>
            <div className="cw-name">
              <h1>{w.name}</h1>
              <span title={st.text}>
                <Chip tone={st.tone}>{st.label}</Chip>
              </span>
            </div>
            {w.description ? <p>{w.description}</p> : null}
          </div>
          {canManage && group ? (
            <Button variant={group.on ? "ghost" : "primary"} size="sm" icon={group.on ? "power" : "rotate"} loading={saving.isLoading} onClick={toggle}>
              {group.on ? "Pause campaign" : "Resume campaign"}
            </Button>
          ) : null}
        </div>
        <dl className="cw-kpis">
          <div>
            <dt>Found</dt>
            <dd>{n0(p.found)}</dd>
          </div>
          <div>
            <dt>Can be emailed</dt>
            <dd>{n0(p.canEmail)}</dd>
          </div>
          <div>
            <dt>Emailed</dt>
            <dd>{n0(p.emailed)}</dd>
          </div>
          <div>
            <dt>Replied</dt>
            <dd>{n0(p.replied)}</dd>
          </div>
          <div className="hot">
            <dt>Hot leads</dt>
            <dd>{n0(p.hot)}</dd>
          </div>
        </dl>
      </header>

      <div className="cw-body">
        <Story w={w} />
        <div className="cw-main">
          <div className="cw-tabs cw-rail" role="tablist" aria-label="Campaign">
            {(
              [
                ["brief", "Brief", "page"],
                ["leads", "Leads", "users"],
                ["results", "Results", "pulse"],
              ] as const
            ).map(([k, label, icon]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                <Icon id={icon} />
                {label}
                {k === "leads" ? <span>{n0(p.found)}</span> : null}
              </button>
            ))}
          </div>
          {tab === "brief" ? <Brief w={w} /> : tab === "leads" ? <Leads w={w} /> : <Results w={w} />}
        </div>
      </div>
    </div>
  );
}
