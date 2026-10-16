"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { dirFor } from "@/lib/rtl";
import { compact, n0 } from "@/lib/format";
import { AUDIENCE_ICON } from "./Rail";
import { Counter, Typewriter, arrive, trail, useDock, useReducedMotion, useReveal } from "./motion";
import type { RunState } from "./run";

export const PHASES = ["reading", "business", "audiences", "market", "companies", "people", "emails"] as const;
export type PhaseKey = (typeof PHASES)[number];

/** Where each finished phase lands in the rail. Companies and people fold into the market card. */
const DOCK_KEY: Record<PhaseKey, string | null> = {
  reading: null,
  business: "business",
  audiences: "buyers",
  market: "market",
  companies: "market",
  people: "market",
  emails: "sequence",
};

export const DWELL_MS = 1200;
/** The business panel carries the most text, so it stays a little longer once it has filled in. */
export const BUSINESS_DWELL_MS = 2000;
/** Time to read the finished email before it joins the rail and the overview opens. */
export const EMAIL_DWELL_MS = 2500;
/** How far into a dock flight the next panel starts to come in. */
const HANDOFF_MS = 140;
const LANG: Record<string, string> = { en: "English", de: "German", fr: "French", es: "Spanish", nl: "Dutch", it: "Italian", pt: "Portuguese", ur: "Urdu", ar: "Arabic" };

type AnalyseSummary = {
  company?: string;
  oneLiner?: string;
  language?: string;
  country?: string | null;
  geographies?: string[];
  offerings?: string[];
  proof?: { text: string; source: string }[];
};
type SizeSummary = {
  available?: boolean;
  reason?: string | null;
  people?: number | null;
  reachable?: number | null;
  sampleSize?: number;
  breakdowns?: { byCountry: [string, number][]; bySize: [string, number][]; bySeniority: [string, number][] };
};

export interface Lead {
  key: string;
  audienceId?: string;
  firstName: string;
  lastMasked: string;
  title: string | null;
  company: string | null;
  hasEmail: boolean;
}

export interface Draft {
  subject: string;
  body: string;
  tab?: string;
  day?: string;
  /** First name of the mailbox persona that signs the email. */
  sender?: string;
}

const sizeBand = (n: number | null) => (n == null ? "" : n <= 10 ? "1 to 10 staff" : n <= 50 ? "11 to 50 staff" : n <= 200 ? "51 to 200 staff" : n <= 1000 ? "201 to 1,000 staff" : "1,000+ staff");

function Sk({ w = "100%", h = 12, r = 6 }: { w?: number | string; h?: number; r?: number }) {
  return <i className="sk" style={{ width: w, height: h, borderRadius: r }} aria-hidden="true" />;
}

function SourceChip({ src }: { src: string }) {
  if (!src) return null;
  return (
    <span className="lv-src">
      <Icon id="link" />
      {src.startsWith("/") ? `found on ${src}` : src}
    </span>
  );
}

function PhaseHead({ title, sub, live }: { title: string; sub: string; live: boolean }) {
  return (
    <header className="ph-head">
      <h1 className="ph-h">
        {title}
        {live ? <span className="lv-live" aria-hidden="true" /> : null}
      </h1>
      <p className="ph-sub">{sub}</p>
    </header>
  );
}

// ─── Phase panels ──────────────────────────────────────────────────────────

