"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { errorMessage, useOnboardingPreviewMutation, useOnboardingUpdateMutation } from "@/store/api";
import type { BuyerGroup, Catalogue, MarketView, OnboardingState, VolumeOptions } from "@/lib/types";
import { GroupCard, type SaveKeywords } from "./AnalysisStep";
import { Counter } from "./live/motion";
import { n0 } from "@/lib/format";
import { StepCta } from "./StepCta";

function withTokens(text: string): ReactNode[] {
  return text.split(/(\{\{\w+\}\})/g).map((p, i) =>
    /^\{\{\w+\}\}$/.test(p) ? (
      <span className="tok" key={i}>
        {p}
      </span>
    ) : (
      p
    ),
  );
}

function Bars({ title, data }: { title: string; data: [string, number][] }) {
  const mx = Math.max(1, ...data.map((d) => d[1]));
  const tot = data.reduce((a, d) => a + d[1], 0) || 1;
  return (
    <figure className="mk-chart">
      <figcaption>{title}</figcaption>
      {data.length ? (
        data.map(([k, v]) => (
          <div className="bar-row" key={k} title={`${k}: ${v} of ${tot} people in the sample (${Math.round((v / tot) * 100)}%)`}>
            <span className="bar-k">{k}</span>
            <span className="bar-t">
              <i style={{ width: `calc((100% - 64px) * ${(v / mx).toFixed(3)})` }} />
              <b>{Math.round((v / tot) * 100)}%</b>
            </span>
          </div>
        ))
      ) : (
        <p className="fine">Not enough data in the sample.</p>
      )}
    </figure>
  );
}

const sizeBand = (n: number | null) => (n == null ? "" : n <= 10 ? "1 to 10 staff" : n <= 50 ? "11 to 50 staff" : n <= 200 ? "51 to 200 staff" : n <= 1000 ? "201 to 1,000 staff" : "1,000+ staff");

/** How many example companies and people show before "Show all". */
const COMPANIES_SHOWN = 24;
const PEOPLE_SHOWN = 12;

