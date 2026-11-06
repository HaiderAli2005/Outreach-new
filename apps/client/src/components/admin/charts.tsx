"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { n0 } from "@/lib/format";

/** Small SVG charts for the admin console. No chart library: every shape is drawn here so it matches the theme. */

export const TONE = {
  /** Ordinary data: one quiet ink, so colour is left for what means something. */
  data: "var(--data)",
  /** The series that matters (the reference uses its accent): Aperture gold, tuned per theme. */
  accent: "var(--chart-1)",
  /** The second series: a soft glacier blue, never grey, so volume reads calm next to the result. */
  blue: "var(--chart-2)",
  gold: "var(--gold)",
  good: "var(--good)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  ink2: "var(--ink-2)",
  ink3: "var(--ink-3)",
  ink4: "var(--ink-4)",
} as const;

/** Maturity ramp, light to dark. Validated for colour-blind separation and contrast on the app surface. */
export const RAMP = { m1: "var(--ramp-1, #F3E2C6)", m2: "var(--gold)", m3: "#8A6A3C" } as const;

type Fmt = (v: number) => string;

function useWidth(fallback = 560) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => el.clientWidth && setW(el.clientWidth);
    set();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/**
 * A round axis maximum at or above v. For counts, `parts` is how many gridline gaps the axis has, so every
 * gridline lands on a whole number.
 */
export function niceMax(v: number, parts?: number): number {
  if (!(v > 0)) return parts ?? 1;
  if (parts && v <= parts * 5) return Math.max(parts, Math.ceil(v / parts) * parts);
  const p = 10 ** Math.floor(Math.log10(v));
  return STEPS.find((s) => s * p >= v - 1e-9)! * p;
}

/** Pushes labels apart so none sit on top of another, then keeps them inside the plot. */
function spread(items: { y: number }[], min: number, lo: number, hi: number) {
  const order = [...items].sort((a, b) => a.y - b.y);
  for (const it of order) it.y = Math.max(lo, Math.min(hi, it.y));
  for (let i = 1; i < order.length; i++) if (order[i].y - order[i - 1].y < min) order[i].y = order[i - 1].y + min;
  const over = order.length ? order[order.length - 1].y - hi : 0;
  if (over > 0) for (let i = order.length - 1; i >= 0; i--) order[i].y = Math.min(order[i].y - over, i ? order[i].y : hi);
  return items;
}

