"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon, Mark, type IconId } from "@/components/ui/Icon";
import { ErrorState } from "@/components/ui/primitives";
import { FullPageLoader, useSessionBootstrap } from "@/components/shell/session";
import { useCreateWorkspace } from "@/components/shell/NoWorkspace";
import { SiteNotice, useSiteCheck } from "@/components/domain/SiteCheck";
import { useAppDispatch, useAppSelector, useToast } from "@/store";
import { sessionReceived } from "@/store/authSlice";
import {
  api,
  refreshSession,
  errorMessage,
  useOnboardingMarketQuery,
  useOnboardingQuery,
  useOnboardingStartMutation,
  useOnboardingUpdateMutation,
  usePlansQuery,
  useCreditsQuery,
  useOnboardingVolumeQuery,
  useSkipCardMutation,
} from "@/store/api";
import type { OnboardingState } from "@/lib/types";
import { normDomain, validDomain } from "@/lib/format";
import { AuthCard } from "./AuthStep";
import { AuthHeader } from "@/components/auth/AuthHeader";
import { AnalysisStep } from "./AnalysisStep";
import { PreviewStep, type PreviewFocus } from "./PreviewStep";
import { CardStep, VolumeStep, type Draft } from "./SetupSteps";
import { DockProvider, ProgressRing, useDock } from "./live/motion";
import { useRunStream } from "./live/run";
import { Rail, type RailLog } from "./live/Rail";
import { AnalysisFlow, type AnalysisView } from "./live/AnalysisFlow";
import { PHASES, type PhaseKey } from "./live/LiveAnalysis";
import { railCards, runningTotal } from "./live/cards";
import { SETUP_STEPS } from "./live/steps";
import { LaunchStep } from "./LaunchStep";
import type { PayHandle } from "./Payment";
import { AuthShell } from "@/components/auth/AuthShell";

const STEPS: [string, IconId][] = SETUP_STEPS.map((x) => [x.label, x.icon]);
const LIVE_KEYS = ["business", "buyers", "market", "sequence"];
const ALL_KEYS = [...LIVE_KEYS, "volume", "credits", "setup"];
/** Steps after sign-up: 1 analysis, 2 free overview, 3 emails a day, 4 add your card, 5 campaign start. One path. */
const LAST = 5;

/** Where a setup resumes. Steps run in order: a card on file never skips an analysis that hasn't finished. */
function initialStep(s: OnboardingState): number {
  const o = s.onboarding;
  if (o?.launchedAt) return LAST;
  if (!o?.analyzedAt || !o.preview?.length) return 1;
  return s.funded ? 4 : 3;
}

/** The saved emails a day, or none yet: the page then starts from the server's recommendation, never the maximum. */
function draftFrom(s: OnboardingState): Draft {
  return { emails: s.emailsPerDay ?? 0, set: s.emailsPerDay !== null };
}


function ValueBar({ cta, onExit, exitLabel, compact }: { cta: React.ReactNode; onExit: () => void; exitLabel: string; compact: boolean }) {
  return (
    <header className="vb">
      <div className="vb-in">
        <Link className="logo" href="/" aria-label="Aperture home">
          <Mark />
          <span>Aperture</span>
        </Link>
        {!compact ? (
          <div className="vb-val">
            <b>Your first outbound campaign, set up while you watch</b>
            <ul className="vb-proofs">
              <li>
                <Icon id="check" />
                Nothing sends until you launch
              </li>
              <li>
                <Icon id="check" />
                Your main domain never sends cold email
              </li>
              <li>
                <Icon id="check" />
                Every fact shows where it came from
              </li>
            </ul>
          </div>
        ) : (
          <span className="spacer" />
        )}
        <button type="button" className="obh-exit" onClick={onExit}>
          <span>{exitLabel}</span>
        </button>
        {cta ? <div className="vb-cta">{cta}</div> : null}
      </div>
    </header>
  );
}

