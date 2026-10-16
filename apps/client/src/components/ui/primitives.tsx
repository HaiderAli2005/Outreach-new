"use client";

import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Icon, type IconId } from "./Icon";
import { errorMessage } from "@/store/api";

type BtnVariant = "primary" | "ghost" | "glass" | "text" | "danger";

export function Button({
  variant = "ghost",
  size,
  loading,
  arrow,
  icon,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" | "xs"; loading?: boolean; arrow?: boolean; icon?: IconId }) {
  return (
    <button type="button" className={`btn btn-${variant}${size ? ` btn-${size}` : ""} ${className}`} disabled={rest.disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" /> : icon ? <Icon id={icon} /> : null}
      {children}
      {arrow && !loading ? <Icon id="arr" className="arr" /> : null}
    </button>
  );
}

export function Spinner({ dark }: { dark?: boolean }) {
  return <span className="spinner" style={dark ? { borderColor: "rgba(255,240,220,.2)", borderTopColor: "var(--gold)" } : undefined} />;
}

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="err" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function TextField({ label, hint, error, id, className = "", ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; error?: string | null }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fid}>
      <input id={fid} className={`input ${className}`} aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
}

export function TextArea({ label, hint, error, id, className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode; error?: string | null }) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fid}>
      <textarea id={fid} className={`input ${className}`} aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
}

export function PasswordInput({ id, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw">
      <input id={id} className="input" type={show ? "text" : "password"} {...rest} />
      <button type="button" onClick={() => setShow((s) => !s)}>
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size,
  disabled,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm";
  disabled?: boolean;
}) {
  return (
    <div className={`seg${size ? ` ${size}` : ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} disabled={disabled} onClick={() => onChange(o.value)} style={{ padding: "0 12px" }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function SettingRow({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="t">
        <b>{title}</b>
        {desc ? <small>{desc}</small> : null}
      </div>
      {children}
    </div>
  );
}

export function Notice({ tone = "info", icon = "alert", title, children }: { tone?: "good" | "bad" | "info" | "warn"; icon?: IconId; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice glass${tone === "warn" ? "" : ` ${tone}`}`} role="note">
      <span className="ic">
        <Icon id={icon} />
      </span>
      <div>
        {title ? <h3>{title}</h3> : null}
        {children ? <p>{children}</p> : null}
      </div>
    </div>
  );
}

export function Chip({ tone, children }: { tone: "g" | "b" | "v" | "y" | "r"; children: ReactNode }) {
  return <span className={`chip-s ${tone}`}>{children}</span>;
}

export function StatePill({ tone, pulse, children }: { tone: "warm" | "go" | "off" | "bad"; pulse?: boolean; children: ReactNode }) {
  return (
    <span className={`state-pill ${tone}`}>
      {pulse ? <span className="pulse" /> : null}
      {children}
    </span>
  );
}

export function Skeleton({ h = 16, w = "100%", r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skel" style={{ height: h, width: w, borderRadius: r }} />;
}

export function SkeletonRows({ rows = 5, h = 44 }: { rows?: number; h?: number }) {
  return (
    <div style={{ display: "grid", gap: 10, padding: 16 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={h} />
      ))}
    </div>
  );
}

export function Empty({ icon = "inbox", title, children, action }: { icon?: IconId; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="ic-box">
        <Icon id={icon} />
      </span>
      <b>{title}</b>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = "This didn't load" }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="errbox" role="alert">
      <span className="ic-box" style={{ color: "var(--bad)" }}>
        <Icon id="alert" />
      </span>
      <b>{title}</b>
      <p>{errorMessage(error)}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry} icon="rotate">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Pager({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total ? (page - 1) * limit + 1 : 0;
  const to = Math.min(total, page * limit);
  return (
    <div className="pager">
      <span>
        {from.toLocaleString()} to {to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <Button size="xs" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="xs" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function ChipInput({ values, onChange, placeholder = "+ Add", label, max = 12 }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string; label: string; max?: number }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="chips">
      {values.map((c, i) => (
        <span className="chip" key={`${c}-${i}`}>
          {c}
          <button type="button" aria-label={`Remove ${c}`} onClick={() => onChange(values.filter((_, j) => j !== i))}>
            <Icon id="x" />
          </button>
        </span>
      ))}
      {values.length < max ? (
        <input
          ref={ref}
          className="chip-add"
          placeholder={placeholder}
          aria-label={`Add to ${label}`}
          maxLength={80}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== ",") return;
            e.preventDefault();
            const v = e.currentTarget.value.trim();
            if (!v || values.some((x) => x.toLowerCase() === v.toLowerCase())) return;
            onChange([...values, v]);
            e.currentTarget.value = "";
          }}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) {
              onChange([...values, v]);
              e.currentTarget.value = "";
            }
          }}
        />
      ) : null}
    </div>
  );
}

export function Avatar({ name, url, size = 36 }: { name: string | null; url?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const ini = (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]?.toUpperCase())
    .join("");
  if (url && !broken)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" width={size} height={size} onError={() => setBroken(true)} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover" }} referrerPolicy="no-referrer" />
    );
  return (
    <span className="av avatar-g" style={{ width: size, height: size }} aria-hidden="true">
      {ini || "?"}
    </span>
  );
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ViewHead({ kicker, title, sub, actions }: { kicker?: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
      <div>
        {kicker ? <div className="ob-kicker">{kicker}</div> : null}
        <h1 className="ob-h sm">{title}</h1>
        {sub ? <p className="ob-p">{sub}</p> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{actions}</div> : null}
    </div>
  );
}
