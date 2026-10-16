"use client";

import type { ReactNode } from "react";
import { n0 } from "@/lib/format";
import { Spark } from "./charts";

/** Shared building blocks of the admin pool Graphs view. */

export type Tone = "good" | "warn" | "bad";

/** A rate to two decimals, trailing zeros dropped: 0.0193 is 1.93%, 0.015 is 1.5%. */
export const exact = (v: number) => `${Number((v * 100).toFixed(2))}%`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n0(n)} ${n === 1 ? one : many}`;

export function Verdict({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <p className={`pg-verdict ${tone}`}>
      <i />
      {children}
    </p>
  );
}

/** The one thing to know, above everything else, with the numbers that back it beside it. */
export function Hero({ tone, headline, children, anchors }: { tone: Tone; headline: string; children: ReactNode; anchors: ReactNode }) {
  return (
    <section className={`pg-hero ${tone}`}>
      <div className="pg-hero-say">
        <span className="pg-hero-tag">
          <i />
          {headline}
        </span>
        <p>{children}</p>
      </div>
      <div className="pg-hero-nums">{anchors}</div>
    </section>
  );
}

export function Section({ title, verdict, children }: { title: string; verdict: ReactNode; children: ReactNode }) {
  return (
    <section className="pg-sec">
      <header>
        <h2>{title}</h2>
        {verdict}
      </header>
      {children}
    </section>
  );
}

/**
 * A chart panel. `read` is the one plain sentence that says what the chart shows, so the page can be
 * understood by reading only those sentences.
 */
export function Panel({ title, hint, read, children, className = "" }: { title: string; hint?: ReactNode; read?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`panel glass pg-panel ${className}`}>
      <h3>
        {title}
        {hint ? <small>{hint}</small> : null}
      </h3>
      {read ? <p className="pg-read">{read}</p> : null}
      {children}
    </div>
  );
}

export function Kpi({ label, value, sub, tone, spark, sparkColor }: { label: string; value: ReactNode; sub: ReactNode; tone?: Tone; spark?: (number | null)[]; sparkColor?: string }) {
  return (
    <div className={`pg-kpi${tone ? ` ${tone}` : ""}`}>
      <small>{label}</small>
      <b>{value}</b>
      <span>{sub}</span>
      {spark ? <Spark values={spark} color={sparkColor} /> : null}
    </div>
  );
}

export function Figures({ items, cols }: { items: { label: string; value: ReactNode; tone?: Tone }[]; cols?: 3 | 4 }) {
  return (
    <div className={`pg-figs${cols ? ` c${cols}` : ""}`}>
      {items.map((f) => (
        <div key={f.label} className={f.tone ?? ""}>
          <small>{f.label}</small>
          <b>{f.value}</b>
        </div>
      ))}
    </div>
  );
}
