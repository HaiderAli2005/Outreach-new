"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { errorCode, errorMessage, useOnboardingAnalyzeMutation, useOnboardingAnswersMutation, useOnboardingKeywordsQuery, useOnboardingUpdateMutation } from "@/store/api";
import type { AnalysisSummary, BuyerGroup, Fact, MarketView, OnboardingState } from "@/lib/types";
import { compact, n0 } from "@/lib/format";
import { Counter } from "./live/motion";
import { audienceIcon } from "./live/cards";

const COUNTRIES = ["United Kingdom", "United States", "Ireland", "Germany", "Netherlands", "France", "United Arab Emirates", "Canada", "Australia"];

const SENIORITY: Record<string, string> = {
  owner: "Owner",
  founder: "Founder",
  c_suite: "C-suite",
  partner: "Partner",
  vp: "VP",
  head: "Head",
  director: "Director",
  manager: "Manager",
  senior: "Senior",
  entry: "Entry level",
  intern: "Intern",
};

export function sizeLabel(s: string): string {
  const [lo, hi] = s.split(",");
  const f = (x: string) => Number(x).toLocaleString("en-US");
  if (!hi) return `${f(lo)}+`;
  return `${f(lo)} to ${f(hi)}`;
}

const ordinal = (n: number) => (n === 1 ? "Run first" : `Priority ${n}`);

/** Where a fact came from, as a place on the site: "your homepage", "/pricing". */
function sourceLabel(src: string) {
  const page = (path: string) => (path === "/" || path === "" ? <>found on your homepage</> : <>found on <code>{path.replace(/\/$/, "")}</code></>);
  if (src.startsWith("/")) return page(src);
  if (src.startsWith("from")) return src;
  try {
    return page(new URL(src).pathname);
  } catch {
    return `found in ${src}`;
  }
}

export function Switch2({ on, onChange, label, disabled }: { on: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" className="sw" role="switch" aria-checked={on} aria-label={label} onClick={onChange} disabled={disabled}>
      <i />
    </button>
  );
}