function StepPills({ cur, max, onGo, locked, hasDomain, onBack, canBack }: { cur: number; max: number; onGo: (i: number) => void; locked: boolean; hasDomain: boolean; onBack: () => void; canBack: boolean }) {
  const barRef = useRef<HTMLOListElement>(null);
  const at = cur + 1;
  useEffect(() => {
    const bar = barRef.current;
    const c = bar?.querySelector<HTMLElement>(".pill.cur");
    if (bar && c) bar.scrollLeft = c.offsetLeft - bar.clientWidth / 2 + c.offsetWidth / 2;
  }, [cur]);
  return (
    <nav className="pills" aria-label="Setup steps">
      {canBack ? (
        <button type="button" className="pills-back" onClick={onBack} disabled={locked}>
          <Icon id="back" />
          <span>Back</span>
        </button>
      ) : null}
      <ol ref={barRef}>
        {STEPS.map(([label], i) => {
          const done = i === 0 ? hasDomain : i < at;
          const st = i === at ? "cur" : done ? "done" : "todo";
          const step = i - 1;
          const can = !locked && step >= 1 && step <= max && step !== cur && cur !== LAST && step < LAST;
          return (
            <li key={label} className={`pill ${st}`}>
              {i ? <span className="pill-line" aria-hidden="true" /> : null}
              <button type="button" disabled={!can} aria-current={st === "cur" ? "step" : undefined} onClick={() => onGo(step)} title={label}>
                <span className="pill-n">{done && st !== "cur" ? <Icon id="check" /> : i + 1}</span>
                {st === "cur" ? <span className="pill-l">{label}</span> : <span className="sr">{label}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function DomainPrompt({ onStart, busy, error, initial = "" }: { onStart: (d: string) => void; busy: boolean; error: string; initial?: string }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState("");
  const site = useSiteCheck();
  return (
    <div className="au-page">
      <AuthShell>
          <h1 className="au-h">Which domain do you sell from?</h1>
          <p className="au-p">We read it to learn what you sell and who buys it. It never sends a cold email itself.</p>
          <form
            className="au-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const d = normDomain(v);
              if (!validDomain(d)) return setErr("That doesn't look like a domain. Try something like northwind.io");
              setErr("");
              void site.run(d).then((r) => {
                if (r?.status === "missing") setErr(r.message ?? "We can't find that domain.");
                else if (r?.status !== "unreadable") onStart(d);
              });
            }}
          >
            <div className="au-field">
              <label htmlFor="obDomain">Company domain</label>
              <div className="au-ctl">
                <span className="au-lead">
                  <Icon id="globe" />
                </span>
                <input id="obDomain" className={`au-input${err || error ? " bad" : ""}`} placeholder="yourcompany.com" value={v} onChange={(e) => (setV(e.target.value), setErr(""), site.clear())} autoFocus />
              </div>
            </div>
            <p className="au-err" role="alert">
              {err || error}
            </p>
            {site.result?.status === "unreadable" ? (
              <SiteNotice check={site.result} retrying={site.busy} onContinue={() => onStart(site.result!.domain)} onRetry={() => void site.run(site.result!.domain, true).then((r) => r?.status === "ok" && onStart(r.domain))} />
            ) : (
              <button className="au-btn" type="submit" disabled={busy || site.busy}>
                {busy || site.busy ? <span className="au-spin" /> : null}
                {site.busy ? "Checking your site" : "Analyze my domain"}
                {!busy && !site.busy ? <Icon id="arr" /> : null}
              </button>
            )}
          </form>
      </AuthShell>
    </div>
  );
}

export function Onboarding() {
  return (
    <DockProvider>
      <OnboardingFlow />
    </DockProvider>
  );
}

function OnboardingFlow() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const dock = useDock();
  const status = useSessionBootstrap();
  const authed = status === "authed";
  const { user, activeOrgId, organizations } = useAppSelector((s) => s.auth);
  const hasOrg = organizations.length > 0;
  const dispatch = useAppDispatch();
  const workspace = useCreateWorkspace();
  const paramDomain = (() => {
    const d = normDomain(params.get("domain") ?? "");
    return validDomain(d) ? d : "";
  })();
  const [mode, setMode] = useState<"up" | "in">(params.get("mode") === "in" ? "in" : "up");

  const { data: state, isLoading, isError, error, refetch } = useOnboardingQuery(undefined, { skip: !authed || !hasOrg });
  const { data: cat } = usePlansQuery();
  const [start, startState] = useOnboardingStartMutation();
  const [update] = useOnboardingUpdateMutation();
  const [skipCard, skipState] = useSkipCardMutation();

  const [step, setStep] = useState<number | null>(null);
  const [max, setMax] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [nextDisabled, setNextDisabled] = useState(false);
  const [awaiting, setAwaiting] = useState(params.get("card") === "1");
  const [startErr, setStartErr] = useState("");
  const payRef = useRef<PayHandle | null>(null);
  const [payReady, setPayReady] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const startedFor = useRef("");
  const [presenting, setPresenting] = useState(false);
  const [staleRun, setStaleRun] = useState<string | null>(null);
  const [view, setView] = useState<AnalysisView>("review");
  const [pvFocus, setPvFocus] = useState<PreviewFocus>("all");
  const [audience, setAudience] = useState<string | null>(null);
  const [resumePhase, setResumePhase] = useState<PhaseKey | null>(null);

  const o = state?.onboarding ?? null;
  const groupsKey = o ? o.groups.filter((g) => g.on).map((g) => `${g.id}:${g.keywords.join("|")}`).join(",") : "";
  const wantMarket = !!o?.analyzedAt && !!groupsKey && !presenting;
  const { data: market, isFetching: marketLoading } = useOnboardingMarketQuery(groupsKey, { skip: !wantMarket });
  const { data: credits, refetch: refetchCredits } = useCreditsQuery(undefined, { skip: !authed || !hasOrg || (step ?? 0) < 4, pollingInterval: awaiting ? 2500 : 0 });

  const liveRun = state?.analysisRun ?? null;
  const runPath = presenting && liveRun && liveRun.id !== staleRun ? `/analyses/${liveRun.id}/stream` : null;
  const { run, connection } = useRunStream(runPath);
  const funded = !!state?.funded;
  const cur = authed && hasOrg && o ? step ?? 1 : 0;
  const { data: volume } = useOnboardingVolumeQuery(undefined, { skip: !authed || !hasOrg || !o || cur < 2 });

  // Step 7 is reachable only through step 6: without a card (or credit) the campaign start can't be opened.
  const fundedRef = useRef(false);
  fundedRef.current = funded || !!o?.launchedAt;
  const go = useCallback((n: number) => {
    if (n >= LAST && !fundedRef.current) n = 4;
    setStep(n);
    setMax((m) => Math.max(m, n));
    window.scrollTo(0, 0);
    setTimeout(() => viewRef.current?.focus({ preventScroll: true }), 0);
  }, []);

  /** Keeps the running phase in the URL (?phase=audiences) without a navigation. */
  const setPhaseParam = useCallback((p: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (p) url.searchParams.set("phase", p);
    else url.searchParams.delete("phase");
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const onPresent = useCallback(
    (fresh: boolean) => {
      const fromUrl = params.get("phase");
      setResumePhase(!fresh && fromUrl && (PHASES as readonly string[]).includes(fromUrl) ? (fromUrl as PhaseKey) : null);
      setStaleRun(fresh ? (state?.analysisRun?.id ?? null) : null);
      dock.reset(LIVE_KEYS);
      setView("review");
      setPresenting(true);
    },
    [state?.analysisRun?.id, dock, params],
  );
  // A finished analysis carries straight on to the free overview; a failed or thin one stays here to be fixed.
  const runOk = run.done && !run.error && run.outcome !== "low-confidence";
  const onPresented = useCallback(() => {
    setPresenting(false);
    setPhaseParam(null);
    dock.settle(["business", "buyers", "market"]);
    if (runOk) go(2);
  }, [dock, setPhaseParam, runOk, go]);

  /** Starts setup over for another workspace: the step, the draft and the rail come from that workspace's setup. */
  const resetFlow = useCallback(() => {
    dock.reset(ALL_KEYS);
    setPresenting(false);
    setDraft(null);
    setStep(null);
    setMax(0);
  }, [dock]);

  /**
   * A domain from the home page or "Add a workspace". Each domain is its own workspace, so nothing that is already
   * set up or running is ever replaced:
   *   a workspace you already have for it   switch to it
   *   this workspace, with nothing done yet   use it for the new domain
   *   otherwise                             create a new workspace for the domain and set that one up
   */
  useEffect(() => {
    if (!authed || !state || !paramDomain || startedFor.current === paramDomain) return;
    if (o && o.domain === paramDomain) return;
    startedFor.current = paramDomain;
    const mine = organizations.find((x) => normDomain(x.primaryDomain ?? "") === paramDomain && x.id !== activeOrgId);
    if (mine) {
      void refreshSession(mine.id).then((sess) => {
        if (!sess) return;
        resetFlow();
        dispatch(sessionReceived(sess));
        dispatch(api.util.resetApiState());
        toast(`Switched to your ${paramDomain} workspace.`, "good");
      });
      return;
    }
    // A workspace with a card on file belongs to its domain, like one that is analysed or running.
    const untouched = !o || (!o.analyzedAt && !o.launchedAt && !o.preview?.length && !state.funded);
    if (!untouched) {
      const was = o?.domain;
      workspace
        .run(paramDomain)
        .then((org) => {
          resetFlow();
          toast(org.existing ? `Switched to your ${paramDomain} workspace.` : `New workspace for ${paramDomain}.${was ? ` ${was} stays as it is, in its own workspace.` : ""}`, "good");
        })
        .catch((e) => {
          setStartErr(errorMessage(e));
          toast(`Couldn't create a workspace for ${paramDomain}: ${errorMessage(e)}`, "bad");
        });
      return;
    }
    start({ domain: paramDomain })
      .unwrap()
      .then((fresh) => {
        // Work out the step from the new domain's setup, not the one still on screen.
        const s = initialStep(fresh);
        dock.reset(ALL_KEYS);
        setPresenting(false);
        setDraft(fresh.onboarding ? draftFrom(fresh) : null);
        setStep(s);
        setMax(s);
      })
      .catch((e) => {
        setStartErr(errorMessage(e));
        toast(`Couldn't start setup for ${paramDomain}: ${errorMessage(e)}`, "bad");
      });
  }, [authed, state, o, paramDomain, start, toast, dock, organizations, activeOrgId, workspace, resetFlow, dispatch]);

  useEffect(() => {
    if (!state?.onboarding) return;
    setDraft((d) => d ?? draftFrom(state));
    if (step === null) {
      const s = awaiting ? 4 : initialStep(state);
      setStep(s);
      setMax(s);
    }
  }, [state, step, user?.name, awaiting]);

  // Nothing saved yet: start from the recommendation, which the server keeps below the maximum.
  useEffect(() => {
    if (!draft || draft.set || !volume?.ready || volume.recommended === null) return;
    if (draft.emails !== volume.recommended) setDraft((d) => (d ? { ...d, emails: volume.recommended! } : d));
  }, [volume, draft]);

  // The card is saved in the page; the free credit lands when Stripe tells the server, usually within seconds. Until
  // then the page polls, and once it is in, the campaign starts.
  useEffect(() => {
    if (!awaiting) return;
    const t = setInterval(() => refetch(), 2500);
    return () => clearInterval(t);
  }, [awaiting, refetch]);
  useEffect(() => {
    if (!awaiting || !funded) return;
    setAwaiting(false);
    refetchCredits();
    void dock.dock("credits").then(() => go(LAST));
  }, [awaiting, funded, refetchCredits, dock, go]);

  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  });
  useEffect(() => {
    if (!awaiting) return;
    const tm = setTimeout(() => {
      setAwaiting(false);
      toastRef.current("This is taking longer than usual. Your card is saved; the free credit appears as soon as Stripe confirms it.", "info");
    }, 120_000);
    return () => clearTimeout(tm);
  }, [awaiting]);

  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d)), []);
  const registerPay = useCallback((h: PayHandle | null) => {
    payRef.current = h;
    setPayReady(!!h);
  }, []);
  const onSaved = useCallback(() => setAwaiting(true), []);

  if (status === "idle" || status === "loading") return <FullPageLoader />;

  const domain = o?.domain ?? paramDomain;
  const live = presenting && run.started;
  const DOCK_ON_NEXT: Record<number, string> = { 3: "volume", 4: "credits" };

  async function next() {
    if (!draft || !cat || step === null) return;
    setBusy(true);
    try {
      if (step === 1 || step === 2) {
        if (step === 1 && view === "review") await dock.dock("sequence");
        go(step + 1);
      } else if (step === 3) {
        await update({ emailsPerDay: draft.emails }).unwrap();
        await dock.dock("volume");
        go(4);
      } else if (step === 4) {
        if (funded) {
          await dock.dock("credits");
          go(LAST);
        } else if (payRef.current) await payRef.current();
      }
    } catch (e) {
      toast(errorMessage(e), "bad");
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (!authed)
    body = (
      <>
        <AuthCard mode={mode} onMode={setMode} domain={domain || undefined} next={`/onboarding${domain ? `?domain=${domain}` : ""}`} changeHref="/" onDone={() => undefined} />
        {domain ? (
          <p className="lv-signline">
            <ProgressRing value={0.08} />
            Ready to read <b>{domain}</b> the moment you&apos;re in
          </p>
        ) : null}
      </>
    );
  else if (!hasOrg) body = <DomainPrompt busy={workspace.isLoading} error={startErr} initial={paramDomain} onStart={(d) => workspace.run(d).catch((e) => setStartErr(errorMessage(e)))} />;
  else if (isError) body = <ErrorState error={error} onRetry={refetch} />;
  else if (isLoading || !state || !cat) body = <OnboardingSkeleton />;
  else if (!o) body = <DomainPrompt busy={startState.isLoading} error={startErr} initial={paramDomain} onStart={(d) => start({ domain: d }).unwrap().catch((e) => setStartErr(errorMessage(e)))} />;
  else if (!draft || step === null) body = <OnboardingSkeleton />;
  else {
    const common = { draft, cat, patch, domain };
    if (cur === 1)
      body =
        state.analysisStream === false ? (
          <AnalysisStep state={state} market={market} setNextDisabled={setNextDisabled} />
        ) : (
          <AnalysisFlow
            state={state}
            run={run}
            presenting={presenting}
            onPresent={onPresent}
            onPresented={onPresented}
            setNextDisabled={setNextDisabled}
            market={market}
            audience={audience}
            view={view}
            onView={setView}
            resumePhase={resumePhase}
            onPhase={setPhaseParam}
          />
        );
    else if (cur === 2) {
      body = (
        <PreviewStep
          state={state}
          cat={cat}
          market={market}
          marketLoading={marketLoading}
          emails={draft.emails}
          volume={volume}
          onEmails={(v) => patch({ emails: v, set: true })}
          onBack={() => go(1)}
          setNextDisabled={setNextDisabled}
          audience={audience}
          onAudience={setAudience}
          focus={pvFocus}
          onShowAll={() => {
            setPvFocus("all");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      );
    } else if (cur === 3)
      body = (
        <VolumeStep
          {...common}
          market={market}
          volume={volume}
        />
      );
    else if (cur === 4)
      body = (
        <CardStep
          {...common}
          credits={credits}
          funded={funded}
          orgId={activeOrgId ?? ""}
          awaiting={awaiting}
          register={registerPay}
          onSaved={onSaved}
          onBusy={setBusy}
          skipBusy={skipState.isLoading}
          onSkip={() =>
            skipCard()
              .unwrap()
              .then(() => router.push("/app"))
              .catch((e) => toast(errorMessage(e), "bad"))
          }
        />
      );
    else body = <LaunchStep state={state} draft={draft} market={market} />;
  }

  const isAuth = cur === 0;
  const ready = authed && !!o && !!draft && !!cat;
  const labels = ["", "See my free overview", "Choose emails a day", draft && volume?.ready ? `Continue with ${draft.emails.toLocaleString("en-US")} a day` : "Continue", funded ? "Start my campaign" : "Add card and start", ""];
  const disabled = busy || nextDisabled || (cur === 3 && !volume?.ready) || (cur === 4 && !funded && (!payReady || awaiting));
  const cta =
    ready && cur >= 1 && cur < LAST ? (
      <button className="btn btn-primary" type="button" disabled={disabled} onClick={next}>
        {busy || awaiting ? (
          <>
            <span className="spinner" />
            {awaiting ? "Confirming payment" : "Processing"}
          </>
        ) : (
          <>
            {labels[cur]}
            <Icon id="arr" className="arr" />
          </>
        )}
      </button>
    ) : ready && cur === LAST ? (
      <button className="btn btn-primary" type="button" onClick={() => router.push("/app")}>
        Go to your dashboard
        <Icon id="arr" className="arr" />
      </button>
    ) : null;

  const cards =
    ready && state && o
      ? railCards({ state, run, live, market, draft, max, docked: dock.phase, setupDone: !!o.launchedAt, email: user?.email ?? null })
      : [];
  // Cards only wait off the rail while they fly in from the analysis. After that every decision stays put.
  const hidden = new Set<string>(presenting ? LIVE_KEYS.filter((k) => dock.phase[k] !== "landed") : []);
  const active = new Set<string>(
    presenting ? [] : cur === 1 ? [view === "review" ? "sequence" : view] : cur === 2 ? (pvFocus === "all" ? ["market", "prospects", "confirmed"] : [{ market: "market", prospects: "prospects", audiences: "confirmed" }[pvFocus]]) : cards.filter((c) => c.step === cur).map((c) => c.key),
  );
  const log: RailLog | null =
    presenting && run.started && !run.done && !run.error
      ? {
          lines: run.logs,
          stepIndex: run.steps.findIndex((k) => run.stepState[k] === "running") + 1 || run.steps.filter((k) => run.stepState[k] === "done").length,
          stepCount: run.steps.length || 6,
          connection,
        }
      : null;
  const total = ready && draft && cat && state && cur >= 3 ? runningTotal(cur, draft, cat, state, volume?.stops ?? cat.volume.stops) : null;
  // The value bar appears once there is something worth buying: when the market numbers land.
  const valueReady = ready && cur >= 1 && cur < LAST && (presenting ? run.stepState.size === "done" : !!o?.analyzedAt && !!market);
  const showRail = ready && !isAuth;

  return (
    <div id="onboard" className={`lv-app${isAuth ? " is-auth" : ""}`} style={{ minHeight: "100vh" }}>
      {isAuth ? (
        <AuthHeader />
      ) : (
        <ValueBar cta={valueReady || cur === LAST ? cta : null} compact={!valueReady} exitLabel="Save and exit" onExit={() => router.push(authed ? "/app" : "/")} />
      )}
      <div className={`lv-shell${showRail ? "" : " no-rail"}`}>
        {showRail ? (
          <Rail
            cards={cards}
            hidden={hidden}
            active={active}
            onOpen={(n, key) => {
              if (presenting) return;
              // Every card opens its own view. Business, buyers and the sample sequence live in the analysis.
              // Market, sample prospects and the confirmed audiences each open their own part of the overview.
              const focusOf: Record<string, PreviewFocus> = { market: "market", prospects: "prospects", confirmed: "audiences" };
              if (focusOf[key] && max >= 2) {
                setPvFocus(focusOf[key]);
                if (cur !== 2) go(2);
                else window.scrollTo({ top: 0, behavior: "smooth" });
                return;
              }
              const inAnalysis = key === "business" || key === "sequence" || key === "buyers" || key === "market" || key === "prospects";
              if (inAnalysis) {
                setView(key === "business" ? "business" : key === "buyers" ? "buyers" : key === "sequence" ? "review" : "market");
                if (cur !== 1) go(1);
                return;
              }
              setPvFocus("all");
              if (n <= max && n !== cur) go(n);
            }}
            log={log}
            total={total}
            domain={domain}
            selected={audience}
            onSelect={(id) => {
              setAudience(id);
              if (id && cur > 2 && !presenting) go(2);
            }}
          />
        ) : null}
        <main className="lv-centre">
          {!isAuth && ready ? (
            <StepPills
              cur={cur}
              max={max}
              onGo={(n) => {
                setPvFocus("all");
                go(n);
              }}
              locked={awaiting}
              hasDomain={!!domain}
              canBack={cur > 1 && cur < LAST}
              onBack={() => {
                setPvFocus("all");
                go(cur - 1);
              }}
            />
          ) : null}
          <div className="ob-view" ref={viewRef} tabIndex={-1} key={`${cur}-${domain}`}>
            <div ref={DOCK_ON_NEXT[cur] ? dock.source(DOCK_ON_NEXT[cur]) : undefined}>{body}</div>
          </div>
          {!valueReady && cur !== LAST && cta && !isAuth && !presenting && !(cur === 1 && !o?.analyzedAt) ? <div className="lv-next">{cta}</div> : null}
        </main>
      </div>
      {ready && !isAuth && (cta || total) ? (
        <div className="lv-mbar">
          {total ? (
            <div className="due">
              <small>{total.label}</small>
              <b>{total.value}</b>
            </div>
          ) : (
            <span className="spacer" />
          )}
          {cta}
        </div>
      ) : null}
    </div>
  );
}

function OnboardingSkeleton() {
  return (
    <div style={{ display: "grid", gap: 16 }} aria-busy="true">
      <div className="an-sk w1" />
      <div className="an-sk w2" />
      <div className="an-sk w3" style={{ height: 220, borderRadius: 16 }} />
    </div>
  );
}
