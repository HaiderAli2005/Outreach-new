"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorCode, errorMessage, useOnboardingAnalyzeMutation, useOnboardingPreviewMutation, useOnboardingUpdateMutation } from "@/store/api";
import { useAppDispatch } from "@/store";
import type { MarketView, OnboardingState } from "@/lib/types";
import { BrandSheet, FactsSheet, Fallback, GroupCard } from "../AnalysisStep";
import { MarketTabs } from "../PreviewStep";
import { Icon } from "@/components/ui/Icon";
import { useSignOut } from "@/components/shell/session";
import { n0 } from "@/lib/format";
import { EmailsPanel, LiveAnalysis, type Lead, type PhaseKey } from "./LiveAnalysis";
import { useDock } from "./motion";
import type { RunState } from "./run";

export type AnalysisView = "review" | "business" | "buyers" | "market";

const MAX_RESTARTS = 3;

function leadsFromMarket(market: MarketView | undefined, audience: string | null): Lead[] {
  return (market?.prospects ?? [])
    .filter((p) => !audience || !p.audienceId || p.audienceId === audience)
    .map((p, i) => ({ key: `${p.audienceId ?? "m"}-${i}-${p.firstName}`, audienceId: p.audienceId, firstName: p.firstName, lastMasked: `${p.lastInitial}***`, title: p.title, company: p.company, hasEmail: p.hasEmail }));
}

/**
 * Step 3 with the live stream. Starts the run once, follows it (a reload replays it), and when
 * the presentation has docked everything shows the facts to check.
 */
/** Shown when the account's email isn't confirmed yet: the analysis only runs for confirmed accounts. */
function VerifyFirst({ domain }: { domain: string }) {
  const signOut = useSignOut();
  return (
    <div className="ph-stage">
      <div className="ph-panel">
        <header className="ph-head">
          <span className="fb-flag">
            <Icon id="st-mail" />
            Confirm your email first
          </span>
          <h1 className="ph-h">
            One step before we analyse <span className="grad">{domain}</span>
          </h1>
          <p className="ph-sub">
            We only run the analysis for confirmed accounts. Sign in again and we&apos;ll send a confirmation email. Tap the number in it and your analysis starts straight away.
          </p>
        </header>
        <p>
          <button type="button" className="btn btn-primary" onClick={() => void signOut()}>
            Sign in and confirm
            <Icon id="arr" className="arr" />
          </button>
        </p>
      </div>
    </div>
  );
}

