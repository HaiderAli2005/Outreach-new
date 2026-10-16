"use client";

import { Children, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

type Opt = { value: string; label: string; disabled: boolean };

function textOf(n: ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (isValidElement(n)) return textOf((n.props as { children?: ReactNode }).children);
  return "";
}

/** Reads plain <option> children (also inside fragments and <optgroup>), so call sites stay written like a <select>. */
function collect(children: ReactNode, out: Opt[] = []): Opt[] {
  Children.forEach(children, (ch) => {
    if (!isValidElement(ch)) return;
    const p = ch.props as { value?: string | number; children?: ReactNode; disabled?: boolean };
    if (ch.type === "option") {
      const label = textOf(p.children);
      out.push({ value: p.value === undefined ? label : String(p.value), label, disabled: !!p.disabled });
    } else collect(p.children, out);
  });
  return out;
}

export interface SelectProps {
  value: string | number | null | undefined;
  /** Same shape as a native select's change event, so `(e) => set(e.target.value)` keeps working. */
  onChange?: (e: { target: { value: string } }) => void;
  children: ReactNode;
  id?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  /** Shows a filter box. On by default for long lists (time zones). */
  searchable?: boolean;
}

/**
 * The app's dropdown: a themed button and menu in place of the browser's own select list. The menu is portalled to
 * the body so scrolling panes and tables never clip it, and it opens upward when there is no room below.
 */
export function Select({ value, onChange, children, id, className = "select", style, disabled, title, "aria-label": ariaLabel, searchable }: SelectProps) {
  const options = useMemo(() => collect(children), [children]);
  const current = options.find((o) => o.value === String(value ?? "")) ?? null;
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<CSSProperties>({});
  const btn = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const typed = useRef({ s: "", t: 0 });
  const listId = useId();
  const withSearch = searchable ?? options.length > 12;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  }, [options, q]);

  const place = () => {
    const el = btn.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = vh - r.bottom - 10;
    const above = r.top - 10;
    const up = below < 220 && above > below;
    const width = Math.min(Math.max(r.width, 200), vw - 16);
    const left = Math.min(Math.max(8, r.left), vw - width - 8);
    setPos({
      position: "fixed",
      left,
      minWidth: width,
      maxWidth: Math.max(width, Math.min(380, vw - 16)),
      maxHeight: Math.min(340, (up ? above : below) - 4),
      ...(up ? { bottom: vh - r.top + 6 } : { top: r.bottom + 6 }),
    });
  };

  const show = () => {
    if (disabled) return;
    place();
    setQ("");
    setHi(Math.max(0, options.findIndex((o) => o.value === String(value ?? ""))));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  const pick = (o: Opt | undefined) => {
    if (!o || o.disabled) return;
    if (o.value !== String(value ?? "")) onChange?.({ target: { value: o.value } });
    close();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const reflow = (e: Event) => {
      if (pop.current && e.target instanceof Node && pop.current.contains(e.target)) return;
      place();
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", reflow);
    window.addEventListener("scroll", reflow, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", reflow);
      window.removeEventListener("scroll", reflow, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open && withSearch) search.current?.focus();
  }, [open, withSearch]);

  useEffect(() => {
    if (open) pop.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, hi]);

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (!shown[i].disabled) return i;
    return from;
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), close());
    else if (e.key === "Tab") close(false);
    else if (e.key === "ArrowDown") (e.preventDefault(), setHi((i) => step(i, 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setHi((i) => step(i, -1)));
    else if (e.key === "Home") (e.preventDefault(), setHi(step(-1, 1)));
    else if (e.key === "End") (e.preventDefault(), setHi(step(shown.length, -1)));
    else if (e.key === "Enter" || (e.key === " " && !withSearch)) (e.preventDefault(), pick(shown[hi]));
    else if (!withSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Type-ahead: jump to the first option starting with what was typed.
      const now = Date.now();
      typed.current = { s: (now - typed.current.t < 700 ? typed.current.s : "") + e.key.toLowerCase(), t: now };
      const i = shown.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.s));
      if (i >= 0) setHi(i);
    }
  };

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        className={`ui-select ${className}`}
        style={style}
        title={title}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKey}
      >
        <span className={`ui-select-v${current ? "" : " ph"}`}>{current?.label ?? "Choose…"}</span>
        <Icon id="chev" className="ui-select-chev" />
      </button>
      {open
        ? createPortal(
            <div
              ref={pop}
              className="ui-select-pop"
              style={pos}
              onMouseDown={(e) => {
                e.stopPropagation();
                // Keep focus on the trigger (or the search box) so the keyboard keeps working after a click in the menu.
                if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {withSearch ? (
                <div className="ui-select-search">
                  <Icon id="search" />
                  <input ref={search} value={q} placeholder="Search" aria-label="Search options" onChange={(e) => (setQ(e.target.value), setHi(0))} onKeyDown={onKey} />
                </div>
              ) : null}
              <div className="ui-select-list" role="listbox" id={listId} aria-label={ariaLabel}>
                {shown.length ? (
                  shown.map((o, i) => (
                    <div
                      key={`${o.value}|${i}`}
                      data-i={i}
                      role="option"
                      aria-selected={o.value === String(value ?? "")}
                      aria-disabled={o.disabled || undefined}
                      className={`ui-select-opt${i === hi ? " hi" : ""}`}
                      onMouseEnter={() => !o.disabled && setHi(i)}
                      onClick={() => pick(o)}
                    >
                      <span className="ck">{o.value === String(value ?? "") ? <Icon id="check" /> : null}</span>
                      <span className="lb">{o.label}</span>
                    </div>
                  ))
                ) : (
                  <div className="ui-select-none">No matches</div>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
