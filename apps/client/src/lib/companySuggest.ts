import { normDomain, validDomain } from "./format";

export type CompanySuggestion = { name: string; domain: string; icon: string | null };

/**
 * Company suggestions while someone types in the domain box. Both calls go straight from the visitor's browser,
 * so no keys are stored on our server and nothing is saved.
 *
 * - Clearbit's company autocomplete answers in about 0.2 seconds from a CDN, so it fills the list first.
 * - Brandfetch's Brand Search (about 0.5 to 1 second) adds better logos and any companies Clearbit missed, and keeps
 *   the box working if Clearbit's free endpoint ever stops. NEXT_PUBLIC_BRANDFETCH_CLIENT_ID is the free client ID
 *   from brandfetch.com/developers; without it Brandfetch still answers, at a lower limit.
 */
const BRANDFETCH_ID = process.env.NEXT_PUBLIC_BRANDFETCH_CLIENT_ID;

export const SUGGEST_ORIGINS = ["https://autocomplete.clearbit.com", "https://api.brandfetch.io", "https://cdn.brandfetch.io"];

type Row = { name?: unknown; domain?: unknown; icon?: unknown; logo?: unknown };

/** Answers already fetched on this page, so Backspace is instant. Memory only; gone when the page closes. */
const recent = new Map<string, CompanySuggestion[]>();

async function lookup(source: string, url: string, q: string, signal?: AbortSignal): Promise<CompanySuggestion[]> {
  const key = `${source}|${q.toLowerCase()}`;
  const hit = recent.get(key);
  if (hit) return hit;
  const res = await fetch(url, { signal, credentials: "omit" });
  if (!res.ok) return [];
  const rows: unknown = await res.json();
  const out = Array.isArray(rows) ? clean(rows as Row[]) : [];
  recent.set(key, out);
  if (recent.size > 300) recent.delete(recent.keys().next().value as string);
  return out;
}

function clean(rows: Row[]): CompanySuggestion[] {
  const out: CompanySuggestion[] = [];
  for (const r of rows) {
    const domain = normDomain(typeof r.domain === "string" ? r.domain : "");
    if (!validDomain(domain)) continue;
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : domain;
    const raw = typeof r.icon === "string" ? r.icon : typeof r.logo === "string" ? r.logo : "";
    out.push({ name, domain, icon: /^https:\/\//.test(raw) ? raw : null });
  }
  return out;
}

export function fromClearbit(query: string, signal?: AbortSignal): Promise<CompanySuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return Promise.resolve([]);
  return lookup("cb", `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`, q, signal);
}

export function fromBrandfetch(query: string, signal?: AbortSignal): Promise<CompanySuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return Promise.resolve([]);
  const id = BRANDFETCH_ID ? `?c=${encodeURIComponent(BRANDFETCH_ID)}` : "";
  return lookup("bf", `https://api.brandfetch.io/v2/search/${encodeURIComponent(q)}${id}`, q, signal);
}

/**
 * One list from several sources, in the order given. A company appears once (same domain or same name), and a
 * logo from a later source fills in where an earlier one had none.
 */
export function mergeSuggestions(lists: (CompanySuggestion[] | undefined)[], limit = 6): CompanySuggestion[] {
  const byDomain = new Map<string, CompanySuggestion>();
  const names = new Set<string>();
  const out: CompanySuggestion[] = [];
  for (const list of lists) {
    for (const s of list ?? []) {
      const same = byDomain.get(s.domain);
      if (same) {
        if (!same.icon && s.icon) same.icon = s.icon;
        continue;
      }
      const name = s.name.toLowerCase();
      if (names.has(name)) continue;
      const copy = { ...s };
      byDomain.set(s.domain, copy);
      names.add(name);
      out.push(copy);
    }
  }
  return out.slice(0, limit);
}
