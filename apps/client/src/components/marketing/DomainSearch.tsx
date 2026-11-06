"use client";

import { useEffect, useId, useRef, useState } from "react";
import { preconnect } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { normDomain, validDomain } from "@/lib/format";
import { useLiquidGlass } from "@/components/ui/liquidGlass";
import { SiteNotice, useSiteCheck } from "@/components/domain/SiteCheck";
import { fromBrandfetch, fromClearbit, mergeSuggestions, SUGGEST_ORIGINS, type CompanySuggestion } from "@/lib/companySuggest";

const SAMPLES = ["yourcompany.com", "northwind.io", "brightlabs.co", "harborandco.com"];

function useTypedPlaceholder(ref: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const input = ref.current;
    if (!input || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let i = 0;
    let j = 0;
    let del = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (document.activeElement === input || input.value) {
        t = setTimeout(tick, 700);
        return;
      }
      const s = SAMPLES[i];
      if (!del) {
        j++;
        input.placeholder = s.slice(0, j);
        if (j >= s.length) {
          del = true;
          t = setTimeout(tick, 2000);
          return;
        }
      } else {
        j--;
        input.placeholder = s.slice(0, Math.max(j, 0));
        if (j <= 0) {
          del = false;
          i = (i + 1) % SAMPLES.length;
        }
      }
      t = setTimeout(tick, del ? 32 : 85);
    };
    tick();
    return () => clearTimeout(t);
  }, [ref]);
}

type Option = CompanySuggestion & { typed?: boolean };

function Logo({ o }: { o: Option }) {
  const [broken, setBroken] = useState(false);
  if (o.typed) return <Icon id="globe" className="sg-ico" />;
  if (!o.icon || broken) return <span className="sg-logo sg-letter">{o.name.charAt(0).toUpperCase()}</span>;
  return <img className="sg-logo" src={o.icon} alt="" width={24} height={24} onError={() => setBroken(true)} />;
}