/** A column with a rounded top and a square foot, so every bar sits flat on the baseline. */
function column(x: number, y: number, w: number, h: number, r = 4) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x.toFixed(1)},${(y + h).toFixed(1)}V${(y + rr).toFixed(1)}a${rr},${rr} 0 0 1 ${rr},${-rr}h${(w - 2 * rr).toFixed(1)}a${rr},${rr} 0 0 1 ${rr},${rr}V${(y + h).toFixed(1)}Z`;
}

/**
 * A marker sitting at either end of a rail would hang its label outside the card, so the label is pinned
 * inside instead of centred on the tick.
 */
const edge = (atPct: number) => (atPct < 12 ? "at-start" : atPct > 88 ? "at-end" : "");

function Tip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 90), width - 90);
  return (
    <div className="ch-tip" style={{ left }}>
      {children}
    </div>
  );
}

export function Legend({
  items,
}: {
  items: {
    label: string;
    color: string;
    value?: ReactNode;
    dashed?: boolean;
  }[];
}) {
  return (
    <div className="ch-legend">
      {items.map((i) => (
        <span key={i.label}>
          <i
            className={i.dashed ? "dash" : ""}
            style={{
              background: i.dashed ? undefined : i.color,
              borderColor: i.color,
            }}
          />
          {i.label}
          {i.value !== undefined ? <b>{i.value}</b> : null}
        </span>
      ))}
    </div>
  );
}

export interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  area?: boolean;
  dashed?: boolean;
  /** Draws flat steps between points, for counts that change in whole numbers. */
  step?: boolean;
  /**
   * Draws the series as a neutral annotated reference line rather than a second data colour, and writes its
   * name and latest value in the right margin. One chart, one data colour.
   */
  ref?: boolean;
  /** Draws soft rounded columns instead of a line: right for sparse daily counts, where a line would zigzag. */
  bars?: boolean;
  /** Draws a smooth curve through the points (it never overshoots, so it never invents a dip or a peak). */
  smooth?: boolean;
}

/**
 * Monotone cubic curve through points (Fritsch–Carlson). Smooth like a spline, but it never overshoots between two
 * values, so a count of 0 then 4 never dips below 0.
 */
export function monotone(pts: [number, number][]): string {
  const n = pts.length;
  if (n < 2) return n ? `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}` : "";
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1));
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
  t.push(m[n - 2]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + h * t[i]).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - h * t[i + 1]).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

const PAD = { l: 46, r: 14, t: 14, b: 28 };
const REF_INK = ["var(--ink-3)", "var(--ink-4)"];
const REF_DASH = ["5 5", "1.5 5"];

/** Lines over time, with an optional shaded area, annotated reference lines and a hover readout. */
export function LineChart({
  labels,
  series,
  height = 220,
  format = n0,
  thresholds = [],
  max,
  empty,
  counts,
  endLabel,
  endLabels,
  marks = [],
}: {
  labels: string[];
  series: Series[];
  counts?: boolean;
  /** Vertical reference lines at a point on the x axis. */
  marks?: { index: number; label: string; color: string }[];
  /** Writes the latest value of the first series in the right margin. */
  endLabel?: boolean;
  /** Writes every data series' name and latest value in the right margin, so colour is never the only cue. */
  endLabels?: boolean;
  height?: number;
  format?: Fmt;
  thresholds?: { value: number; label: string; color: string }[];
  max?: number;
  empty?: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const id = useId().replace(/:/g, "");
  const n = labels.length;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const yMax = max ?? niceMax(Math.max(0, ...all, ...thresholds.map((t) => t.value * 1.15)), counts ? 4 : undefined);
  const refs = series.filter((s) => s.ref);
  const data = series.filter((s) => !s.ref);
  const margin = refs.length || thresholds.length || endLabel || endLabels ? Math.min(132, Math.max(96, width * 0.17)) : PAD.r;
  const iw = Math.max(10, width - PAD.l - margin);
  const ih = height - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (Math.min(v, yMax) / yMax) * ih;
  const nothing = !all.some((v) => v > 0);

  // Runs of consecutive points, split where a value is missing.
  const runs = (vals: (number | null)[]) => {
    const out: [number, number][][] = [];
    let cur: [number, number][] = [];
    vals.forEach((v, i) => {
      if (v === null) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push([x(i), y(v)]);
    });
    if (cur.length) out.push(cur);
    return out;
  };
  const smoothPath = (vals: (number | null)[]) => runs(vals).map(monotone).join("");
  const smoothArea = (vals: (number | null)[]) =>
    runs(vals)
      .filter((r) => r.length > 1)
      .map((r) => `${monotone(r)}L${r[r.length - 1][0].toFixed(1)},${y(0).toFixed(1)}L${r[0][0].toFixed(1)},${y(0).toFixed(1)}Z`)
      .join("");
  const path = (vals: (number | null)[], step?: boolean) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) return void (pen = false);
      d += pen && step ? `H${x(i).toFixed(1)}V${y(v).toFixed(1)}` : `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const area = (vals: (number | null)[], step?: boolean) => {
    const pts = vals.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
    if (pts.length < 2) return "";
    const top = pts.map(([i, v], k) => (step && k ? `H${x(i).toFixed(1)}V${y(v).toFixed(1)}` : `L${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
    return `M${x(pts[0][0])},${y(0)}` + top + `L${x(pts[pts.length - 1][0])},${y(0)}Z`;
  };
  const lastOf = (s: Series) => {
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] !== null) return { i, v: s.values[i]! };
    return null;
  };

  // Everything written in the right margin shares one column, so nothing ever lands on anything else.
  const notes: { key: string; y: number; text: string; color: string; dot?: { x: number; y: number; color: string } }[] = [];
  if (margin > PAD.r) {
    thresholds.forEach((t) => notes.push({ key: `t-${t.label}`, y: y(t.value) + 4, text: t.label, color: t.color }));
    refs.forEach((s, k) => {
      const last = lastOf(s);
      if (last) notes.push({ key: `r-${s.key}`, y: y(last.v) + 4, text: `${s.label} ${format(last.v)}`, color: REF_INK[k % REF_INK.length] });
    });
    if (endLabels || endLabel) {
      (endLabels ? data : data.slice(0, 1)).forEach((s) => {
        const last = lastOf(s);
        if (!last) return;
        // With more than one line, each end label carries its name so the colour is never the only cue.
        const text = endLabels && data.length > 1 ? `${s.label} ${format(last.v)}` : format(last.v);
        notes.push({ key: `e-${s.key}`, y: y(last.v) + 4, text, color: s.color, dot: { x: x(last.i), y: y(last.v), color: s.color } });
      });
    }
    spread(notes, 15, PAD.t + 8, PAD.t + ih);
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const xTicks = n > 1 ? [...new Set(iw < 460 ? [0, Math.round((n - 1) / 2), n - 1] : [0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1])] : [0];

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div className="ch" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={series.map((s) => s.label).join(", ")}>
        <defs>
          {data
            .filter((s) => s.area)
            .map((s) => (
              <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" style={{ stopColor: s.color, stopOpacity: 0.16 }} />
                <stop offset="100%" style={{ stopColor: s.color, stopOpacity: 0 }} />
              </linearGradient>
            ))}
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={width - margin} y1={y(t)} y2={y(t)} className="ch-grid" />
            <text x={PAD.l - 8} y={y(t) + 4} className="ch-axis" textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        {xTicks.map((i) => (
          <text key={i} x={x(i)} y={height - 8} className="ch-axis" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
            {labels[i]}
          </text>
        ))}
        {thresholds.map((t) => (
          <line key={t.label} x1={PAD.l} x2={width - margin} y1={y(t.value)} y2={y(t.value)} className="ch-thresh" style={{ stroke: t.color }} />
        ))}
        {marks.map((m) => (
          <g key={m.label}>
            <line x1={x(m.index)} x2={x(m.index)} y1={PAD.t} y2={PAD.t + ih} className="ch-thresh" style={{ stroke: m.color }} />
            <text x={x(m.index) - 6} y={PAD.t + 10} className="ch-axis" textAnchor="end" style={{ fill: m.color }}>
              {m.label}
            </text>
          </g>
        ))}
        {refs.map((s, k) => (
          <path key={s.key} d={path(s.values, s.step)} className="ch-ref" style={{ stroke: REF_INK[k % REF_INK.length], strokeDasharray: REF_DASH[k % REF_DASH.length] }} />
        ))}
        {/* Columns first, so lines read on top of them */}
        {(() => {
          // Several bar series sit side by side in one group per day.
          const barSeries = data.filter((s) => s.bars);
          const group = Math.max(4, Math.min(28, (iw / Math.max(1, n)) * 0.7));
          const gap = barSeries.length > 1 ? Math.min(3, group * 0.12) : 0;
          const bw = Math.max(3, (group - gap * (barSeries.length - 1)) / Math.max(1, barSeries.length));
          return barSeries.map((s, k) => {
            const off = -group / 2 + k * (bw + gap);
            return (
              <g key={s.key}>
                {s.values.map((v, i) =>
                  v ? <path key={i} d={column(x(i) + off, y(v), bw, y(0) - y(v), Math.min(4, bw / 2))} className="ch-col" style={{ fill: s.color, opacity: hover === null || hover === i ? 0.9 : 0.45, animationDelay: `${Math.min(i, 30) * 18}ms` }} /> : null,
                )}
              </g>
            );
          });
        })()}
        {data.filter((s) => !s.bars).map((s) => (
          <g key={s.key}>
            {s.area ? <path d={s.smooth ? smoothArea(s.values) : area(s.values, s.step)} className="ch-area" style={{ fill: `url(#${id}-${s.key})` }} /> : null}
            {/* Solid lines draw themselves in; pathLength 1 lets one dash cover any line. */}
            <path d={s.smooth ? smoothPath(s.values) : path(s.values, s.step)} className={`ch-line${s.dashed ? " dashed" : " draw"}`} pathLength={s.dashed ? undefined : 1} style={{ stroke: s.color }} />
          </g>
        ))}
        <line x1={PAD.l} x2={width - margin} y1={y(0)} y2={y(0)} className="ch-base" />
        {/* A dot on every series latest value, unless the margin note already draws one. */}
        {hover === null
          ? data.filter((s) => !s.bars).map((s) => {
              const last = lastOf(s);
              if (!last || notes.some((t) => t.key === `e-${s.key}` && t.dot)) return null;
              return <circle key={`end-${s.key}`} cx={x(last.i)} cy={y(last.v)} r={4} className="ch-dot ch-end" style={{ fill: s.color }} />;
            })
          : null}
        {hover === null
          ? notes.map((t) => (
              <g key={t.key}>
                {t.dot ? <circle cx={t.dot.x} cy={t.dot.y} r={4.5} className="ch-dot" style={{ fill: t.dot.color }} /> : null}
                <text x={width - margin + 9} y={t.y} className={t.dot ? "ch-gut val" : "ch-gut"} style={{ fill: t.dot ? undefined : t.color }}>
                  {t.text}
                </text>
              </g>
            ))
          : null}
        {hover !== null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} className="ch-guide" />
            {series.map((s) =>
              !s.bars && s.values[hover] !== null && s.values[hover] !== undefined ? (
                <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={4} className="ch-dot" style={{ fill: s.ref ? REF_INK[refs.indexOf(s) % REF_INK.length] : s.color, opacity: s.ref ? 0.9 : 1 }} />
              ) : null,
            )}
          </g>
        ) : null}
        <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover !== null ? (
        <Tip x={x(hover)} width={width}>
          <small>{labels[hover]}</small>
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.ref ? REF_INK[refs.indexOf(s) % REF_INK.length] : s.color }} />
              {s.label}
              <b>{s.values[hover] === null ? "no data" : format(s.values[hover]!)}</b>
            </span>
          ))}
        </Tip>
      ) : null}
      {nothing && empty ? <div className="ch-empty">{empty}</div> : null}
    </div>
  );
}

