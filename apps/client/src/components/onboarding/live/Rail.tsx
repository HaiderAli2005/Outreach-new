"use client";

import { useState } from "react";
import { Icon, type IconId } from "@/components/ui/Icon";
import { compact } from "@/lib/format";
import { useDock } from "./motion";
import type { Connection, LogLine } from "./run";
import { SETUP_STEPS } from "./steps";

export interface RailCardData {
  key: string;
  icon: IconId;
  title: string;
  detail: string;
  chips?: string[];
  list?: { icon: IconId; text: string }[];
  /** Step the card reopens in the centre. Cards without one (domain, account, payment) are a record only. */
  step?: number;
  /** Amber note, for example a small market. */
  warn?: string;
  /** Expanded detail: facts with the page they came from. */
  facts?: { text: string; source: string }[];
  /** Expanded detail: competitor domains, shown with their favicons. */
  competitors?: string[];
  /** Expanded detail: audiences with their counts. Selecting one filters the centre. */
  audiences?: { id: string; name: string; icon: IconId; count: number | null }[];
}

export interface RailLog {
  lines: LogLine[];
  stepIndex: number;
  stepCount: number;
  connection: Connection;
  label?: string;
}

/** The money line under the rail: the daily budget, or the balance once credits are in. */
export interface RailTotal {
  label: string;
  value: string;
  note: string;
}

export const AUDIENCE_ICON: Record<string, IconId> = {
  store: "store",
  factory: "factory",
  finance: "coins",
  logistics: "truck",
  agency: "megaphone",
  health: "heart",
  tech: "cpu",
  founder: "briefcase",
  people: "users",
};