export function DomainSearch({ id, cta, onDomain, hero }: { id: string; cta?: boolean; onDomain?: (d: string) => void; hero?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  useLiquidGlass(ring, cta ? { scale: 28, bezel: 22 } : { scale: 32, bezel: 26 });
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const router = useRouter();
  const listId = useId();
  const site = useSiteCheck();
  useTypedPlaceholder(inputRef);

  useEffect(() => {
    if (!hero) return;
    const focus = () => inputRef.current?.focus({ preventScroll: true });
    window.addEventListener("ap:focus-search", focus);
    return () => window.removeEventListener("ap:focus-search", focus);
  }, [hero]);

  // Open the connections to the suggestion services early so the first suggestion doesn't wait for the handshake.
  useEffect(() => {
    for (const origin of SUGGEST_ORIGINS) preconnect(origin, origin.includes("cdn.") ? undefined : { crossOrigin: "anonymous" });
  }, []);

  // Suggestions follow what is typed. The list narrows on every key straight away from what is already showing,
  // and fresh results replace it as they arrive. Requests are not cancelled while typing, so results keep
  // coming in during fast typing; an older answer never replaces a newer one.
  const seq = useRef(0);
  const applied = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setOptions([]);
      return;
    }
    const typed = normDomain(q);
    const own: Option[] = validDomain(typed) ? [{ name: typed, domain: typed, icon: null, typed: true }] : [];
    // "northwind.io" searches for "northwind", so the company shows up while the ending is still being typed.
    const term = typed.includes(".") ? typed.split(".")[0] : q;
    const needle = term.toLowerCase();
    setOptions((cur) => {
      const kept = cur.filter((o) => !o.typed && (o.name.toLowerCase().includes(needle) || o.domain.includes(needle)));
      return [...own, ...kept.filter((o) => o.domain !== typed)];
    });
    setActive(-1);
    const id = ++seq.current;
    const got: { cb?: CompanySuggestion[]; bf?: CompanySuggestion[] } = {};
    const show = () => {
      if (id < applied.current) return;
      applied.current = id;
      const found = mergeSuggestions([got.cb, got.bf]);
      const rest = found.filter((f) => f.domain !== typed);
      const exact = found.find((f) => f.domain === typed);
      setOptions(exact ? [exact, ...rest] : [...own, ...rest]);
    };
    const t = setTimeout(() => {
      fromClearbit(term).then((r) => ((got.cb = r), show())).catch(() => undefined);
      fromBrandfetch(term).then((r) => ((got.bf = r), show())).catch(() => undefined);
    }, 60);
    return () => clearTimeout(t);
  }, [query]);

  const shown = open && options.length > 0;
  const open_ = (d: string) => router.push(`/onboarding?domain=${encodeURIComponent(d)}`);

  /** The domain is checked before setup opens: a typo stops here, an unreadable site says why and can go on. */
  async function go(d: string, check = true) {
    setErr("");
    setOpen(false);
    onDomain?.(d);
    if (!check) return open_(d);
    const r = await site.run(d);
    if (r?.status === "missing") {
      setErr(r.message ?? "We can't find that domain. Check the spelling.");
      inputRef.current?.focus();
      return;
    }
    if (r?.status === "unreadable") return;
    open_(d);
  }

  function pick(o: Option) {
    if (inputRef.current) inputRef.current.value = o.domain;
    setQuery(o.domain);
    void go(o.domain);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (shown && active >= 0 && options[active]) return pick(options[active]);
    const raw = inputRef.current?.value ?? "";
    const d = normDomain(raw);
    if (!validDomain(d)) {
      if (options.length && !options[0].typed) return pick(options[0]);
      setErr(raw.trim() ? "That doesn't look like a domain. Try something like northwind.io" : "Enter your company domain, like northwind.io");
      inputRef.current?.focus();
      return;
    }
    void go(d);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!options.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      const n = options.length;
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : a <= 0 ? n - 1 : a - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  const proof = hero ? (
    <div className="proof">
      <span className="proof-l">
        <span>Free preview in about a minute</span>
        <i aria-hidden="true" />
        <span>No card needed</span>
      </span>
      <span className="proof-gift">
        <Icon id="gift" />
        $10 free in credits
      </span>
    </div>
  ) : null;

  return (
    <>
      <div className={`sring${cta ? " sring-cta" : ""}${shown ? " is-open" : ""}`} ref={ring}>
        <div className="sbar-wrap">
          <form className={`sbar${cta ? " sbar-cta" : ""}`} role="search" onSubmit={submit} noValidate>
            <label htmlFor={id}>
              <span className="sr">Your company domain</span>
              <Icon id="globe" className="sbar-ico" />
              <input
                ref={inputRef}
                id={id}
                name="domain"
                type="text"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="yourcompany.com"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={shown}
                aria-controls={listId}
                aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
                onKeyDown={onKey}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onChange={(e) => {
                  setErr("");
                  site.clear();
                  const c = e.currentTarget.value.replace(/^\s*https?:\/\//i, "");
                  if (c !== e.currentTarget.value) e.currentTarget.value = c;
                  setQuery(c);
                  setOpen(true);
                  const d = normDomain(c);
                  if (validDomain(d)) onDomain?.(d);
                }}
              />
            </label>
            <button className="sbar-go" type="submit" disabled={site.busy} aria-busy={site.busy}>
              {site.busy ? "Checking" : "Analyze"}
              {site.busy ? <span className="au-spin" /> : <Icon id="arr" />}
            </button>
          </form>
          {shown ? (
            <ul className="sugg" id={listId} role="listbox" aria-label="Matching companies">
              {options.map((o, i) => (
                <li
                  key={o.domain + (o.typed ? ":typed" : "")}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o)}
                >
                  <Logo o={o} />
                  {o.typed ? (
                    <>
                      <span className="sg-name">Use {o.domain}</span>
                      <span className="sg-dom">your domain</span>
                    </>
                  ) : (
                    <>
                      <span className="sg-name">{o.name}</span>
                      <span className="sg-dom">{o.domain}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {proof}
      </div>
      <div className={`search-err${cta ? " cta-err" : ""}`} role="alert">
        {err}
      </div>
      {site.result?.status === "unreadable" ? (
        <SiteNotice check={site.result} retrying={site.busy} onContinue={() => open_(site.result!.domain)} onRetry={() => void site.run(site.result!.domain, true).then((r) => r?.status === "ok" && open_(r.domain))} />
      ) : null}
    </>
  );
}