function AnalysisLoading({ domain }: { domain: string }) {
  const lines = [`Reading ${domain}`, "Understanding what you sell", "Mapping the people who buy it", "Sizing your market"];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => Math.min(lines.length - 1, x + 1)), 2200);
    return () => clearInterval(t);
  }, [lines.length]);
  return (
    <>
      <header className="an-head">
        <h1 className="an-h">
          Reading <span className="grad">{domain}</span>
        </h1>
        <p className="an-p">We&apos;re going through your site to work out what you sell and who is most likely to buy it.</p>
      </header>
      <div className="an-sheet an-load">
        <div className="agent-h">
          <span className="orb" />
          <div>
            <b>Analysing your business</b>
            <small>Usually takes 30 to 60 seconds</small>
          </div>
        </div>
        <div>
          {lines.map((l, k) => (
            <div key={l} className={`scan-row ${k < i ? "done" : k === i ? "run" : ""}`}>
              <span className="st">{k < i ? <Icon id="check" /> : null}</span>
              <span>{l}</span>
              <small />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export function Fallback({
  domain,
  reason,
  detail,
  onRetry,
  canRetry,
  prefill,
}: {
  domain: string;
  reason: "unreadable" | "no-ai" | "failed" | "thin";
  detail?: string;
  onRetry: () => void;
  canRetry: boolean;
  /** What the site did say, so the answers start from it instead of blank. */
  prefill?: { sell?: string | null; regions?: string[] };
}) {
  const found = (prefill?.regions ?? []).filter(Boolean);
  const countries = [...new Set([...found, ...COUNTRIES])];
  const [sell, setSell] = useState(prefill?.sell?.trim() ?? "");
  const [who, setWho] = useState("");
  const [geo, setGeo] = useState<string[]>(found.length ? found : ["United Kingdom"]);
  const [q, setQ] = useState(0);
  const [err, setErr] = useState("");
  const [submit, { isLoading }] = useOnboardingAnswersMutation();
  const field = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  useEffect(() => {
    field.current?.focus();
  }, [q]);
  const flag =
    reason === "unreadable" ? "Couldn't read the site" : reason === "no-ai" ? "Automatic reading isn't set up" : reason === "thin" ? "Not enough on the site" : "The analysis didn't finish";
  const problem = (i: number) => (i === 0 && !sell.trim() ? "Tell us what you sell." : i === 1 && !who.trim() ? "Tell us who buys it." : i === 2 && !geo.length ? "Pick at least one country." : "");
  const forward = () => {
    const p = problem(q);
    if (p) return setErr(p);
    setErr("");
    setQ(q + 1);
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      forward();
    }
  };
  const QUESTIONS = [
    { title: "What do you sell?", hint: prefill?.sell ? "We took this from your site. Change it if it isn't quite right." : "One sentence is enough." },
    { title: "Who buys it?", hint: "Their job title and the kind of company they work at." },
    { title: "Which countries do you sell into?", hint: found.length ? "We found these on your site. Pick every country you sell into." : "Pick every country you sell into." },
  ];
  return (
    <>
      <header className="an-head">
        <span className="fb-flag">
          <Icon id="alert" />
          {flag}
        </span>
        <h1 className="an-h">
          {reason === "unreadable" ? (
            <>
              We couldn&apos;t read <span className="grad">{domain}</span>
            </>
          ) : (
            <>
              Tell us about <span className="grad">{domain}</span>
            </>
          )}
        </h1>
        <p className="an-p">
          {reason === "unreadable"
            ? "The site may block automated visits, or it may still be under construction. Answer three quick questions and we'll build your audience from them."
            : reason === "no-ai"
              ? "This server can't read websites automatically yet. Answer three quick questions and we'll build your audience from them."
              : reason === "thin"
                ? "We could tell what you sell, but your site doesn't say who buys it. Three quick answers and we'll build your audiences."
                : "Something went wrong while reading your site. Try again, or answer three quick questions instead."}
        </p>
        {reason === "failed" && detail ? (
          <div className="banner bad" role="alert" style={{ marginTop: 14 }}>
            {detail}
          </div>
        ) : null}
      </header>
      <form
        className="an-sheet fb fb-one"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (q < 2) return forward();
          const bad = [0, 1, 2].find((i) => problem(i));
          if (bad !== undefined) {
            setQ(bad);
            return setErr(problem(bad));
          }
          setErr("");
          try {
            await submit({ sell: sell.trim(), who: who.trim(), regions: geo }).unwrap();
          } catch (e2) {
            setErr(errorMessage(e2));
          }
        }}
      >
        <div className="fb-prog" aria-hidden="true">
          <span>
            Question {q + 1} of 3
          </span>
          <ol>
            {QUESTIONS.map((_, i) => (
              <li key={i} className={i < q ? "done" : i === q ? "cur" : ""} />
            ))}
          </ol>
        </div>
        <section className="fb-q" key={q}>
          <label className="fb-qt" htmlFor={`fbQ${q}`}>
            {QUESTIONS[q].title}
          </label>
          <p className="fb-qh">{QUESTIONS[q].hint}</p>
          {q === 0 ? (
            <textarea
              ref={(el) => {
                field.current = el;
              }}
              className="an-ta"
              id="fbQ0"
              rows={2}
              maxLength={400}
              placeholder="e.g. Next-day pallet delivery across the UK"
              value={sell}
              onKeyDown={onEnter}
              onChange={(e) => (setSell(e.target.value), setErr(""))}
            />
          ) : q === 1 ? (
            <input
              ref={(el) => {
                field.current = el;
              }}
              className="an-in"
              id="fbQ1"
              maxLength={400}
              placeholder="e.g. Operations managers at online retailers"
              value={who}
              onKeyDown={onEnter}
              onChange={(e) => (setWho(e.target.value), setErr(""))}
            />
          ) : (
            <div className="an-opts" role="group" aria-label="Countries" id="fbQ2">
              {countries.map((c) => (
                <button key={c} type="button" className="an-opt" aria-pressed={geo.includes(c)} onClick={() => (setGeo((g) => (g.includes(c) ? g.filter((x) => x !== c) : [...g, c])), setErr(""))}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </section>
        <div className="fb-foot">
          <p className="au-err" role="alert">
            {err}
          </p>
          {q > 0 ? (
            <button type="button" className="btn btn-text btn-sm" onClick={() => (setErr(""), setQ(q - 1))}>
              Back
            </button>
          ) : canRetry ? (
            <button type="button" className="btn btn-text btn-sm" onClick={onRetry}>
              Try reading the site again
            </button>
          ) : null}
          <Button variant="primary" type="submit" arrow loading={isLoading}>
            {q < 2 ? "Next" : "Build my audience"}
          </Button>
        </div>
      </form>
    </>
  );
}

export function FactsSheet({ facts, company, onCommit }: { facts: Fact[]; company: string; onCommit: (key: Fact["key"], value: string) => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(facts.map((f) => [f.key, f.value])));
  const fit = (t: HTMLTextAreaElement | null) => {
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  };
  return (
    <section className="an-sheet facts">
      <div className="facts-h">
        <h2>About {vals.company || company}</h2>
        <span>Edit anything we got wrong</span>
      </div>
      {facts.map((f) => {
        const common = {
          className: "fact-in",
          id: `fact-${f.key}`,
          dir: "auto",
          value: vals[f.key] ?? "",
          maxLength: 400,
          onBlur: () => (vals[f.key] ?? "").trim() !== f.value && onCommit(f.key, vals[f.key] ?? ""),
        };
        return (
          <div className="fact" key={f.key}>
            <label className="fact-l" htmlFor={`fact-${f.key}`}>
              {f.label}
            </label>
            {f.key === "company" ? (
              <input {...common} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
            ) : (
              <textarea {...common} rows={1} ref={fit} onChange={(e) => (setVals((v) => ({ ...v, [f.key]: e.target.value })), fit(e.currentTarget))} />
            )}
            <span className="src" title="Where this came from">
              <Icon id="link" />
              {sourceLabel(f.source)}
            </span>
          </div>
        );
      })}
    </section>
  );
}

const MAX_KEYWORDS = 5;
const kwNorm = (v: string) => v.toLowerCase().replace(/[^a-z0-9&+ -]+/g, " ").replace(/\s+/g, " ").trim();

export type SaveKeywords = (id: string, keywords: string[]) => Promise<string | null>;

function Keywords({ g, onSave, busy }: { g: BuyerGroup; onSave: SaveKeywords; busy: boolean }) {
  const { data, isFetching } = useOnboardingKeywordsQuery({ group: g.id, key: g.keywords.join("|") }, { skip: !g.on || !g.keywords.length });
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const counts = data?.available && data.groupId === g.id ? data : null;
  const suggestions = g.keywordSuggestions.filter((k) => !g.keywords.includes(k));
  const flagged = (st: "none" | "broad") => (counts?.keywords ?? []).filter((x) => x.state === st && g.keywords.includes(x.keyword)).map((x) => `"${x.keyword}"`);
  const none = flagged("none");
  const broad = flagged("broad");

  const save = async (next: string[]) => {
    const err = await onSave(g.id, next);
    setMsg(err);
    return !err;
  };
  const add = async (raw: string) => {
    const k = kwNorm(raw);
    if (!k) return;
    if (g.keywords.includes(k)) return setMsg(`"${k}" is already in this audience.`);
    if (g.keywords.length >= MAX_KEYWORDS) return setMsg("An audience can have up to 5 keywords. Remove one first, or split this audience.");
    if (await save([...g.keywords, k])) setDraft("");
  };
  const remove = async (k: string) => {
    if (g.keywords.length <= 1) return setMsg("Keep at least one keyword, or this audience would search every company. Add another one first.");
    await save(g.keywords.filter((x) => x !== k));
  };

  return (
    <div className="kw-block">
      <div className="kw-row">
        {g.keywords.map((k) => {
          const c = counts?.keywords.find((x) => x.keyword === k);
          const state = c?.state ?? null;
          const tip =
            state === "none"
              ? "This keyword matches no companies for this audience. Try a different word."
              : state === "broad"
                ? "This keyword barely narrows the search. Most people in this audience match it anyway."
                : c?.count != null
                  ? `${n0(c.count)} people in this audience work at companies tagged "${k}"`
                  : undefined;
          return (
            <span key={k} className={`kw${state === "none" ? " none" : ""}${state === "broad" ? " broad" : ""}`} title={tip}>
              {state === "broad" ? <i className="kw-dot" aria-hidden /> : null}
              <span className="kw-t" dir="auto">{k}</span>
              {g.on && isFetching && !c ? <i className="kw-sk" aria-label="Counting" /> : c?.count != null ? <span className="kw-n">{state === "none" ? "0" : compact(c.count)}</span> : null}
              <button type="button" className="kw-x" aria-label={`Remove ${k}`} onClick={() => remove(k)} disabled={busy}>
                <svg viewBox="0 0 12 12" aria-hidden><path d="M3 3l6 6M9 3l-6 6" /></svg>
              </button>
            </span>
          );
        })}
        <input
          className="kw-in"
          value={draft}
          placeholder="+ add"
          maxLength={60}
          aria-label={`Add a keyword to ${g.name}`}
          disabled={busy}
          onChange={(e) => (setDraft(e.target.value), msg && setMsg(null))}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              void add(draft);
            }
          }}
        />
      </div>
      {none.length ? (
        <p className="kw-warn">
          {none.join(", ")} {none.length === 1 ? "matches" : "match"} no companies here. Remove {none.length === 1 ? "it" : "them"} or try a close word.
        </p>
      ) : null}
      {broad.length ? (
        <p className="kw-note">
          {broad.join(", ")} {broad.length === 1 ? "fits" : "fit"} most of this audience already, so {broad.length === 1 ? "it widens" : "they widen"} your reach more than {broad.length === 1 ? "it narrows" : "they narrow"} it.
        </p>
      ) : null}
      {msg ? (
        <p className="kw-msg" role="alert">
          {msg}
        </p>
      ) : null}
      {suggestions.length ? (
        <div className="kw-sug">
          <span>Suggestions:</span>
          {suggestions.map((k) => (
            <button type="button" key={k} onClick={() => add(k)} disabled={busy} aria-label={`Add ${k}`}>
              + {k}
            </button>
          ))}
        </div>
      ) : null}
      <p className="kw-help">Adding a keyword makes this audience bigger.</p>
    </div>
  );
}

/** Merges touching size bands, so "11 to 50, 51 to 200, 201 to 500" reads as "11 to 500 employees". */
export function sizeRange(sizes: string[]): string {
  const bands = sizes
    .map((x) => x.split(",").map((n) => (n === "" ? null : Number(n))) as [number, number | null])
    .filter(([lo]) => Number.isFinite(lo))
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number | null][] = [];
  for (const [lo, hi] of bands) {
    const last = merged.at(-1);
    if (last && last[1] != null && lo <= last[1] + 1) last[1] = hi == null ? null : Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged.map(([lo, hi]) => sizeLabel(`${lo},${hi ?? ""}`)).join(", ") + " employees";
}

export function GroupCard({
  g,
  count,
  onToggle,
  onKeywords,
  busy = false,
  stale = false,
  readOnly = false,
  examples = [],
}: {
  g: BuyerGroup;
  count: number | null | undefined;
  onToggle?: () => void;
  onKeywords?: SaveKeywords;
  busy?: boolean;
  stale?: boolean;
  /** Same card for reading only: no switch, keywords shown without editing. */
  readOnly?: boolean;
  /** Real people from the market sample in this audience. First name and last initial only. */
  examples?: { firstName: string; lastInitial: string; title: string | null; company: string | null; hasEmail: boolean }[];
}) {
  const more = g.goals.length || g.objections.length || g.technologies.length || g.lookalikeDomains.length;
  const counted = count != null || stale;
  return (
    <article className={`bg bg2${g.on ? "" : " off"}`}>
      <header className="bg2-head">
        <span className="bg2-ic" aria-hidden="true">
          <Icon id={audienceIcon(g.name, g.keywords)} />
        </span>
        <div className="bg2-title">
          <span className={`bg-pri${g.priority === 1 ? " first" : ""}`}>{ordinal(g.priority)}</span>
          <h3 dir="auto">{g.name}</h3>
          {g.description ? <p dir="auto">{g.description}</p> : null}
        </div>
        <div className="bg2-side">
          {!readOnly && onToggle ? <Switch2 on={g.on} onChange={onToggle} label={`Include ${g.name}`} disabled={busy} /> : null}
          <div className="bg2-count">
            {counted ? (
              <>
                <b>
                  <Counter value={count ?? null} stale={stale} />
                </b>
                <span>people match</span>
              </>
            ) : (
              <span>Count appears when lead search is connected</span>
            )}
          </div>
        </div>
      </header>

      {g.why || g.pains.length ? (
        <div className="bg2-insight">
          {g.why ? (
            <section>
              <h4>Why they buy</h4>
              <p dir="auto">{g.why}</p>
            </section>
          ) : null}
          {g.pains.length ? (
            <section>
              <h4>Pain points</h4>
              <ul>
                {g.pains.map((p) => (
                  <li key={p} dir="auto">
                    {p}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}

      <section className="bg2-sec">
        <h4>Who we&apos;ll email</h4>
        <dl className="bg2-facts">
          <div className="wide">
            <dt>Job titles</dt>
            <dd>
              {g.titles.map((t) => (
                <span className="bg-t" key={t} dir="auto">
                  {t}
                </span>
              ))}
              {g.includeSimilarTitles ? <span className="bg2-sim">and similar titles</span> : null}
            </dd>
          </div>
          {g.seniorities.length ? (
            <div>
              <dt>Seniority</dt>
              <dd>{g.seniorities.map((x) => SENIORITY[x] ?? x).join(", ")}</dd>
            </div>
          ) : null}
          <div>
            <dt>Company size</dt>
            <dd>{g.sizes.length ? sizeRange(g.sizes) : "Any size"}</dd>
          </div>
          <div>
            <dt>Countries</dt>
            <dd>{g.regions.join(", ") || "Any country"}</dd>
          </div>
        </dl>
      </section>

      {examples.length ? (
        <section className="bg2-sec">
          <h4>
            Real people in this audience
            <span>Last names and email addresses stay hidden until you launch.</span>
          </h4>
          <ul className="bg2-people">
            {examples.slice(0, 3).map((x, i) => (
              <li key={`${x.firstName}-${x.company}-${i}`}>
                <span className="bg2-av" aria-hidden="true">
                  {x.firstName.charAt(0)}
                </span>
                <span className="bg2-who">
                  <b>
                    {x.firstName} {x.lastInitial ? `${x.lastInitial}.` : ""}
                  </b>
                  <small dir="auto">{[x.title, x.company].filter(Boolean).join(" at ")}</small>
                </span>
                {x.hasEmail ? (
                  <span className="bg2-mail">
                    <Icon id="check" />
                    Email on file
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="bg2-sec">
        <h4>
          Industry keywords
          <span>We look for these words in company profiles.</span>
        </h4>
        {readOnly || !onKeywords ? (
          <div className="bg2-kws">
            {g.keywords.map((k) => (
              <span className="bg-t" key={k} dir="auto">
                {k}
              </span>
            ))}
          </div>
        ) : (
          <Keywords g={g} onSave={onKeywords} busy={busy} />
        )}
      </section>

      {more ? (
        <details className="bg-more">
          <summary>More about this group</summary>
          <dl className="bg-meta">
            {g.goals.length ? (
              <div>
                <dt>Goals</dt>
                <dd>{g.goals.join("; ")}</dd>
              </div>
            ) : null}
            {g.objections.length ? (
              <div>
                <dt>Objections</dt>
                <dd>{g.objections.join("; ")}</dd>
              </div>
            ) : null}
            {g.technologies.length ? (
              <div>
                <dt>Uses</dt>
                <dd>{g.technologies.join(", ")}</dd>
              </div>
            ) : null}
            {g.lookalikeDomains.length ? (
              <div>
                <dt>Looks like</dt>
                <dd>{g.lookalikeDomains.join(", ")}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}
    </article>
  );
}

export function BrandSheet({ a }: { a: AnalysisSummary }) {
  const bd = a.brandDetail;
  const rows: [string, React.ReactNode][] = [];
  if (bd.offerings.length) rows.push(["What they offer", bd.offerings.map((o) => <span className="bg-t" key={o}>{o}</span>)]);
  if (bd.business_model) rows.push(["Sells to", bd.business_model === "both" ? "Businesses and consumers" : bd.business_model === "B2B" ? "Businesses" : "Consumers"]);
  if (bd.customer_size_hint) rows.push(["Customer size", bd.customer_size_hint]);
  if (bd.price_level) rows.push(["Pricing", bd.price_level]);
  if (bd.named_customers.length) rows.push(["Named customers", bd.named_customers.map((c) => <span className="bg-t" key={c}>{c}</span>)]);
  // Each kind of evidence is one row with its items listed inside, so a label never repeats down the table.
  const groups = (
    [
      ["What sets them apart", bd.differentiators],
      ["Proof", bd.proof.slice(1)],
    ] as [string, { text: string; source: string }[]][]
  ).filter(([, items]) => items.length);
  if (!rows.length && !groups.length) return null;
  return (
    <section className="an-sheet brand">
      <div className="facts-h">
        <h2>Offer and positioning</h2>
        {a.source === "answers" ? <span>Built from your answers</span> : null}
      </div>
      {rows.map(([k, v]) => (
        <div className="fact" key={k}>
          <span className="fact-l">{k}</span>
          <div className="brand-v" dir="auto">
            {v}
          </div>
          <span />
        </div>
      ))}
      {groups.map(([k, items]) => (
        <EvidenceRow key={k} label={k} items={items} />
      ))}
    </section>
  );
}

function EvidenceRow({ label, items }: { label: string; items: { text: string; source: string }[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 3);
  return (
    <div className="fact ev-row">
      <span className="fact-l">{label}</span>
      <ul className="ev-list">
        {shown.map((x) => (
          <li key={x.text}>
            <span dir="auto">{x.text}</span>
            <span className="src" title="Where this came from">
              <Icon id="link" />
              {sourceLabel(x.source)}
            </span>
          </li>
        ))}
        {items.length > 3 ? (
          <li className="ev-more">
            <button type="button" className="au-link" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show ${items.length - 3} more`}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export function AnalysisAside({ state, market }: { state: OnboardingState; market: MarketView | undefined }) {
  const o = state.onboarding!;
  if (!o.analyzedAt)
    return (
      <div className="an-sum an-wait">
        <h5>Your audience</h5>
        <div className="an-sk w1" />
        <div className="an-sk w2" />
        <div className="an-sk w3" />
        <div className="an-sk w4" />
        <p className="an-note">{o.siteReadable === false || !state.aiAvailable ? "Answer the three questions to build it." : "Ready in a few seconds."}</p>
      </div>
    );
  const count = (id: string) => market?.groups.find((x) => x.id === id)?.count ?? null;
  return (
    <div className="an-sum">
      <h5>Your audience</h5>
      <div className="an-big">{market?.people != null ? n0(market.people) : market ? "n/a" : "…"}</div>
      <p className="an-bs">{market?.available ? "people match the buyer groups you kept on" : market ? "Connect lead search in Settings to count matching people" : "Counting matching people"}</p>
      <ul className="an-list">
        {o.groups.map((g) => (
          <li key={g.id} className={g.on ? "" : "off"}>
            <span>{g.name}</span>
            <b>{g.on ? (count(g.id) != null ? n0(count(g.id)!) : "n/a") : "Off"}</b>
          </li>
        ))}
      </ul>
      {market?.people && market.verified != null ? (
        <div className="an-q">
          <div className="an-qt">
            <span>With a verified email</span>
            <b>{n0(market.verified)}</b>
          </div>
          <div className="an-track">
            <i style={{ width: `${(market.verified / market.people) * 100}%` }} />
          </div>
        </div>
      ) : null}
      <p className="an-note">Updates as you switch groups on or off or change their keywords. Nothing is sent until you launch.</p>
    </div>
  );
}

export function AnalysisStep({ state, market, setNextDisabled }: { state: OnboardingState; market: MarketView | undefined; setNextDisabled: (b: boolean) => void }) {
  const o = state.onboarding!;
  const [analyze, { isLoading, error }] = useOnboardingAnalyzeMutation();
  const [update, updateState] = useOnboardingUpdateMutation();
  const [updateKeywords, keywordState] = useOnboardingUpdateMutation();
  const saveKeywords: SaveKeywords = async (id, keywords) => {
    try {
      await updateKeywords({ groups: [{ id, keywords }] }).unwrap();
      return null;
    } catch (e) {
      return errorMessage(e);
    }
  };
  const tried = useRef(false);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (tried.current || o.analyzedAt || !state.aiAvailable || o.siteReadable === false || o.analysisError === "low-confidence") return;
    tried.current = true;
    analyze().catch(() => undefined);
  }, [analyze, o.analyzedAt, o.siteReadable, o.analysisError, state.aiAvailable]);

  const onCount = o.groups.filter((g) => g.on).length;
  useEffect(() => {
    setNextDisabled(isLoading || !o.analyzedAt || onCount === 0);
    return () => setNextDisabled(false);
  }, [isLoading, o.analyzedAt, onCount, setNextDisabled]);

  if (isLoading) return <AnalysisLoading domain={o.domain} />;
  if (!o.analyzedAt) {
    const aiDown = error && errorCode(error) === "NOT_CONFIGURED";
    const thin = o.analysisError === "low-confidence";
    if (manual || thin || o.siteReadable === false || !state.aiAvailable || aiDown || error)
      return (
        <Fallback
          domain={o.domain}
          reason={o.siteReadable === false ? "unreadable" : !state.aiAvailable || aiDown ? "no-ai" : thin && !error ? "thin" : "failed"}
          detail={error ? errorMessage(error).replace(/^AI analysis: /, "") : o.analysisError && o.analysisError !== "low-confidence" ? o.analysisError : undefined}
          canRetry={state.aiAvailable && !aiDown}
          onRetry={() => (setManual(false), analyze().catch(() => undefined))}
          prefill={{ sell: o.analysis?.brandDetail?.one_liner, regions: o.analysis?.brandDetail?.geographies }}
        />
      );
    return <AnalysisLoading domain={o.domain} />;
  }

  const fromAnswers = o.facts.some((f) => f.source === "from your answers");
  const count = (id: string) => market?.groups.find((x) => x.id === id)?.count;
  return (
    <>
      <header className="an-head">
        <h1 className="an-h">
          {fromAnswers ? (
            <>
              Here&apos;s who buys from <span className="grad">{o.brand}</span>
            </>
          ) : (
            <>
              Here&apos;s what we found on <span className="grad">{o.domain}</span>
            </>
          )}
        </h1>
        <p className="an-p">Check the facts, then keep the buyer groups you want to reach. {fromAnswers ? "Built from your answers." : "Every fact shows the page it came from."}</p>
      </header>
      {updateState.error ? (
        <div className="banner bad" role="alert" style={{ marginTop: 16 }}>
          {errorMessage(updateState.error)}
        </div>
      ) : null}
      {o.analysisError?.startsWith("answers-only:") ? (
        <div className="banner bad" role="alert" style={{ marginTop: 16 }}>
          <span>The AI analysis didn&apos;t run, so this audience comes only from your answers. {o.analysisError.slice("answers-only:".length).trim()}</span>
        </div>
      ) : null}
      {o.analysis?.warning ? (
        <div className="banner" role="note" style={{ marginTop: 16 }}>
          {o.analysis.warning}
        </div>
      ) : null}
      <FactsSheet facts={o.facts} company={o.brand} onCommit={(key, value) => update({ facts: [{ key, value }] }).catch(() => undefined)} />
      {o.analysis ? <BrandSheet a={o.analysis} /> : null}
      <div className="bg-head">
        <h2>Buyer groups</h2>
        <p>Ranked by where we&apos;d start. Turn off any group you don&apos;t sell to. Your market and preview update to match.</p>
      </div>
      <div className="bg-grid">
        {[...o.groups].sort((a, b) => a.priority - b.priority).map((g) => (
          <GroupCard key={g.id} g={g} count={count(g.id)} busy={updateState.isLoading || keywordState.isLoading} onKeywords={saveKeywords} onToggle={() => update({ groups: [{ id: g.id, on: !g.on }] }).catch(() => undefined)} />
        ))}
      </div>
      <div className="an-inline">
        <span>People matching your buyers</span>
        <b>{market?.people != null ? n0(market.people) : "n/a"}</b>
      </div>
      {!fromAnswers && state.aiAvailable ? (
        <p className="fine" style={{ marginTop: -8 }}>
          Not right?{" "}
          <button type="button" className="au-link" onClick={() => analyze().catch(() => undefined)}>
            Read the site again
          </button>
        </p>
      ) : null}
    </>
  );
}
