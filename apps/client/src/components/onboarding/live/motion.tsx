"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { n0 } from "@/lib/format";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setReduced(q.matches);
    set();
    q.addEventListener?.("change", set);
    return () => q.removeEventListener?.("change", set);
  }, []);
  return reduced;
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const q = window.matchMedia("(max-width: 899px)");
    const set = () => setNarrow(q.matches);
    set();
    q.addEventListener?.("change", set);
    return () => q.removeEventListener?.("change", set);
  }, []);
  return narrow;
}

/** Items fade and rise 8px over 200ms. Stagger is 60ms, capped so a list of n finishes inside 1.2s. */
export function arrive(i: number, n = 1): { className: string; style: CSSProperties } {
  const step = Math.min(60, 1200 / Math.max(1, n));
  return { className: "lv-arrive", style: { ["--d" as string]: `${Math.round(i * step)}ms` } };
}

/** Reveals items one at a time. Returns how many are showing. Reduced motion shows them all at once. */
export function useReveal(total: number, stepMs: number, active = true): number {
  const reduced = useReducedMotion();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (reduced) {
      setN(total);
      return;
    }
    if (n >= total) return;
    const t = setTimeout(() => setN((x) => Math.min(total, x + 1)), n === 0 ? 0 : stepMs);
    return () => clearTimeout(t);
  }, [n, total, stepMs, active, reduced]);
  return Math.min(n, total);
}

/** The last three arriving rows sit at 70%, 50% and 30% opacity, then settle once filling ends. */
export function trail(i: number, shown: number, filling: boolean): string {
  if (!filling) return "";
  const d = shown - 1 - i;
  return d === 0 ? " t30" : d === 1 ? " t50" : d === 2 ? " t70" : "";
}

/** Rolls a number from its previous value to the new one over 600ms, in tabular figures. */
export function Counter({ value, className, stale = false, format = n0 }: { value: number | null | undefined; className?: string; stale?: boolean; format?: (n: number) => string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<number>(0);
  const from = useRef(0);
  useEffect(() => {
    if (value == null) return;
    if (reduced) {
      setShown(value);
      from.current = value;
      return;
    }
    const start = performance.now();
    const a = stale ? 0 : from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 600);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(a + (value - a) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced, stale]);
  return (
    <span className={`lv-num${stale ? " stale" : ""}${className ? ` ${className}` : ""}`} aria-busy={stale || undefined}>
      {value == null ? "n/a" : format(shown)}
    </span>
  );
}

/** Types at 40 characters a second with a caret. After 6 seconds the rest appears at once. */
export function Typewriter({ text, onDone, className, instant = false }: { text: string; onDone?: () => void; className?: string; instant?: boolean }) {
  const reduced = useReducedMotion();
  const now = instant || reduced;
  const [n, setN] = useState(now ? text.length : 0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (now) {
      setN(text.length);
      done.current?.();
      return;
    }
    setN(0);
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const ms = t - start;
      const k = ms >= 6000 ? text.length : Math.min(text.length, Math.floor((ms / 1000) * 40));
      setN(k);
      if (k < text.length) raf = requestAnimationFrame(tick);
      else done.current?.();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, now]);
  const typing = n < text.length;
  return (
    <span className={className}>
      <span aria-hidden={typing || undefined}>{text.slice(0, n)}</span>
      {typing ? <span className="lv-caret" aria-hidden="true" /> : null}
      {typing ? <span className="sr">{text}</span> : null}
    </span>
  );
}

/** A small determinate ring: reads as work in progress, not waiting. */
export function ProgressRing({ value, size = 16 }: { value: number; size?: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className="lv-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} className="lv-ring-bg" />
      <circle cx={size / 2} cy={size / 2} r={r} className="lv-ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.06, Math.min(1, value)))} />
    </svg>
  );
}

// ─── Dock to rail ──────────────────────────────────────────────────────────

type Phase = "landing" | "landed";

interface DockApi {
  phase: Record<string, Phase>;
  source: (key: string) => (el: HTMLElement | null) => void;
  target: (key: string) => (el: HTMLElement | null) => void;
  /**
   * Flies every centre panel registered under key into its rail card, then marks it landed. A card that has landed
   * already takes the panel in again (companies and people fold into the market card). onLaunch runs once the
   * panel has been lifted off the page, so the next panel can come in while this one is still flying.
   */
  dock: (key: string, onLaunch?: () => void) => Promise<void>;
  /** Marks cards as already docked without motion (after a reload, or when reopening a step). */
  settle: (keys: string[]) => void;
  /** Forgets cards so a new run can dock them again. */
  reset: (keys: string[]) => void;
}