function Favicon({ domain }: { domain: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className="fav-l">{domain.charAt(0).toUpperCase()}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`} alt="" width={14} height={14} referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />;
}

/** The rail files every decision under the same numbered steps as the top bar. */
export const RAIL_STEPS = SETUP_STEPS.map((x) => ({ title: x.label, keys: x.keys, closes: x.closes }));

function Tick({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function Row({
  c,
  state,
  current,
  onOpen,
  selected,
  onSelect,
}: {
  c: RailCardData;
  state: "landing" | "shown";
  current: boolean;
  onOpen: (step: number, key: string) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const dock = useDock();
  const body = (
    <>
      <span className="rc-ic">
        <Icon id={c.icon} />
      </span>
      <span className="rc-txt">
        <span className="rc-t">{c.title}</span>
        <span className="rc-d" dir="auto">
          {c.detail}
        </span>
      </span>
    </>
  );
  const [open, setOpen] = useState(false);
  const more = !!(c.chips?.length || c.list?.length || c.facts?.length || c.competitors?.length || c.audiences?.length);
  return (
    <li className={`rc${state === "landing" ? " landing" : ""}${current ? " cur" : ""}${open ? " open" : ""}`} ref={dock.target(c.key)} data-key={c.key}>
      <div className="rc-row">
        {c.step != null ? (
          <button type="button" className="rc-main" onClick={() => onOpen(c.step!, c.key)} aria-label={`${c.title}: ${c.detail}. Open this step`} title={c.detail}>
            {body}
          </button>
        ) : (
          <div className="rc-main static" title={c.detail}>
            {body}
          </div>
        )}
        {more ? (
          <button type="button" className={`rc-chev${open ? " open" : ""}`} aria-expanded={open} aria-label={open ? `Hide ${c.title} details` : `Show ${c.title} details`} onClick={() => setOpen(!open)}>
            <Icon id="chev" />
          </button>
        ) : null}
        <span className="rc-done">
          <Tick className="rc-tick" />
          <span className="sr">Done</span>
        </span>
      </div>
      {c.warn ? <p className="rc-warn">{c.warn}</p> : null}
      {open && more ? (
        <div className="rc-more">
          {c.chips?.length ? (
            <div className="rc-chips">
              {c.chips.map((x) => (
                <span key={x}>{x}</span>
              ))}
            </div>
          ) : null}
          {c.list?.length ? (
            <ul className="rc-list">
              {c.list.map((x) => (
                <li key={x.text} title={x.text}>
                  <Icon id={x.icon} />
                  <span dir="auto">{x.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {c.audiences?.length ? (
            <ul className="rc-aud" aria-label="Show one audience">
              {c.audiences.map((a) => (
                <li key={a.id}>
                  <button type="button" title={a.name} aria-pressed={selected === a.id} onClick={() => onSelect(selected === a.id ? null : a.id)}>
                    <Icon id={a.icon} />
                    <span dir="auto">{a.name}</span>
                    <b>{a.count != null ? compact(a.count) : ""}</b>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {c.facts?.length ? (
            <ul className="rc-facts">
              {c.facts.map((f) => (
                <li key={f.text}>
                  <span dir="auto">{f.text}</span>
                  {f.source ? <small>{f.source.startsWith("/") ? `found on ${f.source}` : f.source}</small> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {c.competitors?.length ? (
            <div className="rc-comp">
              <small>Competitors, never emailed</small>
              <div>
                {c.competitors.map((d) => (
                  <span key={d}>
                    <Favicon domain={d} />
                    {d}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function LiveLog({ log }: { log: RailLog }) {
  const lines = log.lines.slice(-4);
  const reconnecting = log.connection === "reconnecting";
  return (
    <div className="lv-log" aria-live="polite" aria-label="What is happening now">
      <p className={`lv-log-h${reconnecting ? " warn" : ""}`}>
        <span className="dot" aria-hidden="true" />
        {reconnecting ? "Reconnecting, nothing is lost" : log.label ?? `Analysis in progress · ${Math.max(1, log.stepIndex)} of ${log.stepCount}`}
      </p>
      <ul>
        {lines.map((l, i) => (
          <li key={`${l.step}-${l.text}-${i}`} className={l.state}>
            {l.state === "done" ? (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
            ) : (
              <span className="gt" aria-hidden="true">
                ›
              </span>
            )}
            <span className="sr">{l.state === "done" ? "Done: " : "In progress: "}</span>
            <span className="tx">{l.text}</span>
            {l.state === "running" && i === lines.length - 1 ? <span className="lv-caret" aria-hidden="true" /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RunningTotal({ total }: { total: RailTotal }) {
  return (
    <div className="rt" aria-label="Cost">
      <div className="rt-row">
        <span>{total.label}</span>
        <b>{total.value}</b>
      </div>
      <p>{total.note}</p>
    </div>
  );
}

export function Rail({
  cards,
  hidden,
  active,
  onOpen,
  log,
  total,
  domain,
  selected = null,
  onSelect = () => undefined,
}: {
  cards: RailCardData[];
  /** Cards still flying in from the centre while the analysis plays. */
  hidden: Set<string>;
  /** Cards whose section is open in the centre. They stay in the rail, marked. */
  active: Set<string>;
  onOpen: (step: number, key: string) => void;
  log: RailLog | null;
  total: RailTotal | null;
  domain: string;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
}) {
  const dock = useDock();
  const [drawer, setDrawer] = useState(false);
  const visible = cards
    .map((c) => ({ c, phase: dock.phase[c.key] }))
    .filter(({ c, phase }) => phase === "landing" || !hidden.has(c.key));
  const running = log?.lines.filter((l) => l.state === "running").at(-1);
  return (
    <aside className={`lv-rail${drawer ? " open" : ""}`} aria-label="Your setup so far">
      <button type="button" className="lv-drawer" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>
        <span className="lv-drawer-n">{visible.filter((v) => v.phase !== "landing").length} decided</span>
        <span className="lv-drawer-t">{running ? running.text : domain}</span>
        <Icon id="chev" />
      </button>
      <div className="lv-rail-in">
        {visible.length ? (
          <ol className="rc-steps">
            {RAIL_STEPS.map((g, i) => {
              const rows = g.keys.map((k) => visible.find((v) => v.c.key === k)).filter((v): v is (typeof visible)[number] => !!v);
              if (!rows.length) return null;
              const shown = rows.filter((r) => r.phase !== "landing");
              // A step is complete once its last decision is in, or once a later step has started.
              const later = RAIL_STEPS.slice(i + 1).some((n) => n.keys.some((k) => visible.some((v) => v.c.key === k && v.phase !== "landing")));
              const done = shown.some((r) => r.c.key === g.closes) || later;
              return (
                <li key={g.title} className={`rc-step${done ? " done" : ""}${shown.length ? "" : " landing"}`}>
                  <div className="rc-gh">
                    <span className="rc-gh-t">
                      <span>
                        Step {i + 1} · {g.title}
                      </span>
                      {done ? <Tick className="rc-gh-tick" /> : <span className="rc-gh-live" aria-hidden="true" />}
                    </span>
                    <span className="sr">{done ? "Step complete" : "In progress"}</span>
                  </div>
                  <ol className="rc-list-wrap">
                    {rows.map(({ c, phase }) => (
                      <Row key={c.key} c={c} state={phase === "landing" ? "landing" : "shown"} current={active.has(c.key)} selected={selected} onSelect={onSelect} onOpen={(s, k) => (setDrawer(false), onOpen(s, k))} />
                    ))}
                  </ol>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="lv-rail-empty">Each decision lands here once it&apos;s made.</p>
        )}
        {log ? <LiveLog log={log} /> : null}
        {total ? <RunningTotal total={total} /> : null}
      </div>
    </aside>
  );
}