function Reading({ domain, run }: { domain: string; run: RunState }) {
  const rows = Math.max(6, run.pages.length);
  return (
    <>
      <div className="ph-chip-row">
        <span className="lv-dchip">
          <Icon id="globe" />
          {domain}
        </span>
      </div>
      <PhaseHead title="Reading your site" sub="Opening the pages that say what you sell, who it's for and where." live />
      <div className="ph-card">
        <ul className="ph-pages" aria-label="Pages read">
          {Array.from({ length: rows }, (_, i) => {
            const p = run.pages[i];
            return p ? (
              <li key={p.url} {...arrive(0)}>
                <span className="lv-mono">{p.url}</span>
                <Icon id="check" className="lv-ok" />
              </li>
            ) : (
              <li key={`sk${i}`} className="is-sk">
                <Sk w={`${40 + ((i * 17) % 35)}%`} />
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

function Business({ run }: { run: RunState }) {
  const s = run.summaries.analyse as AnalyseSummary | undefined;
  const lang = s?.language ? LANG[s.language] ?? s.language.toUpperCase() : null;
  const chips = [s?.country ?? null, lang].filter((x): x is string => !!x);
  const domain = (run.summaries.fetch as { domain?: string } | undefined)?.domain;
  void domain;
  return (
    <>
      <PhaseHead title="Understanding your business" sub="What you sell and who it's for, from your own pages." live={!s} />
      <article className="ph-card ph-biz" aria-busy={!s || undefined}>
        {s ? (
          <>
            <div className="biz-top lv-arrive">
              <div>
                <h2 className="biz-name" dir="auto">{s.company}</h2>
                <p className="biz-line" dir="auto">{s.oneLiner}</p>
              </div>
              {chips.length ? (
                <div className="biz-chips">
                  {chips.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
              ) : null}
            </div>
            {s.offerings?.length ? (
              <div className="biz-sec">
                <h3>What you offer</h3>
                <div className="biz-tags">
                  {s.offerings.map((o, i) => (
                    <span key={o} dir="auto" {...arrive(i, s.offerings!.length)}>
                      {o}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {s.proof?.length ? (
              <div className="biz-sec">
                <h3>Proof on your site</h3>
                <ul className="biz-proof">
                  {s.proof.map((p, i) => (
                    <li key={p.text} {...arrive(i, s.proof!.length)}>
                      <span dir="auto">{p.text}</span>
                      <SourceChip src={p.source} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="biz-top">
              <div style={{ flex: 1 }}>
                <Sk w="38%" h={26} />
                <div style={{ height: 12 }} />
                <Sk w="82%" h={14} />
              </div>
              <div className="biz-chips">
                <Sk w={70} h={24} r={999} />
                <Sk w={60} h={24} r={999} />
              </div>
            </div>
            <div className="biz-sec">
              <Sk w={110} />
              <div className="biz-tags">
                <Sk w={120} h={28} r={8} />
                <Sk w={150} h={28} r={8} />
                <Sk w={100} h={28} r={8} />
              </div>
            </div>
            <div className="biz-sec">
              <Sk w={130} />
              <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
                <Sk w="74%" h={14} />
                <Sk w="61%" h={14} />
              </div>
            </div>
          </>
        )}
      </article>
    </>
  );
}

/** The next two slots shimmer; any slot further down is reserved but blank, so nothing reflows. */
function AudienceSkeleton({ hidden = false }: { hidden?: boolean }) {
  return (
    <article className={`aud-card is-sk${hidden ? " is-blank" : ""}`} aria-hidden="true">
      <Sk w={36} h={36} r={10} />
      <div className="aud-body">
        <Sk w="55%" h={16} />
        <div style={{ height: 10 }} />
        <Sk w="92%" />
        <div style={{ height: 8 }} />
        <Sk w="70%" />
        <div style={{ height: 14 }} />
        <Sk w="60%" />
        <div style={{ height: 8 }} />
        <Sk w="52%" />
        <div className="aud-kws">
          <Sk w={70} h={22} r={6} />
          <Sk w={90} h={22} r={6} />
        </div>
      </div>
    </article>
  );
}

function Audiences({ run, onSettled }: { run: RunState; onSettled: () => void }) {
  const final = run.stepState.validate === "done";
  const shown = useReveal(run.audiences.length, 450, run.audiences.length > 0);
  useEffect(() => {
    if (final && shown >= run.audiences.length && run.audiences.length) onSettled();
  }, [final, shown, run.audiences.length, onSettled]);
  const slots = Math.max(3, run.audiences.length);
  return (
    <>
      <PhaseHead title="Who buys from you" sub="Each audience needs its own email. They are ranked by where we'd start." live={!final || shown < run.audiences.length} />
      <div className="aud-list">
        {run.audiences.slice(0, shown).map((a) => (
          <article key={a.id} className="aud-card lv-arrive">
            <span className="aud-ic">
              <Icon id={AUDIENCE_ICON[a.icon] ?? "users"} />
            </span>
            <div className="aud-body">
              <h3 dir="auto">{a.name}</h3>
              {a.why || a.description ? (
                <p className="aud-why" dir="auto">
                  {a.why || a.description}
                </p>
              ) : null}
              {a.pains.length ? (
                <ul className="aud-pains">
                  {a.pains.slice(0, 4).map((p) => (
                    <li key={p} dir="auto">
                      {p}
                    </li>
                  ))}
                </ul>
              ) : null}
              {a.keywords.length ? (
                <div className="aud-kws">
                  {a.keywords.map((k) => (
                    <span key={k}>{k}</span>
                  ))}
                </div>
              ) : null}
            </div>
          </article>
        ))}
        {Array.from({ length: slots - shown }, (_, i) => (
          <AudienceSkeleton key={`sk${i}`} hidden={run.audiences.length > 0 && i >= 2} />
        ))}
      </div>
    </>
  );
}

function Bars({ title, data }: { title: string; data: [string, number][] }) {
  const tot = data.reduce((a, d) => a + d[1], 0) || 1;
  const mx = Math.max(1, ...data.map((d) => d[1]));
  return (
    <figure className="mb">
      <figcaption>{title}</figcaption>
      {data.map(([k, v]) => (
        <div className="mb-row" key={k}>
          <span className="mb-k">{k}</span>
          <span className="mb-t">
            <i style={{ width: `${(v / mx) * 100}%` }} />
          </span>
          <b>{Math.round((v / tot) * 100)}%</b>
        </div>
      ))}
    </figure>
  );
}

function Market({ run, onSettled }: { run: RunState; onSettled: () => void }) {
  const s = run.summaries.size as SizeSummary | undefined;
  useEffect(() => {
    if (!s) return;
    const t = setTimeout(onSettled, 700);
    return () => clearTimeout(t);
  }, [s, onSettled]);
  const charts = s?.breakdowns
    ? ([
        ["By country", s.breakdowns.byCountry],
        ["By company size", s.breakdowns.bySize],
        ["By seniority", s.breakdowns.bySeniority],
      ] as [string, [string, number][]][]).filter(([, d]) => d.length)
    : [];
  return (
    <>
      <PhaseHead title="Your market" sub="People who match your audiences in the lead database." live={!s} />
      <div className="ph-card">
        <div className="mk-big">
          <div>
            <span>People who match</span>
            <b>{s ? <Counter value={s.people ?? null} /> : <Sk w={160} h={40} r={8} />}</b>
          </div>
          <div>
            <span>With a verified work email</span>
            <b>{s ? <Counter value={s.reachable ?? null} /> : <Sk w={140} h={40} r={8} />}</b>
          </div>
        </div>
        <ul className="mk-rows">
          {run.audiences.map((a) => {
            const c = a.count;
            const share = c?.total && c.reachable != null ? Math.min(1, c.reachable / c.total) : 0;
            return (
              <li key={a.id}>
                <span className="mk-name">{a.name}</span>
                <span className="mk-v">{c ? <Counter value={c.total} /> : <Sk w={60} h={16} />}</span>
                <span className="mk-v muted">{c ? <Counter value={c.reachable} /> : <Sk w={50} h={16} />}</span>
                <span className="mk-bar" aria-hidden="true">
                  {c ? <i style={{ width: `${share * 100}%` }} /> : null}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mk-legend" aria-hidden="true">
          <span>match</span>
          <span>reachable</span>
        </div>
        {s ? (
          charts.length ? (
            <div className="mb-grid">
              {charts.map(([t, d]) => (
                <Bars key={t} title={t} data={d} />
              ))}
            </div>
          ) : null
        ) : (
          <div className="mb-grid">
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ display: "grid", gap: 10 }}>
                <Sk w="50%" />
                <Sk h={8} />
                <Sk w="70%" h={8} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function RowsTable<T>({
  title,
  sub,
  rows,
  ready,
  head,
  render,
  onSettled,
}: {
  title: string;
  sub: string;
  rows: T[];
  ready: boolean;
  head: string[];
  render: (r: T) => React.ReactNode[];
  onSettled: () => void;
}) {
  const reserve = 8;
  const visibleRows = rows.slice(0, reserve);
  const step = Math.min(150, 1200 / Math.max(1, visibleRows.length));
  const shown = useReveal(visibleRows.length, step, ready);
  const filling = shown < visibleRows.length;
  useEffect(() => {
    if (ready && !filling && visibleRows.length) onSettled();
  }, [ready, filling, visibleRows.length, onSettled]);
  return (
    <>
      <PhaseHead title={title} sub={sub} live={!ready || filling} />
      <div className="ph-card ph-table" role="table" aria-label={title}>
        <div className="pt-row pt-h" role="row">
          {head.map((h) => (
            <span key={h} role="columnheader">
              {h}
            </span>
          ))}
        </div>
        {Array.from({ length: reserve }, (_, i) => {
          const r = visibleRows[i];
          if (r && i < shown)
            return (
              <div key={i} className={`pt-row lv-arrive${trail(i, shown, filling)}`} role="row">
                {render(r).map((c, j) => (
                  <span key={j} role="cell">
                    {c}
                  </span>
                ))}
              </div>
            );
          if (!ready || (r && i >= shown))
            return (
              <div key={i} className="pt-row is-sk" aria-hidden="true">
                {head.map((h, j) => (
                  <span key={h}>
                    <Sk w={j === 0 ? "70%" : "55%"} />
                  </span>
                ))}
              </div>
            );
          return <div key={i} className="pt-row is-empty" aria-hidden="true" />;
        })}
      </div>
    </>
  );
}

// ─── Emails ────────────────────────────────────────────────────────────────

const fill = (text: string, lead: Lead | null) =>
  lead ? text.replace(/\{\{\s*first_name\s*\}\}/g, lead.firstName || "{{first_name}}").replace(/\{\{\s*company\s*\}\}/g, lead.company || "{{company}}") : text;

const CHECKS = ["Person", "Company", "Email"] as const;

function LeadCard({ lead, active, animate, onSelect, onReject, onFound }: { lead: Lead; active: boolean; animate: boolean; onSelect: () => void; onReject: () => void; onFound: () => void }) {
  const reduced = useReducedMotion();
  const quick = !animate || reduced;
  const [done, setDone] = useState(quick ? CHECKS.length : 0);
  const [kept, setKept] = useState(false);
  const found = useRef(onFound);
  found.current = onFound;
  useEffect(() => {
    if (quick) {
      setDone(CHECKS.length);
      found.current();
      return;
    }
    if (done >= CHECKS.length) {
      found.current();
      return;
    }
    const t = setTimeout(() => setDone((d) => d + 1), 320);
    return () => clearTimeout(t);
  }, [done, quick]);
  const result = (c: (typeof CHECKS)[number]) => (c === "Person" ? true : c === "Company" ? !!lead.company : lead.hasEmail);
  return (
    <article className={`lead${active ? " on" : ""}${kept ? " kept" : ""}`}>
      <button type="button" className="lead-main" onClick={onSelect} aria-pressed={active} aria-label={`Preview the email to ${lead.firstName} ${lead.lastMasked}`}>
        <span className="lead-av" aria-hidden="true">
          {lead.firstName.charAt(0)}
        </span>
        <span className="lead-txt">
          <b>
            {lead.firstName} {lead.lastMasked}
          </b>
          <small dir="auto">{[lead.title, lead.company].filter(Boolean).join(" · ")}</small>
        </span>
      </button>
      <div className="lead-checks" aria-label="Finding the address">
        {CHECKS.map((c, i) => {
          const st = i >= done ? "pend" : result(c) ? "ok" : "miss";
          return (
            <span key={c} className={`lc ${st}`}>
              {st === "ok" ? <Icon id="check" /> : st === "miss" ? <span aria-hidden="true">–</span> : null}
              {c}
            </span>
          );
        })}
      </div>
      <p className={`lead-res${done >= CHECKS.length && !lead.hasEmail ? " miss" : ""}`}>
        {done < CHECKS.length ? "checking…" : lead.hasEmail ? "••••••@•••••••• · on file, unlocks at launch" : "no email found"}
      </p>
      <div className="lead-act">
        <button type="button" className={`la ok${kept ? " on" : ""}`} aria-pressed={kept} aria-label={`Keep ${lead.firstName}`} onClick={() => setKept(!kept)}>
          <Icon id="check" />
        </button>
        <button type="button" className="la no" aria-label={`Remove ${lead.firstName} from the preview`} onClick={onReject}>
          <Icon id="x" />
        </button>
      </div>
    </article>
  );
}

/**
 * The sample email phase: leads on the left, the email on the right. Live, it finds the address,
 * shows the frame, then types To, subject and body. On review everything is already written.
 */
export function EmailsPanel({
  leads,
  drafts,
  animate,
  writing,
  brand,
  onSettled,
  dockRef,
  language,
}: {
  leads: Lead[];
  drafts: Draft[];
  animate: boolean;
  writing: boolean;
  brand: string;
  onSettled?: () => void;
  dockRef?: (el: HTMLElement | null) => void;
  /** The language the emails are written in. Right-to-left languages are shown right to left. */
  language?: string | null;
}) {
  const [rejected, setRejected] = useState<string[]>([]);
  const [undo, setUndo] = useState<Lead | null>(null);
  const list = leads.filter((l) => !rejected.includes(l.key)).slice(0, 4);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active = list.find((l) => l.key === activeKey) ?? list.find((l) => l.hasEmail) ?? list[0] ?? null;
  const [found, setFound] = useState(!animate || !leads.length);
  const [stage, setStage] = useState<"frame" | "to" | "subject" | "body" | "done">(animate ? "frame" : "done");
  const [tab, setTab] = useState(0);
  const draft = drafts[tab] ?? drafts[0];
  const settled = useRef(false);

  useEffect(() => {
    if (!animate || !found || !drafts.length || stage !== "frame") return;
    const t = setTimeout(() => setStage("to"), 400);
    return () => clearTimeout(t);
  }, [animate, found, drafts.length, stage]);
  useEffect(() => {
    if (stage !== "to") return;
    const t = setTimeout(() => setStage("subject"), 350);
    return () => clearTimeout(t);
  }, [stage]);
  useEffect(() => {
    if (stage === "done" && !settled.current && drafts.length) {
      settled.current = true;
      onSettled?.();
    }
  }, [stage, drafts.length, onSettled]);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(t);
  }, [undo]);

  const onFound = useCallback(() => setFound(true), []);
  const reject = (l: Lead) => {
    setRejected((r) => [...r, l.key]);
    setUndo(l);
  };
  const typing = animate && stage !== "done";
  const toLine = active ? `${active.firstName} at ${active.company ?? "their company"}` : "{{first_name}} at {{company}}";

  return (
    <div className={`em${list.length ? "" : " no-leads"}`} ref={dockRef}>
      {list.length ? (
        <div className="em-leads" aria-label="Sample leads">
          {list.map((l, i) => (
            <LeadCard key={l.key} lead={l} active={l.key === active?.key} animate={animate && l.key === active?.key} onSelect={() => (setActiveKey(l.key), setStage("done"))} onReject={() => reject(l)} onFound={l.key === active?.key ? onFound : () => undefined} />
          ))}
          <p className="em-note">Last names and addresses stay hidden until your campaign starts.</p>
        </div>
      ) : null}
      <section className="em-pane ph-card" aria-busy={typing || writing || undefined}>
        {!typing && drafts.length > 1 ? (
          <div className="em-tabs" role="tablist" aria-label="Emails in the sequence">
            {drafts.map((d, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === tab} onClick={() => setTab(i)}>
                {d.tab ?? `Email ${i + 1}`}
                {d.day ? <span>{d.day}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        <div className="em-row">
          <span>From</span>
          <span className="em-later">
            <span className="em-from">{draft?.sender ?? "A warmed mailbox"}</span>
            <em>A warmed mailbox named for your market. The name always matches the address.</em>
          </span>
        </div>
        <div className="em-row">
          <span>To</span>
          <span>{stage === "frame" || !draft ? <Sk w={160} /> : <span className="lv-arrive">{toLine}</span>}</span>
        </div>
        <div className="em-row em-subj">
          <span>Subject</span>
          <span dir={dirFor(language)} lang={language ?? undefined}>
            {!draft || stage === "frame" || stage === "to" ? (
              <Sk w="60%" h={14} />
            ) : stage === "subject" ? (
              <Typewriter text={fill(tab ? `Re: ${drafts[0].subject}` : draft.subject, active)} onDone={() => setStage("body")} />
            ) : (
              fill(draft.subject, active)
            )}
          </span>
        </div>
        <div className="em-body" dir={dirFor(language)} lang={language ?? undefined}>
          {!draft || stage === "frame" || stage === "to" || stage === "subject" ? (
            <div className="em-sk" aria-hidden="true">
              <Sk w="92%" />
              <Sk w="96%" />
              <Sk w="88%" />
              <Sk w="64%" />
              <Sk w="40%" />
            </div>
          ) : stage === "body" ? (
            <Typewriter text={fill(draft.body, active)} onDone={() => setStage("done")} className="em-text" />
          ) : (
            <span className="em-text">{fill(draft.body, active)}</span>
          )}
          {stage === "done" && draft ? (
            <p className="em-sig">
              Best,
              <br />
              {draft.sender ?? brand}
            </p>
          ) : null}
        </div>
        {writing && !drafts.length ? <p className="em-wait">Writing your 4 email sequence from your analysis</p> : null}
      </section>
      {undo ? (
        <div className="lv-toast" role="status">
          <span>
            Removed {undo.firstName} {undo.lastMasked} from the preview.
          </span>
          <button
            type="button"
            onClick={() => {
              setRejected((r) => r.filter((k) => k !== undo.key));
              setUndo(null);
            }}
          >
            Undo
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ─── The phase machine ─────────────────────────────────────────────────────

export function leadsFromRun(run: RunState, audienceId: string | null): Lead[] {
  return run.people
    .filter((p) => !audienceId || p.audienceId === audienceId)
    .map((p, i) => ({ key: `${p.audienceId}-${i}-${p.firstName}`, audienceId: p.audienceId, firstName: p.firstName, lastMasked: p.lastNameMasked, title: p.title, company: p.company, hasEmail: p.hasEmail }));
}

/**
 * The centre during a run. It holds exactly one phase. A phase stays at least 1.2 seconds, docks
 * into the rail when it is done, and a phase with no data is skipped. The phase is kept in the URL
 * so a reload resumes where it was.
 */
export function LiveAnalysis({
  domain,
  run,
  onFinished,
  initialPhase,
  onPhase,
  audience,
  brand,
}: {
  domain: string;
  run: RunState;
  onFinished: () => void;
  initialPhase?: PhaseKey | null;
  onPhase?: (p: PhaseKey) => void;
  audience: string | null;
  brand: string;
}) {
  const dock = useDock();
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(() => Math.max(0, initialPhase ? PHASES.indexOf(initialPhase) : 0));
  const [leaving, setLeaving] = useState(false);
  const [settled, setSettled] = useState<{ phase: PhaseKey; at: number } | null>(null);
  const shownAt = useRef(Date.now());
  const completeAt = useRef<number | null>(null);
  const finished = useRef(false);
  const phase = PHASES[index];
  // Only the running phase's own settle counts; a previous phase's never carries over.
  const settledAt = settled?.phase === phase ? settled.at : null;
  const st = run.stepState;
  const size = run.summaries.size as SizeSummary | undefined;
  const writeDone = st.write === "done";

  useEffect(() => {
    if (!initialPhase) return;
    const earlier = PHASES.slice(0, PHASES.indexOf(initialPhase))
      .map((p) => DOCK_KEY[p])
      .filter((k): k is string => !!k);
    if (earlier.length) dock.settle([...new Set(earlier)]);
    // Only on mount: resume where the URL says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onPhase?.(phase);
    shownAt.current = Date.now();
    completeAt.current = null;
  }, [phase, onPhase]);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    onFinished();
  }, [onFinished]);

  /** Data known to be empty: the phase is skipped rather than shown empty. */
  const empty = useCallback(
    (p: PhaseKey): boolean => {
      if (p === "audiences") return st.validate === "done" && !run.audiences.length;
      if (p === "market") return st.size === "done" && !size?.available;
      if (p === "companies") return st.size === "done" && !run.companies.length;
      if (p === "people") return st.size === "done" && !run.people.length;
      if (p === "emails") return writeDone && !run.drafts.length;
      return false;
    },
    [st, run.audiences.length, run.companies.length, run.people.length, run.drafts.length, size?.available, writeDone],
  );

  /** Ready to leave: its data is complete and its own animation has settled. */
  const complete = useMemo(() => {
    if (phase === "reading") return st.extract === "done" || st.analyse === "running" || st.analyse === "done";
    if (phase === "business") return st.analyse === "done";
    if (phase === "market") return st.size === "done" && settledAt != null;
    return settledAt != null;
  }, [phase, st, settledAt]);

  const onSettled = useCallback(() => setSettled((x) => (x?.phase === phase ? x : { phase, at: Date.now() })), [phase]);

  // Errors and a thin site end the show straight away; the step then offers the three questions.
  useEffect(() => {
    if (run.error || (run.done && run.outcome === "low-confidence")) {
      const t = setTimeout(finish, 900);
      return () => clearTimeout(t);
    }
  }, [run.error, run.done, run.outcome, finish]);

  useEffect(() => {
    if (leaving || finished.current || run.error) return;
    const next = () => {
      let j = index + 1;
      while (j < PHASES.length && empty(PHASES[j])) j++;
      return j;
    };
    if (empty(phase)) {
      setLeaving(true);
      const t = setTimeout(() => {
        const j = next();
        setLeaving(false);
        if (j >= PHASES.length) finish();
        else setIndex(j);
      }, reduced ? 0 : 140);
      return () => clearTimeout(t);
    }
    if (!complete) {
      completeAt.current = null;
      return;
    }
    // The dwell counts from the moment the content is complete, so a panel that filled late is still read before it leaves.
    completeAt.current ??= Date.now();
    const hold = (phase === "business" ? BUSINESS_DWELL_MS : phase === "emails" ? EMAIL_DWELL_MS : DWELL_MS) - (Date.now() - completeAt.current);
    const wait = Math.max(0, hold, DWELL_MS - (Date.now() - shownAt.current));
    const t = setTimeout(async () => {
      setLeaving(true);
      const go = () => {
        const j = next();
        setLeaving(false);
        if (j >= PHASES.length) finish();
        else setIndex(j);
      };
      const key = DOCK_KEY[phase];
      if (key) {
        // The next panel comes in while this one is still flying to the rail, so the centre is never empty.
        let went = false;
        const handOff = () => {
          if (went) return;
          went = true;
          if (reduced) go();
          else setTimeout(go, HANDOFF_MS);
        };
        await dock.dock(key, handOff);
        handOff();
      } else {
        if (!reduced) await new Promise((r) => setTimeout(r, 180));
        go();
      }
    }, wait);
    return () => clearTimeout(t);
  }, [phase, index, complete, leaving, empty, dock, reduced, finish, run.error, settledAt]);

  const key = DOCK_KEY[phase];
  const companies = run.companies.filter((c) => !audience || c.audienceId === audience);
  // The free people search often returns only company names; then show who matches there instead of empty columns.
  const richCompanies = companies.some((c) => c.domain || c.country || c.employees);
  const people = run.people.filter((p) => !audience || p.audienceId === audience);

  let body: React.ReactNode;
  if (phase === "reading") body = <Reading domain={domain} run={run} />;
  else if (phase === "business") body = <Business run={run} />;
  else if (phase === "audiences") body = <Audiences run={run} onSettled={onSettled} />;
  else if (phase === "market") body = <Market run={run} onSettled={onSettled} />;
  else if (phase === "companies")
    body = (
      <RowsTable
        title="Matching companies"
        sub={`Examples from a sample of ${size?.sampleSize ?? run.people.length} matching people, not a count of every company.`}
        rows={companies}
        ready={st.size === "done"}
        head={richCompanies ? ["Company", "Domain", "Country", "Size"] : ["Company", "Who matches there", "People", ""]}
        render={(c) =>
          richCompanies
            ? [<b key="n">{c.name}</b>, <span key="d" className="lv-mono">{c.domain ?? ""}</span>, c.country ?? "", c.employees ? `${compact(c.employees)} staff` : sizeBand(null)]
            : [<b key="n">{c.name}</b>, (c.titles ?? []).join(", "), String(c.people ?? 1), ""]
        }
        onSettled={onSettled}
      />
    );
  else if (phase === "people")
    body = (
      <RowsTable
        title="People you'd reach"
        sub="Last names and email addresses stay hidden until your campaign starts."
        rows={people}
        ready={st.size === "done"}
        head={["Name", "Job title", "Company", "Email"]}
        render={(p) => [
          <b key="n">
            {p.firstName} {p.lastNameMasked}
          </b>,
          p.title ?? "",
          p.company ?? "",
          p.hasEmail ? (
            <span key="e" className="pt-on">
              <Icon id="lock" />
              on file
            </span>
          ) : (
            <span key="e" className="muted">
              not found
            </span>
          ),
        ]}
        onSettled={onSettled}
      />
    );
  else
    body = (
      <>
        <PhaseHead title="Your first email" sub="Written from your analysis for a real lead in your market. You can edit every word before launch." live={!writeDone} />
        <EmailsPanel
          leads={leadsFromRun(run, audience)}
          drafts={run.drafts.map((d) => ({ subject: d.subject, body: d.body, tab: d.tab, day: d.day, sender: d.sender }))}
          animate
          writing={!writeDone}
          brand={brand}
          onSettled={onSettled}
          language={(run.summaries.analyse as AnalyseSummary | undefined)?.language ?? null}
        />
      </>
    );

  return (
    <div className="ph-stage" data-phase={phase} aria-live="polite">
      <div key={phase} className={`ph-panel${leaving && !key ? " out" : ""}`} ref={key ? dock.source(key) : undefined}>
        {body}
      </div>
      {run.error ? (
        <div className="banner bad" role="alert">
          {run.error.message}
        </div>
      ) : null}
      {size?.available && size.people != null && size.people < 1000 && phase === "market" ? <p className="lv-warn">This is a niche market: about {n0(size.people)} people match.</p> : null}
    </div>
  );
}