const DockContext = createContext<DockApi | null>(null);

const noop = () => undefined;
/** Used outside the onboarding layout (tests, embedded steps): panels stay where they are. */
const STANDALONE: DockApi = { phase: {}, source: () => noop, target: () => noop, dock: async (_key, onLaunch) => onLaunch?.(), settle: noop, reset: noop };

export function useDock(): DockApi {
  return useContext(DockContext) ?? STANDALONE;
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export function DockProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Record<string, Phase>>({});
  const sources = useRef(new Map<string, Set<HTMLElement>>());
  const targets = useRef(new Map<string, HTMLElement>());
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const reduced = useReducedMotion();
  const narrow = useNarrow();

  const source = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      const set = sources.current.get(key) ?? new Set<HTMLElement>();
      if (el) set.add(el);
      else for (const x of set) if (!x.isConnected) set.delete(x);
      sources.current.set(key, set);
    },
    [],
  );
  const target = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      if (el) targets.current.set(key, el);
      else targets.current.delete(key);
    },
    [],
  );

  const dock = useCallback(
    async (key: string, onLaunch?: () => void) => {
      let launched = false;
      const launch = () => {
        if (launched) return;
        launched = true;
        onLaunch?.();
      };
      const was = phaseRef.current[key];
      if (was === "landing") return launch();
      if (!was) setPhase((p) => ({ ...p, [key]: "landing" }));
      await frame();
      await frame();
      const to = targets.current.get(key);
      const from = [...(sources.current.get(key) ?? [])].filter((el) => el.isConnected);
      const fly = !reduced && !narrow && to && from.length && typeof document !== "undefined" && typeof Element.prototype.animate === "function";
      if (fly) {
        const t = to.getBoundingClientRect();
        const flights = from.map((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return Promise.resolve();
            const ghost = el.cloneNode(true) as HTMLElement;
            ghost.removeAttribute("id");
            ghost.setAttribute("aria-hidden", "true");
            ghost.classList.add("lv-ghost");
            if (ghost.classList.contains("ph-panel")) ghost.classList.replace("ph-panel", "ph-panel-ghost");
            Object.assign(ghost.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: "0", zIndex: "60", pointerEvents: "none", transformOrigin: "top left" });
            document.body.appendChild(ghost);
            el.style.visibility = "hidden";
            // One uniform scale keeps the text in proportion; the ghost fades out as it reaches the card.
            const scale = Math.max(0.2, Math.min(0.5, t.width / r.width));
            const anim = ghost.animate(
              [
                { transform: "translate(0,0) scale(1)", opacity: 1, offset: 0 },
                { opacity: 1, offset: 0.35 },
                { transform: `translate(${t.left - r.left}px, ${t.top - r.top}px) scale(${scale})`, opacity: 0, offset: 1 },
              ],
              { duration: 520, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
            );
            return anim.finished.catch(() => undefined).then(() => ghost.remove());
          });
        launch();
        await Promise.all(flights);
      }
      launch();
      if (was !== "landed") setPhase((p) => ({ ...p, [key]: "landed" }));
    },
    [reduced, narrow],
  );

  const settle = useCallback((keys: string[]) => {
    setPhase((p) => {
      const missing = keys.filter((k) => p[k] !== "landed");
      if (!missing.length) return p;
      return { ...p, ...Object.fromEntries(missing.map((k) => [k, "landed" as Phase])) };
    });
  }, []);

  const reset = useCallback((keys: string[]) => {
    setPhase((p) => {
      if (!keys.some((k) => p[k])) return p;
      const n = { ...p };
      for (const k of keys) delete n[k];
      return n;
    });
  }, []);

  const value = useMemo(() => ({ phase, source, target, dock, settle, reset }), [phase, source, target, dock, settle, reset]);
  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

/** Docks a centre panel into the rail once its step is done and it has been visible long enough to read. */
export function useDockWhen(key: string, ready: boolean, dwellMs: number) {
  const dock = useDock();
  const fired = useRef(false);
  useEffect(() => {
    if (!ready || fired.current) return;
    const t = setTimeout(() => {
      fired.current = true;
      void dock.dock(key);
    }, dwellMs);
    return () => clearTimeout(t);
  }, [ready, dwellMs, key, dock]);
  return dock.phase[key] === "landed";
}

