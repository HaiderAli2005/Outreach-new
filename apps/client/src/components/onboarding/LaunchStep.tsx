"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/primitives";
import { errorMessage, useCockpitQuery, useFirstRunMutation, useImportContactsMutation, useLaunchMutation, useOnboardingQuery, usePlansQuery, type LaunchResult } from "@/store/api";
import Link from "next/link";
import type { FirstRunReason, MarketView, OnboardingState } from "@/lib/types";
import { n0 } from "@/lib/format";
import type { Draft } from "./SetupSteps";

import { useDock } from "./live/motion";

/** Why the first search stopped, and what fixes it. */
const STOPPED: Record<FirstRunReason, string> = {
  "apollo-not-configured": "Finding people is not connected on this server: the Apollo key is missing. Add it, then try again.",
  "sourcing-off": "Finding new people is turned off in Settings. Turn it on, or upload your own list.",
  "no-active-campaign": "The campaign is paused. Resume it, then try again.",
  "out-of-credits": "Your balance cannot cover any new people yet. Add credits, then try again.",
  "nobody-found": "No new people matched your audiences. Widen them in Setup, Targeting, then try again.",
  error: "Finding stopped on an error. Try again.",
};

function CsvCard({ campaignId, verifying }: { campaignId: string | null; verifying: boolean }) {
  const [file, setFile] = useState<{ name: string; rows: number; hasEmail: boolean; text: string } | null>(null);
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [run, { isLoading }] = useImportContactsMutation();

  const read = async (f: File | undefined) => {
    if (!f) return;
    setErr("");
    setResult(null);
    if (f.size > 4_400_000) return setErr("That file is too large. Split it into smaller files.");
    const text = await f.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    setFile({ name: f.name, rows: Math.max(0, lines.length - 1), hasEmail: /e-?mail/i.test(lines[0] ?? ""), text });
  };

  return (
    <section className="pv-card lp-csv">
      <div className="pv-h">
        <div>
          <h2>
            Add your own contacts <span className="fs-tag">Optional</span>
          </h2>
          <p>Upload a CSV and we&apos;ll add these people to the campaign alongside the audience we found.</p>
        </div>
      </div>
      {result ? (
        <div className="ok-line g">
          <Icon id="check" />
          <span>{result}</span>
        </div>
      ) : file ? (
        <>
          <div className={`csv-file${file.hasEmail ? "" : " bad"}`}>
            <span className="csv-ic">
              <Icon id={file.hasEmail ? "check" : "alert"} />
            </span>
            <div>
              <b>{file.name}</b>
              <span>{file.hasEmail ? `${n0(file.rows)} contacts${verifying ? " · we check every address before sending" : ""}` : "We couldn't find an email column. Add a column named “email” and upload again."}</span>
            </div>
            <button type="button" className="btn btn-text btn-sm" onClick={() => setFile(null)}>
              Remove
            </button>
          </div>
          {file.hasEmail ? (
            <Button
              variant="ghost"
              size="sm"
              style={{ marginTop: 12 }}
              loading={isLoading}
              disabled={!campaignId}
              onClick={() =>
                run({ text: file.text, campaignId: campaignId ?? undefined })
                  .unwrap()
                  .then((r) => (setResult(r.message), setFile(null)))
                  .catch((e) => setErr(errorMessage(e)))
              }
            >
              Add to the campaign
            </Button>
          ) : null}
        </>
      ) : (
        <label
          className={`drop lp-drop${over ? " over" : ""}`}
          htmlFor="csvIn"
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void read(e.dataTransfer.files[0]);
          }}
        >
          <input type="file" id="csvIn" accept=".csv,text/csv" className="sr" onChange={(e) => void read(e.target.files?.[0])} />
          <Icon id="upload" />
          <span className="lp-drop-t">
            <b>Choose a CSV file</b>
            <small>or drop it here · needs an email column</small>
          </span>
          <span className="btn btn-ghost btn-sm">Choose file</span>
        </label>
      )}
      {err ? (
        <p className="au-err" role="alert" style={{ marginTop: 10 }}>
          {err}
        </p>
      ) : null}
    </section>
  );
}