export function AnalysisFlow({
  state,
  run,
  presenting,
  onPresent,
  onPresented,
  setNextDisabled,
  market,
  audience,
  view,
  onView,
  resumePhase,
  onPhase,
}: {
  state: OnboardingState;
  run: RunState;
  presenting: boolean;
  /** fresh: a new run is being started, so the previous run's id must not be followed. */
  onPresent: (fresh: boolean) => void;
  onPresented: () => void;
  setNextDisabled: (b: boolean) => void;
  market: MarketView | undefined;
  audience: string | null;
  view: AnalysisView;
  onView: (v: AnalysisView) => void;
  resumePhase: PhaseKey | null;
  onPhase: (p: PhaseKey) => void;
}) {
  const o = state.onboarding!;
  const dock = useDock();
  const [writeEmails, writing] = useOnboardingPreviewMutation();
  const wrote = useRef(false);
  const dispatch = useAppDispatch();
  const [start, { isLoading: starting, error: startError }] = useOnboardingAnalyzeMutation();
  const [update, updateState] = useOnboardingUpdateMutation();
  const tried = useRef(false);
  /** Automatic restarts after a server restart cut a run off. Capped so a server that keeps crashing shows the error. */
  const restarts = useRef(0);
  const [ask, setAsk] = useState(false);
  const runState = state.analysisRun ?? null;

  const begin = useCallback(() => {
    onPresent(true);
    // If the run can't even start (email not confirmed, AI not set up), stop the live view so the reason shows.
    start()
      .unwrap()
      .catch(() => onPresented());
  }, [start, onPresent, onPresented]);

  useEffect(() => {
    if (tried.current || !state.aiAvailable) return;
    if (runState?.status === "RUNNING") {
      tried.current = true;
      onPresent(false);
      return;
    }
    // A finished run with nothing saved means the domain was entered again after a switch, and an interrupted run
    // means the server restarted mid-run. Neither is the user's problem: analyse it fresh.
    const interrupted = runState?.status === "FAILED" && runState.error === "interrupted";
    if (o.analyzedAt || (runState?.status === "FAILED" && !interrupted) || o.siteReadable === false || o.analysisError === "low-confidence") return;
    tried.current = true;
    if (interrupted) restarts.current++;
    begin();
  }, [state.aiAvailable, runState, o.analyzedAt, o.siteReadable, o.analysisError, begin, onPresent]);

  // A run that was joined but had been cut off by a server restart starts again once, on its own.
  useEffect(() => {
    if (run.error?.code !== "interrupted" || restarts.current >= MAX_RESTARTS) return;
    restarts.current++;
    begin();
  }, [run.error, begin]);

  useEffect(() => {
    if (run.done || run.error) {
      dispatch(api.util.invalidateTags(["Onboarding"]));
    }
  }, [run.done, run.error, dispatch]);

  useEffect(() => {
    setNextDisabled(presenting || starting || !o.analyzedAt);
    return () => setNextDisabled(false);
  }, [presenting, starting, o.analyzedAt, setNextDisabled]);

  const needEmails = !presenting && !!o.analyzedAt && !o.preview?.length && state.aiAvailable && !!o.summary && o.groups.some((g) => g.on);
  useEffect(() => {
    if (!needEmails || wrote.current) return;
    wrote.current = true;
    writeEmails().catch(() => undefined);
  }, [needEmails, writeEmails]);

  if (presenting)
    return <LiveAnalysis domain={o.domain} run={run} onFinished={onPresented} initialPhase={resumePhase} onPhase={onPhase} audience={audience} brand={o.brand} />;

  if (!o.analyzedAt) {
    const aiDown = (startError && errorCode(startError) === "NOT_CONFIGURED") || !state.aiAvailable;
    const thin = o.analysisError === "low-confidence";
    const unreadable = o.siteReadable === false || run.error?.code === "site-unreadable";
    const detail = startError ? errorMessage(startError).replace(/^AI analysis: /, "") : run.error?.message ?? (o.analysisError && !thin ? o.analysisError : undefined);
    if (errorCode(startError) === "EMAIL_NOT_VERIFIED") return <VerifyFirst domain={o.domain} />;
    if (thin || unreadable || aiDown || startError || runState?.status === "FAILED" || run.error)
      return (
        <Fallback
          domain={o.domain}
          reason={unreadable ? "unreadable" : aiDown ? "no-ai" : thin ? "thin" : "failed"}
          detail={detail}
          canRetry={!aiDown}
          onRetry={begin}
          prefill={{ sell: o.analysis?.brandDetail?.one_liner, regions: o.analysis?.brandDetail?.geographies }}
        />
      );
    return (
      <div className="lv-an">
        <p className="lv-wait">
          <span className="lv-caret" aria-hidden="true" />
          Starting the analysis of {o.domain}
        </p>
      </div>
    );
  }

  const fromAnswers = o.facts.some((f) => f.source === "from your answers");
  const count = (id: string) => market?.groups.find((g) => g.id === id)?.count ?? null;
  const bestGuess = !fromAnswers && o.analysis?.source === "site" && o.analysis.lowConfidence;
  const guessNote = bestGuess ? (
    <p className="lv-guess" role="note">
      <Icon id="alert" />
      <span>
        Your site says little about who buys from you, so these audiences are our best guess.{" "}
        <button type="button" className="au-link" onClick={() => setAsk(true)}>
          Answer three questions to sharpen them
        </button>
      </span>
    </p>
  ) : null;

  if (ask && bestGuess)
    return (
      <>
        <p className="ph-back">
          <button type="button" className="au-link" onClick={() => setAsk(false)}>
            Keep the best guess
          </button>
        </p>
        <Fallback domain={o.domain} reason="thin" canRetry={!!state.aiAvailable} onRetry={begin} prefill={{ sell: o.analysis?.brandDetail?.one_liner, regions: o.analysis?.brandDetail?.geographies }} />
      </>
    );

  if (view === "buyers") {
    const groups = [...o.groups].filter((g) => g.on && (!audience || g.id === audience)).sort((a, b) => a.priority - b.priority);
    return (
      <div className="ph-stage">
        <div className="ph-panel">
          <header className="ph-head">
            <h1 className="ph-h">Who buys from you</h1>
            <p className="ph-sub">Ranked by where we&apos;d start. You can change keywords and switch audiences off in your free overview.</p>
          </header>
          {guessNote}
          <div className="bg-grid">
            {groups.map((g) => (
              <GroupCard key={g.id} g={g} count={count(g.id)} readOnly examples={(market?.prospects ?? []).filter((x) => x.audienceId === g.id)} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (view === "market")
    return (
      <div className="ph-stage">
        <div className="ph-panel">
          <header className="ph-head">
            <h1 className="ph-h">Your market</h1>
            <p className="ph-sub">How many people match your audiences, and how many we can reach with a verified work email.</p>
          </header>
          {market?.available ? (
            <div className="ph-card">
              <div className="mk-big">
                <div>
                  <span>People who match</span>
                  <b>{market.people != null ? n0(market.people) : "n/a"}</b>
                </div>
                <div>
                  <span>With a verified work email</span>
                  <b>{market.verified != null ? n0(market.verified) : "n/a"}</b>
                </div>
              </div>
              <div className="mk-legend" aria-hidden="true">
                <span>Audience</span>
                <span>Match</span>
                <span>Reachable</span>
                <span>Share reachable</span>
              </div>
              <ul className="mk-rows">
                {o.groups
                  .filter((g) => g.on && (!audience || g.id === audience))
                  .map((g) => {
                    const c = market.groups.find((x) => x.id === g.id);
                    const share = c?.count && c.verified != null ? Math.min(1, c.verified / c.count) : 0;
                    return (
                      <li key={g.id}>
                        <span className="mk-name">{g.name}</span>
                        <span className="mk-v">{c?.count != null ? n0(c.count) : "n/a"}</span>
                        <span className="mk-v muted">{c?.verified != null ? n0(c.verified) : "n/a"}</span>
                        <span className="mk-bar" aria-hidden="true">
                          <i style={{ width: `${share * 100}%` }} />
                        </span>
                      </li>
                    );
                  })}
              </ul>
              <MarketTabs market={market} people={market.people} audience={audience} />
            </div>
          ) : (
            <div className="ph-card">
              <p className="lv-note">
                {market?.reason === "not-connected" ? "Lead search isn't connected yet, so we can't count matching people." : market ? "The lead search didn't answer just now. Try again in a minute." : "Counting matching people"}
              </p>
            </div>
          )}
        </div>
      </div>
    );

  if (view === "review")
    return (
      <div className="ph-stage">
        <div className="ph-panel">
          <header className="ph-head">
            <h1 className="ph-h">Your first email</h1>
            <p className="ph-sub">Written from your analysis for a real lead in your market. You can edit every word before launch.</p>
          </header>
          {guessNote}
          <EmailsPanel
            leads={leadsFromMarket(market, audience)}
            drafts={(o.preview ?? []).map((d) => ({ subject: d.subject, body: d.body, tab: d.tab, day: d.day, sender: d.sender }))}
            animate={false}
            writing={writing.isLoading}
            brand={o.brand}
            dockRef={dock.source("sequence")}
            language={o.analysis?.brandDetail?.language ?? null}
          />
          {writing.error ? (
            <div className="banner bad" role="alert">
              {errorMessage(writing.error)}
            </div>
          ) : null}
        </div>
      </div>
    );

  return (
    <div className="ph-stage">
      <div className="ph-panel">
      <header className="ph-head">
        <h1 className="ph-h">
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
        <p className="ph-sub">Check the facts and edit anything we got wrong. Your audiences and emails are built from them.</p>
      </header>
      {updateState.error ? (
        <div className="banner bad" role="alert" >
          {errorMessage(updateState.error)}
        </div>
      ) : null}
      {o.analysisError?.startsWith("answers-only:") ? (
        <div className="banner bad" role="alert" >
          <span>The AI analysis didn&apos;t run, so this audience comes only from your answers. {o.analysisError.slice("answers-only:".length).trim()}</span>
        </div>
      ) : null}
      {o.analysis?.warning ? (
        <div className="banner" role="note" >
          {o.analysis.warning}
        </div>
      ) : null}
      <FactsSheet facts={o.facts} company={o.brand} onCommit={(key, value) => update({ facts: [{ key, value }] }).catch(() => undefined)} />
      {o.analysis ? <BrandSheet a={o.analysis} /> : null}
      {!fromAnswers && state.aiAvailable ? (
        <p className="fine">
          Not right?{" "}
          <button type="button" className="au-link" onClick={begin}>
            Read the site again
          </button>
        </p>
      ) : null}
      </div>
    </div>
  );
}