export function MarketTabs({ market, people, audience, initialTab = "companies" }: { market: MarketView; people: number | null; audience: string | null; initialTab?: "companies" | "people" }) {
  const [tab, setTab] = useState<"companies" | "people">(initialTab);
  const [allCompanies, setAllCompanies] = useState(false);
  const [allPeople, setAllPeople] = useState(false);
  const companies = (market.companies ?? []).filter((c) => !audience || c.audienceId === audience);
  const prospects = market.prospects.filter((p) => !audience || !p.audienceId || p.audienceId === audience);
  const hasCountry = prospects.some((p) => p.country);
  // The free people search often returns only a company's name. Then the table shows who matches there instead of empty columns.
  const rich = companies.some((c) => c.domain || c.country || c.employees);
  const pick = (t: "companies" | "people") => () => setTab(t);
  return (
    <div className="mk-tabs">
      <div className="mk-tabbar" role="tablist" aria-label="Matching companies and people">
        <button type="button" role="tab" id="mk-tab-companies" aria-selected={tab === "companies"} aria-controls="mk-panel" onClick={pick("companies")}>
           Companies <span>{companies.length}</span>
        </button>
        <button type="button" role="tab" id="mk-tab-people" aria-selected={tab === "people"} aria-controls="mk-panel" onClick={pick("people")}>
          People <span>{prospects.length}</span>
        </button>
      </div>
      <div id="mk-panel" role="tabpanel" aria-labelledby={`mk-tab-${tab}`}>
        {tab === "companies" ? (
          companies.length ? (
            <>
              <p className="fine mk-note">
                {companies.length} example {companies.length === 1 ? "company" : "companies"} where the {market.sample.size} people in our sample work. This is not a count of every company in your market.
              </p>
              <ul className={`co-list${rich ? "" : " lean"}`}>
                <li className="co-row co-head" aria-hidden="true">
                  <span />
                  <span>Company</span>
                  {rich ? (
                    <>
                      <span>Website</span>
                      <span>Country</span>
                      <span>Size</span>
                    </>
                  ) : (
                    <>
                      <span>Who matches there</span>
                      <span>People</span>
                    </>
                  )}
                </li>
                {(allCompanies ? companies : companies.slice(0, COMPANIES_SHOWN)).map((c) => (
                  <li key={`${c.audienceId}-${c.domain ?? c.name}`} className="co-row">
                    <span className="co-av" aria-hidden="true">
                      {c.name.charAt(0)}
                    </span>
                    <div className="co-main">
                      <b dir="auto">{c.name}</b>
                      {c.description ? <small>{c.description}</small> : null}
                    </div>
                    {rich ? (
                      <>
                        <span className="co-dom">{c.domain ?? ""}</span>
                        <span className="co-meta">{c.country ?? ""}</span>
                        <span className="co-meta">{sizeBand(c.employees)}</span>
                      </>
                    ) : (
                      <>
                        <span className="co-meta co-titles">{(c.titles ?? []).join(", ")}</span>
                        <span className="co-meta co-n">{c.people ?? 1}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {companies.length > COMPANIES_SHOWN ? (
                <button type="button" className="btn btn-text btn-sm mk-more" aria-expanded={allCompanies} onClick={() => setAllCompanies((v) => !v)}>
                  {allCompanies ? "Show fewer" : `Show all ${companies.length} companies`}
                </button>
              ) : null}
            </>
          ) : (
            <p className="fine mk-note">Company examples appear after the next market count.</p>
          )
        ) : prospects.length ? (
          <>
            <p className="fine mk-note">
              {n0(prospects.length)} {prospects.length === 1 ? "person" : "people"} from a sample of {n0(Math.max(market.sample.size, prospects.length))}
              {people != null ? `, out of ${n0(people)} who match` : ""}. Last names are hidden and no email address is shown before your campaign starts.
            </p>
            <div className="pt-wrap">
              <table className="pt">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Job title</th>
                    <th>Company</th>
                    {hasCountry ? <th>Country</th> : null}
                    <th>Email</th>
                  </tr>
                </thead>
                <tbody>
                  {(allPeople ? prospects : prospects.slice(0, PEOPLE_SHOWN)).map((r, i) => (
                    <tr key={i}>
                      <td data-l="Name">
                        <span className="pt-av">{r.firstName.charAt(0)}</span>
                        <b>
                          {r.firstName} {r.lastInitial}***
                        </b>
                      </td>
                      <td data-l="Title" dir="auto">
                        {r.title}
                      </td>
                      <td data-l="Company" dir="auto">
                        {r.company}
                      </td>
                      {hasCountry ? <td data-l="Country">{r.country}</td> : null}
                      <td data-l="Email">
                        {r.hasEmail ? (
                          <span className="pt-ok">
                            <Icon id="check" />
                            Email available
                          </span>
                        ) : (
                          <span className="fine">Checked at send time</span>
                        )}
                        <span className="pt-lk" title="Unlocks when your campaign starts" aria-label="Locked until your campaign starts">
                          <Icon id="lock" />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {prospects.length > PEOPLE_SHOWN ? (
              <button type="button" className="btn btn-text btn-sm mk-more" aria-expanded={allPeople} onClick={() => setAllPeople((v) => !v)}>
                {allPeople ? "Show fewer" : `Show all ${n0(prospects.length)} people`}
              </button>
            ) : null}
          </>
        ) : (
          <p className="fine mk-note">No sample people to show yet.</p>
        )}
      </div>
    </div>
  );
}

/** Which part of the overview is open: everything, or just the part a rail card points at. */
export type PreviewFocus = "all" | "market" | "prospects" | "audiences";

export function PreviewStep({
  focus = "all",
  onShowAll = () => undefined,
  state,
  cat,
  market,
  marketLoading,
  emails,
  volume,
  onEmails,
  onBack,
  setNextDisabled,
  audience = null,
  onAudience = () => undefined,
}: {
  state: OnboardingState;
  cat: Catalogue;
  market: MarketView | undefined;
  marketLoading: boolean;
  emails: number;
  /** What the pool can deliver for this customer; presets above it are shown disabled with the reason. */
  volume: VolumeOptions | undefined;
  onEmails: (emails: number) => void;
  onBack: () => void;
  setNextDisabled: (b: boolean) => void;
  /** Audience picked in the rail. The audiences, companies and people below show only that one. */
  audience?: string | null;
  onAudience?: (id: string | null) => void;
  focus?: PreviewFocus;
  onShowAll?: () => void;
}) {
  const o = state.onboarding!;
  const onGroups = o.groups.filter((g) => g.on);
  const [update, updateState] = useOnboardingUpdateMutation();
  const [updateKeywords, keywordState] = useOnboardingUpdateMutation();
  const [seen, setSeen] = useState<Record<string, string>>({});
  const sig = (g: BuyerGroup) => `${g.on}|${g.keywords.join(",")}`;

  useEffect(() => {
    setNextDisabled(!onGroups.length);
    return () => setNextDisabled(false);
  }, [onGroups.length, setNextDisabled]);

  useEffect(() => {
    if (market && !marketLoading) setSeen(Object.fromEntries(o.groups.map((g) => [g.id, `${g.on}|${g.keywords.join(",")}`])));
  }, [market, marketLoading, o.groups]);

  const saveKeywords: SaveKeywords = async (id, keywords) => {
    try {
      await updateKeywords({ groups: [{ id, keywords }] }).unwrap();
      return null;
    } catch (e) {
      return errorMessage(e);
    }
  };

  const people = market?.people ?? null;
  const count = (id: string) => market?.groups.find((x) => x.id === id)?.count;
  const busy = updateState.isLoading || keywordState.isLoading;
  const prospectCount = (market?.prospects ?? []).filter((x) => !audience || !x.audienceId || x.audienceId === audience).length;
  const show = { audiences: focus === "all" || focus === "audiences", market: focus === "all" || focus === "market", tabs: focus === "all" || focus === "prospects" };

  return (
    <>
      <header className="an-head pv-head">
        <span className="nosend">
          <span className="nosend-ic" aria-hidden="true">
            <Icon id="shield" />
          </span>
          <b>Free overview</b>
          <i aria-hidden="true" />
          <span className="nosend-sub">Nothing is sent until you launch</span>
        </span>
        {focus === "prospects" ? (
          <>
            <h1 className="an-h">
              {prospectCount} sample prospect{prospectCount === 1 ? "" : "s"} for <span className="grad">{o.brand}</span>
            </h1>
            <p className="an-p">Real people from your market, taken from the audiences you kept on, with the companies they work at. Surnames stay shortened until you launch.</p>
          </>
        ) : focus === "audiences" ? (
          <>
            <h1 className="an-h">
              Your audiences: {onGroups.length} on{o.groups.length - onGroups.length ? `, ${o.groups.length - onGroups.length} off` : ""}
            </h1>
            <p className="an-p">Only the audiences you keep on get emails. Switch one off or change its keywords, and only its count updates.</p>
          </>
        ) : (
          <>
            <h1 className="an-h">
              {people != null ? (
                <>
                  <Counter value={people} /> people match <span className="grad">{o.brand}</span>&apos;s buyers
                </>
              ) : (
                <>
                  Your {focus === "market" ? "market" : "overview"} for <span className="grad">{o.brand}</span>
                </>
              )}
            </h1>
            <p className="an-p">
              {focus === "market"
                ? "How many people match, how many have a verified work email, and who they are. You set your daily budget in the next step."
                : "Tune your audiences and check your market. You set your daily budget in the next step."}
            </p>
          </>
        )}
        <StepCta />
        {focus !== "all" ? (
          <div className="pv-all">
            <Button size="sm" icon="list" onClick={onShowAll}>
              See the full overview
            </Button>
          </div>
        ) : null}
        {audience && o.groups.some((g) => g.id === audience) ? (
          <p className="aud-filter">
            Showing <b>{o.groups.find((g) => g.id === audience)!.name}</b>
            <button type="button" className="au-link" onClick={() => onAudience(null)}>
              Show all audiences
            </button>
          </p>
        ) : null}
      </header>

      {updateState.error ? (
        <div className="banner bad" role="alert" style={{ marginTop: 16 }}>
          {errorMessage(updateState.error)}
        </div>
      ) : null}

      {show.audiences ? (
      <section className="pv-aud">
        <div className="bg-head">
          <h2>Your audiences</h2>
          <p>Ranked by where we&apos;d start. Change keywords or switch an audience off, and only its count updates.</p>
        </div>
        <div className="bg-grid">
          {[...o.groups]
            .filter((g) => !audience || g.id === audience)
            .sort((a, b) => a.priority - b.priority)
            .map((g) => (
              <GroupCard
                key={g.id}
                g={g}
                count={g.on ? count(g.id) : null}
                stale={g.on && marketLoading && seen[g.id] !== undefined && seen[g.id] !== sig(g)}
                busy={busy}
                onKeywords={saveKeywords}
                onToggle={() => update({ groups: [{ id: g.id, on: !g.on }] }).catch(() => undefined)}
                examples={g.on ? (market?.prospects ?? []).filter((x) => x.audienceId === g.id) : []}
              />
            ))}
        </div>
        {!onGroups.length ? (
          <div className="banner" role="note">
            Switch at least one audience on to continue.{" "}
            <button type="button" className="au-link" onClick={onBack}>
              Back to the analysis
            </button>
          </div>
        ) : null}
      </section>
      ) : null}

      {focus === "prospects" ? (
        <section className="pv-card mk">
          <div className="pv-h">
            <div>
              <h2>Sample prospects</h2>
              <p>People and companies in your market. Pick one audience in the left panel to see only its people.</p>
            </div>
          </div>
          {market?.available ? (
            <MarketTabs market={market} people={people} audience={audience} initialTab="people" />
          ) : (
            <p className="fine">{marketLoading ? "Loading your sample…" : "The lead search isn't connected yet, so there are no sample prospects to show."}</p>
          )}
        </section>
      ) : null}

      {show.market ? (
      <section className="pv-card mk">
        <div className="pv-h">
          <div>
            <h2>Your market</h2>
            <p>
              People who match the {onGroups.length} audience{onGroups.length === 1 ? "" : "s"} you kept on.
              {market?.available && market.sample.size ? ` Breakdowns are from a sample of ${market.sample.size} matching people.` : ""}
            </p>
          </div>
        </div>
        {marketLoading && !market ? (
          <div className="mk-nums">
            <div>
              <span className="mk-l">People matching your buyers</span>
              <div className="an-sk w1" style={{ marginTop: 10 }} />
            </div>
            <div>
              <span className="mk-l">With a verified work email</span>
              <div className="an-sk w1" style={{ marginTop: 10 }} />
            </div>
          </div>
        ) : market?.available ? (
          <>
            <div className="mk-nums">
              <div>
                <span className="mk-l">People matching your buyers</span>
                <b className="mk-n">
                  <Counter value={people} stale={marketLoading} />
                </b>
                {people != null && people < 1000 ? <span className="mk-s warn">A niche market. Pace your sending so it lasts.</span> : null}
              </div>
              <div>
                <span className="mk-l">With a verified work email</span>
                <b className="mk-n">
                  <Counter value={market.verified} stale={marketLoading} />
                </b>
                {people && market.verified != null ? <span className="mk-s">{Math.round((market.verified / people) * 100)}% of matches</span> : null}
              </div>
            </div>
            {(() => {
              const charts = ([
                ["By country", market.sample.byCountry],
                ["By company size", market.sample.bySize],
                ["By seniority", market.sample.bySeniority],
              ] as [string, [string, number][]][]).filter(([, d]) => d.length);
              const missing = !market.sample.byCountry.length || !market.sample.bySize.length;
              return (
                <>
                  {charts.length ? (
                    <div className="mk-charts">
                      {charts.map(([title, d]) => (
                        <Bars key={title} title={title} data={d} />
                      ))}
                    </div>
                  ) : null}
                  {missing && market.sample.size ? <p className="fine mk-note">The lead search doesn&apos;t share each person&apos;s country or company size in a free search, so those breakdowns aren&apos;t shown.</p> : null}
                </>
              );
            })()}
            {show.tabs ? <MarketTabs market={market} people={people} audience={audience} /> : null}
          </>
        ) : (
          <div className="notice glass info" role="note">
            <span className="ic">
              <Icon id="search" />
            </span>
            <div>
              <h3>{market?.reason === "lookup-failed" ? "The lead search didn't answer" : "Lead search isn't connected yet"}</h3>
              <p>
                {market?.reason === "lookup-failed"
                  ? "We couldn't size your market just now. You can continue and check again later."
                  : "Market size, the sample prospects and the recommended pace come from your lead database. Connect Apollo in Settings after setup, or ask your administrator to add a platform key."}
              </p>
            </div>
          </div>
        )}
      </section>
      ) : null}
    </>
  );
}