/** Columns, with an optional neutral average line over them and a dashed forecast column at the end. */
export function BarChart({
  labels,
  values,
  color = TONE.gold,
  height = 200,
  format = n0,
  unit = "",
  line,
  forecast,
  empty,
  colors,
  valueLabels,
  detail,
}: {
  labels: string[];
  values: number[];
  /** Writes each column's value above it. */
  valueLabels?: boolean;
  /** An extra line in the hover readout for a column. */
  detail?: (i: number) => string | null;
  color?: string;
  height?: number;
  format?: Fmt;
  unit?: string;
  /** Drawn as a neutral dashed reference line over the columns, never as a second data colour. */
  line?: { label: string; values: number[]; color: string };
  forecast?: { label: string; value: number };
  empty?: string;
  colors?: string[];
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const cols = forecast ? [...values, forecast.value] : values;
  const names = forecast ? [...labels, forecast.label] : labels;
  const n = cols.length;
  const yMax = niceMax(Math.max(1, ...cols, ...(line?.values ?? [])), 2);
  const iw = Math.max(10, width - PAD.l - PAD.r);
  // A chart with an average line keeps a clear row at the top for its name, so the label never lands on a column.
  const top = line ? PAD.t + 15 : PAD.t;
  const ih = height - top - PAD.b;
  const slot = iw / Math.max(1, n);
  const bw = Math.max(6, Math.min(30, slot * 0.56));
  const cx = (i: number) => PAD.l + slot * i + slot / 2;
  const y = (v: number) => top + ih - (v / yMax) * ih;
  const ticks = [0, 0.5, 1].map((f) => f * yMax);
  const every = Math.ceil(n / (width < 500 ? 4 : 7));
  const nothing = !cols.some((v) => v > 0);

  return (
    <div className="ch" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={`${names.map((l, i) => `${l}: ${format(cols[i])}`).join(", ")}`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} className="ch-grid" />
            <text x={PAD.l - 8} y={y(t) + 4} className="ch-axis" textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        {forecast ? <rect x={PAD.l + slot * (n - 1)} y={top - 12} width={slot} height={ih + 12} className="ch-zone" rx={6} /> : null}
        {cols.map((v, i) => {
          const isForecast = !!forecast && i === n - 1;
          const h = Math.max(v > 0 ? 3 : 0, (v / yMax) * ih);
          const d = column(cx(i) - bw / 2, y(0) - h, bw, h, 4);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={PAD.l + slot * i} y={top} width={slot} height={ih} fill="transparent" />
              {v > 0 ? (
                isForecast ? (
                  <path d={d} className="ch-forecast" style={{ stroke: colors?.[i] ?? color }} />
                ) : (
                  <path d={d} className="ch-col" style={{ fill: colors?.[i] ?? color, opacity: hover === null || hover === i ? 1 : 0.5, animationDelay: `${i * 40}ms` }} />
                )
              ) : null}
              {valueLabels && v > 0 ? (
                <text x={cx(i)} y={y(v) - 7} textAnchor="middle" className="ch-val">
                  {isForecast ? v.toFixed(1) : format(v)}
                </text>
              ) : null}
              {i % every === 0 || i === n - 1 ? (
                <text x={cx(i)} y={height - 8} className="ch-axis" textAnchor="middle">
                  {names[i]}
                </text>
              ) : null}
            </g>
          );
        })}
        {line ? (
          <>
            <path d={line.values.map((v, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${y(v).toFixed(1)}`).join("")} className="ch-ref" style={{ stroke: TONE.ink3, strokeDasharray: "5 5" }} />
            <text x={PAD.l} y={PAD.t + 9} className="ch-gut" style={{ fill: TONE.ink3 }}>
              {line.label}
            </text>
          </>
        ) : null}
        <line x1={PAD.l} x2={width - PAD.r} y1={y(0)} y2={y(0)} className="ch-base" />
      </svg>
      {hover !== null ? (
        <Tip x={cx(hover)} width={width}>
          <small>{names[hover]}</small>
          <span>
            <i style={{ background: colors?.[hover] ?? color }} />
            {forecast && hover === n - 1 ? "Forecast" : "Value"}
            <b>
              {format(cols[hover])}
              {unit ? ` ${unit}` : ""}
            </b>
          </span>
          {detail?.(hover) ? (
            <span>
              <i style={{ background: "transparent" }} />
              {detail(hover)}
            </span>
          ) : null}
          {line && hover < line.values.length ? (
            <span>
              <i style={{ background: TONE.ink3 }} />
              {line.label}
              <b>{line.values[hover].toFixed(2)}</b>
            </span>
          ) : null}
        </Tip>
      ) : null}
      {nothing && empty ? <div className="ch-empty">{empty}</div> : null}
    </div>
  );
}

/**
 * One wide bar split into parts of a whole, with every part named, counted and shown as a share underneath.
 * Reads faster than a ring when the question is "what is this made of".
 */
export function StackBar({ parts, unit, empty }: { parts: { label: string; value: number; color: string; note?: string }[]; unit: string; empty?: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  if (!total) return <p className="pg-empty">{empty ?? "Nothing here yet."}</p>;
  return (
    <div className="ch-stack">
      <div className="bar">
        {shown.map((p) => (
          <i key={p.label} style={{ flex: p.value, background: p.color }} title={`${p.label}: ${n0(p.value)} ${unit}`} />
        ))}
      </div>
      <div className="key">
        {parts.map((p) => (
          <div key={p.label}>
            <span className="t">
              <i style={{ background: p.color }} />
              {p.label}
            </span>
            <b>{n0(p.value)}</b>
            <small>{((p.value / total) * 100).toFixed(1)}%</small>
            {p.note ? <em>{p.note}</em> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A ring split into parts, with the total (or any summary) in the middle and a legend beside it. */
export function Donut({ parts, center, sub, size = 168 }: { parts: { label: string; value: number; color: string }[]; center: ReactNode; sub?: ReactNode; size?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const shown = parts.filter((p) => p.value > 0);
  const gap = shown.length > 1 ? 3 : 0;
  let at = 0;
  return (
    <div className="ch-donut">
      <div className="ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={parts.map((p) => `${p.label}: ${p.value}`).join(", ")}>
          <circle cx={size / 2} cy={size / 2} r={r} className="ch-track" strokeWidth={14} fill="none" />
          {total
            ? shown.map((p) => {
                const len = (p.value / total) * c;
                const el = (
                  <circle
                    key={p.label}
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    strokeWidth={14}
                    strokeLinecap="butt"
                    strokeDasharray={`${Math.max(0.5, len - gap)} ${c}`}
                    strokeDashoffset={-at}
                    transform={`rotate(-90 ${size / 2} ${size / 2})`}
                    style={{ stroke: p.color }}
                  />
                );
                at += len;
                return el;
              })
            : null}
        </svg>
        <div className="mid">
          <b>{center}</b>
          {sub ? <small>{sub}</small> : null}
        </div>
      </div>
      <ul>
        {parts.map((p) => (
          <li key={p.label}>
            <i style={{ background: p.color }} />
            <span>{p.label}</span>
            <b>{n0(p.value)}</b>
            <em>{total ? `${Number(((p.value / total) * 100).toFixed(1))}%` : "0%"}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One bar split into parts of a whole, with an optional marker (for example, sent so far today). */
export function Meter({ parts, total, marker, format = n0 }: { parts: { label: string; value: number; color: string }[]; total: number; marker?: { value: number; label: string }; format?: Fmt }) {
  const whole = Math.max(
    total,
    parts.reduce((a, p) => a + p.value, 0),
    1,
  );
  return (
    <div className="ch-meter">
      <div className="bar">
        {parts.map((p) =>
          p.value > 0 ? (
            <span
              key={p.label}
              style={{
                width: `${(p.value / whole) * 100}%`,
                background: p.color,
              }}
              title={`${p.label}: ${format(p.value)}`}
            />
          ) : null,
        )}
        {marker ? (
          <em className={edge((marker.value / whole) * 100)} style={{ left: `${Math.min(100, Math.max(0, (marker.value / whole) * 100))}%` }}>
            <small>{marker.label}</small>
          </em>
        ) : null}
      </div>
      <Legend
        items={parts.map((p) => ({
          label: p.label,
          color: p.color,
          value: format(p.value),
        }))}
      />
    </div>
  );
}

/** A value against a target on one scale: the bar is where we are, the tick is where we need to be. */
export function Bullet({
  value,
  target,
  targetLabel,
  max,
  format = (v) => v.toFixed(1),
  color,
  bands,
}: {
  value: number;
  target: number;
  targetLabel: string;
  max: number;
  format?: Fmt;
  color: string;
  bands?: { to: number; color: string; label: string }[];
}) {
  const pc = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  let from = 0;
  return (
    <div className="ch-bullet">
      <div className="ch-rail">
        {bands?.map((b) => {
          const el = (
            <i
              key={b.label}
              style={{
                left: pc(from),
                width: `calc(${pc(b.to)} - ${pc(from)})`,
                background: b.color,
              }}
              title={b.label}
            />
          );
          from = b.to;
          return el;
        })}
        <span style={{ width: pc(value), background: color }} />
        <em className={edge((target / max) * 100)} style={{ left: pc(target) }}>
          <small>{targetLabel}</small>
        </em>
      </div>
      <div className="scale">
        <span>0</span>
        <span>{format(max / 2)}</span>
        <span>{format(max)}</span>
      </div>
    </div>
  );
}

/** Horizontal bars, one a row, sharing one scale, with optional reference markers. */
export function HBars({
  rows,
  max,
  format = n0,
  markers = [],
  mono,
}: {
  rows: { label: string; value: number; color?: string; note?: ReactNode }[];
  max?: number;
  format?: Fmt;
  markers?: { value: number; label: string; color: string }[];
  mono?: boolean;
}) {
  const top = max ?? niceMax(Math.max(1, ...rows.map((r) => r.value), ...markers.map((m) => m.value)));
  const pc = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  return (
    <div className="ch-hbars">
      {rows.map((r) => (
        <div className="row" key={r.label}>
          <span className={`lbl${mono ? " mono" : ""}`} title={r.label}>
            {r.label}
          </span>
          <div className="ch-rail">
            {r.value > 0 ? <span style={{ width: pc(r.value), background: r.color ?? TONE.gold }} /> : null}
            {markers.map((m) => (
              <em key={m.label} style={{ left: pc(m.value), borderColor: m.color }} />
            ))}
          </div>
          <b>{format(r.value)}</b>
          {r.note ? <small className="note">{r.note}</small> : null}
        </div>
      ))}
      {markers.length ? (
        <Legend
          items={markers.map((m) => ({
            label: `${m.label} (${format(m.value)})`,
            color: m.color,
            dashed: true,
          }))}
        />
      ) : null}
    </div>
  );
}

/** A tiny trend line for a number tile. */
export function Spark({ values, color = TONE.gold }: { values: (number | null)[]; color?: string }) {
  const id = useId().replace(/:/g, "");
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return null;
  const lo = Math.min(...pts.map((p) => p[1]));
  const hi = Math.max(...pts.map((p) => p[1]));
  const span = hi - lo || Math.max(1, hi);
  const w = 100;
  const h = 28;
  const px = (i: number) => ((i / (values.length - 1)) * w).toFixed(1);
  const py = (v: number) => (h - 3 - ((v - lo) / span) * (h - 6)).toFixed(1);
  // A smooth curve that never overshoots, so a quiet week of zeros stays flat instead of zigzagging.
  const d = monotone(pts.map(([i, v]) => [Number(px(i)), Number(py(v))] as [number, number]));
  const [li, lv] = pts[pts.length - 1];
  return (
    <span className="ch-spark" aria-hidden>
      <svg className="ch-spark-svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`${id}-sp`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.14 }} />
            <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <path className="ch-area" d={`${d}L${px(li)},${h}L${px(pts[0][0])},${h}Z`} style={{ fill: `url(#${id}-sp)`, stroke: "none" }} />
        <path d={d} style={{ stroke: color }} vectorEffect="non-scaling-stroke" />
      </svg>
      {/* The latest value, as a round dot: drawn in HTML so the stretched SVG can't squash it into an oval. */}
      <i className="ch-spark-dot" style={{ left: `${px(li)}%`, top: `${(Number(py(lv)) / h) * 100}%`, background: color, color }} />
    </span>
  );
}

export interface MiniPoint {
  /** Short axis label: "Mon" or "Oct 6". */
  label: string;
  /** Full label for the tooltip: "Mon 20 Oct" or "Week of Oct 6". */
  full: string;
  /** null when there is nothing to show for that point (a delivery rate on a day nothing was sent). */
  value: number | null;
}

/**
 * A small chart for a number tile that can actually be read: a dot per day (or week) joined by straight lines, the
 * scale on the left (top value and 0), the days underneath, and a tooltip on hover. Straight lines on purpose: a
 * curve between two days would suggest values that never existed.
 */
export function MiniChart({ points, color = TONE.gold, format = n0, unit, max: fixedMax, height = 76 }: { points: MiniPoint[]; color?: string; format?: Fmt; unit?: (v: number) => string; max?: number; height?: number }) {
  const [ref, width] = useWidth(240);
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  const top = fixedMax ?? niceMax(Math.max(1, ...vals), 2);
  const L = 30; // room for the scale
  const R = 8;
  const T = 8;
  const B = 18; // room for the day labels
  const iw = Math.max(10, width - L - R);
  const ih = height - T - B;
  const x = (i: number) => L + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => T + ih - (Math.min(v, top) / top) * ih;
  // Straight segments, broken where a point has no value. Each run also closes down to the base line, for the
  // soft fill under it.
  let d = "";
  let area = "";
  let run: [number, number][] = [];
  const close = () => {
    if (run.length > 1) area += `M${run[0][0].toFixed(1)},${y(0).toFixed(1)}${run.map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(1)}`).join("")}L${run[run.length - 1][0].toFixed(1)},${y(0).toFixed(1)}Z`;
    run = [];
  };
  points.forEach((p, i) => {
    if (p.value === null) return void close();
    d += `${run.length ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
    run.push([x(i), y(p.value)]);
  });
  close();
  const fillId = `mf${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // Axis labels: every point when there are few, otherwise first, middle and last.
  const show = n <= 7 ? points.map((_, i) => i).filter((i) => n <= 5 || i % 2 === 0 || i === n - 1) : [0, Math.round((n - 1) / 2), n - 1];
  const lastIdx = (() => {
    for (let i = n - 1; i >= 0; i--) if (points[i].value !== null) return i;
    return -1;
  })();
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const h = hover !== null ? points[hover] : null;
  return (
    <div className="ch ch-mini" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={points.map((p) => `${p.full}: ${p.value === null ? "none" : format(p.value)}`).join(", ")}>
        <line x1={L} x2={width - R} y1={y(top)} y2={y(top)} className="ch-mini-top" />
        <line x1={L} x2={width - R} y1={y(0)} y2={y(0)} className="ch-mini-base" />
        <text x={L - 6} y={y(top) + 3.5} textAnchor="end" className="ch-mini-scale">
          {format(top)}
        </text>
        <text x={L - 6} y={y(0) + 3.5} textAnchor="end" className="ch-mini-scale">
          {format(0)}
        </text>
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: color, stopOpacity: 0.32 }} />
            <stop offset="1" style={{ stopColor: color, stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        {area ? <path d={area} className="ch-mini-area" fill={`url(#${fillId})`} /> : null}
        {d ? <path d={d} className="ch-line draw ch-mini-line" pathLength={1} style={{ stroke: color }} /> : null}
        {points.map((p, i) =>
          p.value === null ? null : (
            <circle
              key={i}
              cx={x(i)}
              cy={y(p.value)}
              r={i === lastIdx || i === hover ? 4.2 : 3}
              className={`ch-mini-dot${i === lastIdx ? " last" : ""}`}
              style={{ fill: color, animationDelay: `${300 + i * 45}ms` }}
            />
          ),
        )}
        {show.map((i) => (
          <text key={i} x={x(i)} y={height - 4} textAnchor={i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle"} className="ch-mini-x">
            {points[i].label}
          </text>
        ))}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + ih} className="ch-guide" /> : null}
        <rect x={L - 6} y={0} width={iw + 12} height={height} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {h ? (
        <div className="ch-tip ch-mini-tip" style={{ left: Math.min(Math.max(x(hover!), 70), width - 70) }}>
          <small>{h.full}</small>
          <b>{h.value === null ? "nothing sent" : unit ? unit(h.value) : format(h.value)}</b>
        </div>
      ) : null}
    </div>
  );
}