export function LaunchStep({ state, draft, market }: { state: OnboardingState; draft: Draft; market: MarketView | undefined }) {
  const dock = useDock();
  const o = state.onboarding!;
  const [launch, { isLoading, error }] = useLaunchMutation();
  const [result, setResult] = useState<LaunchResult | null>(null);
  const started = useRef(false);
  const launched = !!(result || o.launchedAt);

  useEffect(() => {
    if (started.current || !state.funded || o.launchedAt) return;
    started.current = true;
    launch()
      .unwrap()
      .then(setResult)
      .catch(() => undefined);
  }, [state.funded, o.launchedAt, launch]);

  const c = state.credits;
  const { data: cat } = usePlansQuery();
  const stop = cat?.volume.stops.find((x) => x.emails === draft.emails) ?? null;
  const [retryRun, { isLoading: retrying }] = useFirstRunMutation();
  // While the first search runs, the page follows it every few seconds; once it has finished it stops asking.
  const live = useOnboardingQuery(undefined, { pollingInterval: launched && (!state.firstRun || state.firstRun.state === "running" || state.firstRun.state === "idle" || (state.firstRun.state === "done" && !state.firstRun.written)) ? 3000 : 0 });
  const f = (live.data ?? state).firstRun ?? null;
  // Workspaces launched before the first run existed start one the first time this page opens.
  const kicked = useRef(false);
  useEffect(() => {
    if (!launched || kicked.current || f?.state !== "idle") return;
    kicked.current = true;
    void retryRun().unwrap().catch(() => undefined);
  }, [launched, f?.state, retryRun]);
  const retry = (
    <Button size="sm" icon="rotate" loading={retrying} onClick={() => void retryRun().unwrap().catch(() => undefined)}>
      Try again
    </Button>
  );
  const { data: cockpit } = useCockpitQuery(undefined, { skip: !launched, pollingInterval: launched ? 5000 : 0, skipPollingIfUnfocused: true });
  // One status for the whole page. "Live" only once emails can really go out: after approval, or with no approval needed.
  type Phase = "card" | "starting" | "paused" | "finding" | "ready" | "live" | "sent" | "stopped";
  const phase: Phase = !state.funded
    ? "card"
    : !launched
      ? "starting"
      : cockpit && !cockpit.engine.on
        ? "paused"
        : cockpit?.milestones.sent
          ? "sent"
          : f?.state === "failed"
            ? cockpit?.milestones.contacts
              ? "live"
              : "stopped"
            : f?.approved
              ? f.written || f.state === "done"
                ? "live"
                : "finding"
              : f?.written
                ? "ready"
                : "finding";
  const HEAD: Record<Phase, { pill: string; tone: "warm" | "run" | "you" | "go" | "bad"; title: string; sub: string }> = {
    card: { pill: "Waiting for your card", tone: "warm", title: "Add your card to start", sub: "Add a card to unlock your free credit. Nothing is charged, and your campaign starts straight after." },
    starting: { pill: "Starting", tone: "run", title: "Starting your campaign", sub: "Saving your audiences, sequence and budget." },
    paused: { pill: "Needs you", tone: "you", title: "Autopilot is off", sub: "Nothing is found or sent until you turn it on in Settings." },
    sent: { pill: "Live", tone: "go", title: "Your first emails are out", sub: "Your dashboard shows when each next email goes out, and every reply." },
    finding: {
      pill: "Preparing",
      tone: "run",
      title: "Finding your first people",
      sub: f?.needsApproval
        ? `This takes a few minutes. You can follow it on your dashboard, and we email you when your first ${f.approveCount} people are ready to approve.`
        : "This takes a few minutes. You can follow it on your dashboard, and sending starts by itself once they are ready.",
    },
    ready: { pill: "Needs you", tone: "you", title: `Your first ${f?.approveCount ?? 20} people are ready`, sub: "Check the people and their emails, then approve. Nothing is sent before you do." },
    live: { pill: "Live", tone: "go", title: "Your campaign is live", sub: `First emails go out from ${f?.windowStart ?? "09:00"} in each prospect's own morning. Your dashboard shows the exact time of each one, and every reply.` },
    stopped: {
      pill: "Needs attention",
      tone: "bad",
      title: "We couldn't find your first people",
      sub: `Your campaign is saved. ${f?.reason === "error" && f.message ? `Finding stopped: ${f.message}` : STOPPED[f?.reason ?? "error"]}`,
    },
  };
  const h = HEAD[phase];
  const head = [h.title, h.sub];
  const pill = (
    <span className={`lp-pill ${h.tone}`}>
      {h.tone === "run" ? <span className="spin" /> : <span className="dot" />}
      {h.pill}
    </span>
  );
  const headAction =
    phase === "stopped" ? (
      <span style={{ display: "inline-flex", marginTop: 18 }}>{retry}</span>
    ) : phase === "paused" ? (
      <Link className="btn btn-primary" href="/app/settings?tab=autopilot" style={{ marginTop: 18 }}>
        Turn it on in Settings
      </Link>
    ) : phase === "ready" ? (
      <Link className="btn btn-primary" href="/app/approve" style={{ marginTop: 18 }}>
        Review and approve
      </Link>
    ) : null;
  const missing = result?.missing ?? [];

  return (
    <>
      <header className="an-head lp-head">
        {pill}
        <h1 className="an-h">{head[0]}</h1>
        <p className="an-p">{head[1]}</p>
        {headAction}
      </header>
      {error ? (
        <div className="banner bad" role="alert" style={{ marginTop: 16 }}>
          <span>{errorMessage(error) || "The campaign couldn't start yet."}</span>
          <Button size="sm" icon="rotate" loading={isLoading} onClick={() => launch().unwrap().then(setResult).catch(() => undefined)}>
            Try again
          </Button>
        </div>
      ) : null}
      {missing.length ? (
        <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
          {missing.map((m) => (
            <div className="banner" key={m}>
              {m}
            </div>
          ))}
        </div>
      ) : null}
      <div className="lp-stack">
        <section className="pv-card lp-camp" ref={dock.source("setup")}>
          <div className="pv-h">
            <div>
              <h2>{o.brand} · first campaign</h2>
              <p>4-email sequence to {market?.people != null ? `${n0(market.people)} matching people` : "your buyer groups"}</p>
            </div>
          </div>
          <div className="lp-stats">
            <div>
              <small>Emails a day</small>
              <b>{n0(draft.emails)}</b>
              <span>{stop ? `${stop.perDay} a day · ${n0(stop.people)} new people a day` : "within your daily budget"}</span>
            </div>
            <div>
              <small>Balance</small>
              <b>{c.balance}</b>
              <span>about {n0(c.emailsLeft)} emails</span>
            </div>
            <div>
              <small>Price</small>
              <b>{c.pricePerEmail}</b>
              <span>an email, every email</span>
            </div>
          </div>
        </section>
        <CsvCard campaignId={result?.campaignId ?? state.campaign?.id ?? null} verifying={!!(live.data ?? state).verifying} />

        <p className="lp-back">Your balance, card and sending health live under Credits in the app.</p>
      </div>
    </>
  );
}
