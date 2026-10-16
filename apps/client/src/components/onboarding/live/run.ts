"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store";
import { API_BASE, refreshSession } from "@/store/api";
import { sessionReceived } from "@/store/authSlice";

/** Events sent by /analyses/:id/stream and /orgs/:id/provisioning/stream. */
export type RunEvent = { seq?: number } & (
  | { type: "run.start"; analysisId?: string; runId?: string; domain?: string; steps: string[]; labels?: Record<string, string>; paid?: boolean }
  | { type: "step.start"; step: string; label: string }
  | { type: "step.log"; step: string; text: string; state: "running" | "done" }
  | { type: "item.found"; step: string; item: Item }
  | { type: "step.done"; step: string; summary: Record<string, unknown> }
  | { type: "run.done"; outcome?: string }
  | { type: "run.error"; step: string; code: string; message: string; recoverable: boolean }
  | { type: "heartbeat" }
);

export type Item =
  | { kind: "page"; url: string; words: number }
  | { kind: "signal"; label: string; value: string; source: string }
  | { kind: "fact"; text: string; source: string }
  | { kind: "audience"; id: string; name: string; icon: string; description?: string; why?: string; pains?: string[]; titles?: string[] }
  | { kind: "keyword"; audienceId: string; word: string; suggestion?: boolean }
  | { kind: "repair"; field: string; from: string | null; to: string | null; note: string }
  | { kind: "count"; audienceId: string; total: number | null; reachable: number | null; companiesInSample: number; companiesTotal: number | null }
  | { kind: "company"; audienceId: string; name: string; domain: string | null; country: string | null; employees: number | null; people?: number; titles?: string[] }
  | { kind: "person"; audienceId: string; firstName: string; lastNameMasked: string; title: string | null; company: string | null; country: string | null; hasEmail: boolean }
  | { kind: "draft"; step: number; subject: string; bodyChunk: string; tab?: string; day?: string; sender?: string };

export type StepState = "waiting" | "running" | "done";

export interface LogLine {
  step: string;
  text: string;
  state: "running" | "done";
}

export interface LiveAudience {
  id: string;
  name: string;
  icon: string;
  description: string;
  why: string;
  pains: string[];
  titles: string[];
  keywords: string[];
  suggestions: string[];
  count: Extract<Item, { kind: "count" }> | null;
}

export interface RunState {
  started: boolean;
  steps: string[];
  labels: Record<string, string>;
  stepState: Record<string, StepState>;
  doneAt: Record<string, number>;
  summaries: Record<string, Record<string, unknown>>;
  logs: LogLine[];
  pages: Extract<Item, { kind: "page" }>[];
  signals: Extract<Item, { kind: "signal" }>[];
  facts: Extract<Item, { kind: "fact" }>[];
  audiences: LiveAudience[];
  repairs: Extract<Item, { kind: "repair" }>[];
  companies: Extract<Item, { kind: "company" }>[];
  people: Extract<Item, { kind: "person" }>[];
  drafts: { step: number; subject: string; body: string; tab?: string; day?: string; sender?: string }[];
  done: boolean;
  outcome: string | null;
  error: { step: string; code: string; message: string; recoverable: boolean } | null;
  lastSeq: number;
}

export const emptyRun: RunState = {
  started: false,
  steps: [],
  labels: {},
  stepState: {},
  doneAt: {},
  summaries: {},
  logs: [],
  pages: [],
  signals: [],
  facts: [],
  audiences: [],
  repairs: [],
  companies: [],
  people: [],
  drafts: [],
  done: false,
  outcome: null,
  error: null,
  lastSeq: 0,
};

export function runReducer(s: RunState, e: RunEvent | { type: "reset" }): RunState {
  if (e.type === "reset") return emptyRun;
  if (e.type === "heartbeat") return s;
  if (e.seq != null && e.seq <= s.lastSeq) return s;
  const n: RunState = { ...s, lastSeq: e.seq ?? s.lastSeq };
  switch (e.type) {
    case "run.start":
      return { ...n, started: true, steps: e.steps, labels: { ...n.labels, ...(e.labels ?? {}) }, stepState: Object.fromEntries(e.steps.map((k) => [k, "waiting" as StepState])) };
    case "step.start":
      return { ...n, labels: { ...n.labels, [e.step]: e.label }, stepState: { ...n.stepState, [e.step]: "running" } };
    case "step.log": {
      const i = n.logs.findIndex((l) => l.step === e.step && l.text === e.text && l.state === "running");
      if (e.state === "done" && i >= 0) return { ...n, logs: n.logs.map((l, j) => (j === i ? { ...l, state: "done" } : l)) };
      return { ...n, logs: [...n.logs, { step: e.step, text: e.text, state: e.state }] };
    }
    case "step.done":
      return { ...n, stepState: { ...n.stepState, [e.step]: "done" }, doneAt: { ...n.doneAt, [e.step]: Date.now() }, summaries: { ...n.summaries, [e.step]: e.summary } };
    case "run.done":
      return { ...n, done: true, outcome: e.outcome ?? "ok" };
    case "run.error":
      return { ...n, error: { step: e.step, code: e.code, message: e.message, recoverable: e.recoverable } };
    case "item.found":
      return addItem(n, e.item);
  }
  return n;
}

