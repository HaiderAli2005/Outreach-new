/**
 * Neutral domain names for the shared pool, in the three shapes real sender pools use:
 *
 *   prefix + noun phrase   35%   hellofreightstudio, launchboldripple, meetwavebuzz
 *   two or three tokens    50%   decoderhubs, compliancedrift, bytepath
 *   hyphenated pair        15%   lift-prism, wave-meet
 *
 * spread over TLDs (.com 60, .org 20, .co 12, .net 5, .site 3). A batch on one TLD from one registrar is what
 * snowshoe-spam detection flags, and it loses the whole order at once. Mixing is the defence and it costs nothing.
 *
 * A name belongs to nobody: never our brand, never a word that says email, sales or outreach.
 */

export const PREFIXES = ["hello", "launch", "meet", "go", "lets", "try", "get", "check"] as const;

export const TOKENS = [
  "port", "hub", "forge", "field", "drift", "edge", "pulse", "vox", "prism", "wave", "queue", "plex", "system", "open", "turn", "spark",
  "path", "ridge", "span", "loop", "quartz", "ripple", "cascade", "glide", "swift", "freight", "studio", "bold", "bright", "simple", "buzz",
  "grove", "pivot", "haven", "logic", "decoder", "byte", "fleet", "harbor", "summit", "cedar", "amber", "copper", "atlas", "linen", "meadow",
  "north", "stone", "river", "maple", "beacon", "orbit", "vertex", "signal", "anchor", "canvas", "ember", "lumen", "mosaic", "nimbus", "tidal",
  "willow", "zenith", "lift", "frame", "craft", "shift", "level", "point", "bridge", "range", "crest", "drive", "spring", "mint",
] as const;

/** Words a pool domain may never contain: our brands, and anything that says what the mail is for. */
export const BANNED_WORDS = [
  "aperture", "marketlytics", "skimming", "rankhouse", "ekhata",
  "mail", "email", "outreach", "lead", "leads", "cold", "campaign", "sdr", "prospect", "sales", "crm", "inbox", "send", "sender", "spam", "bulk", "blast",
] as const;

export const TLD_WEIGHTS: readonly [string, number][] = [
  [".com", 60],
  [".org", 20],
  [".co", 12],
  [".net", 5],
  [".site", 3],
];

type Rnd = () => number;

/** A small seeded generator, so a batch can be reproduced in tests. */
export function seeded(seed: number): Rnd {
  let x = Math.abs(Math.floor(seed)) % 2147483647 || 1;
  return () => (x = (x * 48271) % 2147483647) / 2147483647;
}

const pick = <T,>(xs: readonly T[], rnd: Rnd): T => xs[Math.floor(rnd() * xs.length)];

function weighted(rnd: Rnd): string {
  const total = TLD_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [tld, w] of TLD_WEIGHTS) if ((r -= w) < 0) return tld;
  return ".com";
}

export type Pattern = "prefix" | "tokens" | "hyphen";

/** One second-level label in one of the three shapes. */
export function labelFor(pattern: Pattern, rnd: Rnd): string {
  const t = () => pick(TOKENS, rnd);
  switch (pattern) {
    case "prefix":
      return pick(PREFIXES, rnd) + t() + (rnd() < 0.5 ? t() : "");
    case "tokens":
      return t() + t() + (rnd() < 0.2 ? t() : "") + (rnd() < 0.25 ? "s" : "");
    case "hyphen":
      return `${t()}-${t()}`;
  }
}

export function patternFor(rnd: Rnd): Pattern {
  const r = rnd();
  return r < 0.35 ? "prefix" : r < 0.85 ? "tokens" : "hyphen";
}

/** Which shape a name has, or null if it has none of them (used to check names, ours or anyone's). */
export function patternOf(domain: string): Pattern | null {
  const label = domain.slice(0, domain.indexOf("."));
  if (!/^[a-z-]+$/.test(label)) return null;
  const parts = label.split("-");
  if (parts.length === 2) return TOKENS.includes(parts[0] as never) && TOKENS.includes(parts[1] as never) ? "hyphen" : null;
  if (parts.length !== 1) return null;
  const tokensOnly = (s: string, max: number): boolean => {
    if (!s) return true;
    if (max === 0) return s === "s";
    return TOKENS.some((tok) => s.startsWith(tok) && tokensOnly(s.slice(tok.length), max - 1)) || s === "s";
  };
  const prefix = PREFIXES.find((p) => label.startsWith(p));
  if (prefix && tokensOnly(label.slice(prefix.length), 2) && label.length > prefix.length) return "prefix";
  return tokensOnly(label, 3) && TOKENS.some((t) => label.startsWith(t)) ? "tokens" : null;
}

export function isBannedName(domain: string): boolean {
  const d = domain.toLowerCase();
  return BANNED_WORDS.some((w) => d.includes(w));
}

/** `count` distinct, clean names. */
export function generateNames(count: number, seed = Date.now(), exclude: Iterable<string> = []): string[] {
  const rnd = seeded(seed);
  const seen = new Set<string>([...exclude].map((x) => x.toLowerCase()));
  const out: string[] = [];
  for (let i = 0; out.length < count && i < count * 50; i++) {
    const name = `${labelFor(patternFor(rnd), rnd)}${weighted(rnd)}`;
    if (name.length > 30 || seen.has(name) || isBannedName(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export interface PlannedDomain {
  domain: string;
  tld: string;
  pattern: Pattern;
}

/**
 * Names to suggest for a batch the operator buys: varied TLDs (at least three whenever the batch has three or more
 * names), so no batch sits on one TLD. Buying them from more than one registrar is up to the operator.
 */
export function planBatch(count: number, seed = Date.now(), exclude: Iterable<string> = []): PlannedDomain[] {
  let names = generateNames(count * 4, seed, exclude);
  const tld = (d: string) => d.slice(d.indexOf("."));
  const chosen: string[] = [];
  const minTlds = Math.min(3, count);
  // First one name per distinct TLD until the minimum spread is met, then the rest in generated order.
  for (const t of new Set(names.map(tld))) {
    if (chosen.length >= minTlds) break;
    chosen.push(names.find((n) => tld(n) === t)!);
  }
  if (new Set(chosen.map(tld)).size < minTlds) {
    // The weights rarely produce fewer than three TLDs; when they do, force the missing ones.
    for (const [t] of TLD_WEIGHTS) {
      if (chosen.length >= minTlds) break;
      if (!chosen.some((c) => tld(c) === t)) chosen.push(chosen[0].replace(/\.[a-z]+$/, t));
    }
  }
  names = names.filter((n) => !chosen.includes(n));
  while (chosen.length < count && names.length) chosen.push(names.shift()!);
  return chosen.map((domain) => ({ domain, tld: tld(domain), pattern: patternOf(domain) ?? "tokens" }));
}