function addItem(n: RunState, it: Item): RunState {
  switch (it.kind) {
    case "page":
      return { ...n, pages: [...n.pages, it] };
    case "signal":
      return { ...n, signals: [...n.signals, it] };
    case "fact":
      return { ...n, facts: [...n.facts, it] };
    case "audience":
      return { ...n, audiences: [...n.audiences, { id: it.id, name: it.name, icon: it.icon, description: it.description ?? "", why: it.why ?? "", pains: it.pains ?? [], titles: it.titles ?? [], keywords: [], suggestions: [], count: null }] };
    case "keyword":
      return {
        ...n,
        audiences: n.audiences.map((a) => (a.id !== it.audienceId ? a : it.suggestion ? { ...a, suggestions: [...a.suggestions, it.word] } : { ...a, keywords: [...a.keywords, it.word] })),
      };
    case "repair":
      return { ...n, repairs: [...n.repairs, it] };
    case "count":
      return { ...n, audiences: n.audiences.map((a) => (a.id === it.audienceId ? { ...a, count: it } : a)) };
    case "company":
      return { ...n, companies: [...n.companies, it] };
    case "person":
      return { ...n, people: [...n.people, it] };
    case "draft":
      return { ...n, drafts: [...n.drafts.filter((d) => d.step !== it.step), { step: it.step, subject: it.subject, body: it.bodyChunk, tab: it.tab, day: it.day, sender: it.sender }].sort((a, b) => a.step - b.step) };
  }
}

export type Connection = "idle" | "connecting" | "live" | "reconnecting" | "closed";

/** Splits a Server-Sent Events buffer into complete messages. */
export function parseSse(buffer: string): { events: RunEvent[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events: RunEvent[] = [];
  for (const block of parts) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as RunEvent);
    } catch {
      /* ignore a malformed block */
    }
  }
  return { events, rest };
}

/**
 * Follows a run stream. Uses fetch so the auth header goes with it, replays from the last
 * sequence number after a drop, and stops once the run has finished.
 */
export function useRunStream(path: string | null): { run: RunState; connection: Connection } {
  const [run, dispatch] = useReducer(runReducer, emptyRun);
  const [connection, setConnection] = useState<Connection>("idle");
  const token = useAppSelector((s) => s.auth.token);
  const orgId = useAppSelector((s) => s.auth.activeOrgId);
  const appDispatch = useAppDispatch();
  const auth = useRef({ token, orgId });
  auth.current = { token, orgId };
  const last = useRef(0);
  const finished = useRef(false);

  useEffect(() => {
    dispatch({ type: "reset" });
    last.current = 0;
    finished.current = false;
    if (!path) {
      setConnection("idle");
      return;
    }
    const stop = new AbortController();
    let attempt = 0;

    const open = async (): Promise<void> => {
      setConnection(attempt ? "reconnecting" : "connecting");
      const url = `${API_BASE}${path}${path.includes("?") ? "&" : "?"}from=${last.current}`;
      const headers = (): HeadersInit => ({
        accept: "text/event-stream",
        ...(auth.current.token ? { authorization: `Bearer ${auth.current.token}` } : {}),
        ...(auth.current.orgId ? { "x-organization-id": auth.current.orgId } : {}),
      });
      let res = await fetch(url, { headers: headers(), credentials: "include", signal: stop.signal, cache: "no-store" });
      if (res.status === 401) {
        const session = await refreshSession(auth.current.orgId);
        if (!session) throw new Error("signed out");
        appDispatch(sessionReceived(session));
        auth.current = { token: session.accessToken, orgId: auth.current.orgId };
        res = await fetch(url, { headers: headers(), credentials: "include", signal: stop.signal, cache: "no-store" });
      }
      if (!res.ok || !res.body) throw Object.assign(new Error(`stream ${res.status}`), { status: res.status });
      setConnection("live");
      attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const e of parsed.events) {
          if (e.seq != null) last.current = Math.max(last.current, e.seq);
          if (e.type === "run.done" || e.type === "run.error") finished.current = true;
          dispatch(e);
        }
      }
    };

    const loop = async () => {
      while (!stop.signal.aborted && !finished.current) {
        try {
          await open();
          if (finished.current) break;
        } catch (err) {
          if (stop.signal.aborted) return;
          const status = (err as { status?: number }).status;
          if (status === 404 || status === 403 || (err as Error).message === "signed out") {
            setConnection("closed");
            return;
          }
        }
        if (stop.signal.aborted || finished.current) break;
        attempt++;
        setConnection("reconnecting");
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** Math.min(attempt, 4))));
      }
      if (!stop.signal.aborted) setConnection("closed");
    };
    void loop();
    return () => stop.abort();
  }, [path, appDispatch]);

  return { run, connection };
}
