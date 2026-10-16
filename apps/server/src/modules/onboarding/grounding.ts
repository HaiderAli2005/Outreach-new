import type { Analysis } from "./analysisValidate.js";
import { normalizeDomain } from "./analysisValidate.js";
import type { PromptPage, Signals } from "./analysisPrompt.js";

/**
 * Checks every factual claim in the analysis against the pages the model actually read, and removes what the pages
 * don't support. Judgement (who to email, why they buy) is left alone; facts about the company are not.
 *
 *  - proof, differentiators and evidence must name a page that was read, and that page must say it
 *  - every number in a claim must appear on the pages
 *  - named customers, buyer titles seen, competitors and lookalike domains must be written on the site
 *  - offerings must use the site's own words
 */

const STOP = new Set(
  "about above after again against all also and any are because been before being below between both but can could did does doing down during each even every from further have having here into just like more most much must near need only other over own same should since some such than that their them then there these they this those through under until very were what when where which while with within without would your yours will used uses using make makes made help helps helped".split(" "),
);

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[‘’]/g, "'");
const words = (s: string) => norm(s).split(/[^a-z0-9%$£€']+/).filter(Boolean);
const content = (s: string) => words(s).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d/.test(w));
/** Numbers as written, without thousands separators: "1,200" -> "1200", "22%" -> "22". */
export const numbersIn = (s: string) => [...norm(s).matchAll(/\d[\d,.]*\d|\d/g)].map((m) => m[0].replace(/,/g, "").replace(/\.$/, ""));

export interface GroundedPage {
  url: string;
  text: string;
  words: Set<string>;
  digits: string;
}

export function indexPages(pages: PromptPage[]): GroundedPage[] {
  return pages.map((p) => {
    const text = norm(p.text);
    return { url: p.url, text, words: new Set(words(p.text)), digits: text.replace(/,/g, "") };
  });
}

/** The page a source points at: "/pricing", "https://site.com/pricing/", "pricing" all find /pricing. */
export function pageFor(source: string, pages: GroundedPage[], domain: string): GroundedPage | null {
  let path = source.trim();
  try {
    const u = new URL(path);
    if (normalizeDomain(u.hostname) !== normalizeDomain(domain)) return null;
    path = u.pathname;
  } catch {
    /* a path already */
  }
  path = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (!path.startsWith("/") && path !== "user-answers") path = `/${path}`;
  return pages.find((p) => (p.url.replace(/\/+$/, "") || "/") === path) ?? null;
}

const hasWord = (page: GroundedPage, w: string) => page.words.has(w) || (w.length >= 6 && [...page.words].some((x) => x.length >= 5 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))));

/** How much of a claim a page backs up: every number present, and most of the meaningful words. */
export function supportedBy(claim: string, page: GroundedPage): boolean {
  for (const n of numbersIn(claim)) if (!page.digits.includes(n)) return false;
  const c = content(claim);
  if (!c.length) return numbersIn(claim).length > 0;
  const found = c.filter((w) => hasWord(page, w)).length;
  return c.length < 3 ? found === c.length : found / c.length >= 0.6;
}

const anywhere = (claim: string, pages: GroundedPage[]) => pages.some((p) => supportedBy(claim, p));
const named = (name: string, pages: GroundedPage[], extra: string[] = []) => {
  const n = norm(name).trim();
  return n.length >= 2 && (pages.some((p) => p.text.includes(n)) || extra.some((e) => norm(e).includes(n)));
};

export function groundAnalysis(analysis: Analysis, pagesIn: PromptPage[], signals: Signals | null, domain: string): { analysis: Analysis; repairs: string[] } {
  const repairs: string[] = [];
  const pages = indexPages(pagesIn);
  const bd = { ...analysis.brand_detail };
  let checked = 0;
  let dropped = 0;

  const sourced = <T extends { source: string }>(items: T[], field: string, textOf: (x: T) => string): T[] =>
    items.flatMap((item) => {
      checked++;
      const page = pageFor(item.source, pages, domain);
      if (!page) {
        dropped++;
        repairs.push(`grounding.${field}: dropped "${textOf(item).slice(0, 60)}" (source ${item.source} was not read)`);
        return [];
      }
      if (!supportedBy(textOf(item), page)) {
        dropped++;
        repairs.push(`grounding.${field}: dropped "${textOf(item).slice(0, 60)}" (not supported by ${page.url})`);
        return [];
      }
      return [{ ...item, source: page.url }];
    });

  bd.proof = sourced(bd.proof, "proof", (x) => x.text);
  bd.differentiators = sourced(bd.differentiators, "differentiators", (x) => x.text);
  bd.evidence = sourced(bd.evidence, "evidence", (x) => x.claim);

  const keepNamed = (list: string[], field: string, extra: string[]) =>
    list.filter((x) => {
      if (named(x, pages, extra)) return true;
      repairs.push(`grounding.${field}: removed "${x}" (not on the site)`);
      return false;
    });
  bd.named_customers = keepNamed(bd.named_customers, "named_customers", signals?.named_customers ?? []);
  bd.buyer_titles_seen = keepNamed(bd.buyer_titles_seen, "buyer_titles_seen", signals?.testimonial_titles ?? []);

  // Logos read by code count as named on the site, so "brightlabs.co.uk" is fine when the Brightlabs logo is there.
  const logoNames = [...(signals?.named_customers ?? []), ...bd.named_customers].map((n) => norm(n).replace(/[^a-z0-9]/g, ""));
  const onSite = (d: string) => {
    const sld = normalizeDomain(d).split(".")[0];
    const flat = sld.replace(/[^a-z0-9]/g, "");
    return (
      pages.some((p) => p.text.includes(normalizeDomain(d)) || (sld.length >= 4 && new RegExp(`\\b${sld.replace(/[^a-z0-9-]/g, "")}\\b`).test(p.text))) ||
      (flat.length >= 4 && logoNames.some((n) => n.length >= 4 && (n === flat || n.startsWith(flat) || flat.startsWith(n))))
    );
  };
  // Competitors the site doesn't name are still excluded from lead searches, just not shown as facts.
  bd.competitors = bd.competitors.filter((d) => {
    if (onSite(d)) return true;
    repairs.push(`grounding.competitors: ${d} hidden (not named on the site, still excluded from searches)`);
    return false;
  });

  bd.offerings = bd.offerings.filter((o) => {
    checked++;
    if (anywhere(o, pages)) return true;
    dropped++;
    repairs.push(`grounding.offerings: removed "${o}" (not in the site's words)`);
    return false;
  });

  const numbersOk = (s: string) => numbersIn(s).every((n) => pages.some((p) => p.digits.includes(n)));
  if (bd.price_level && !numbersOk(bd.price_level)) {
    repairs.push(`grounding.price_level: removed "${bd.price_level}" (price not on the site)`);
    bd.price_level = null;
  }
  if (bd.customer_size_hint && !numbersOk(bd.customer_size_hint)) {
    repairs.push(`grounding.customer_size_hint: removed "${bd.customer_size_hint}" (numbers not on the site)`);
    bd.customer_size_hint = null;
  }
  if (bd.one_liner && !numbersOk(bd.one_liner)) {
    const cleaned = bd.one_liner.replace(/\s*(?:[,;(]|\bwith\b|\bfor\b|\bacross\b)?[^,;()]*\d[^,;()]*\)?/g, "").replace(/\s{2,}/g, " ").trim();
    repairs.push(`grounding.one_liner: removed an unsupported number from "${bd.one_liner}"`);
    bd.one_liner = cleaned.length >= 12 ? cleaned : bd.offerings.slice(0, 2).join(" and ");
  }

  const audiences = analysis.target_audience.map((a) => ({
    ...a,
    lookalike_domains: a.lookalike_domains.filter((d) => {
      if (onSite(d)) return true;
      repairs.push(`grounding.${a.id}.lookalike_domains: removed ${d} (not on the site)`);
      return false;
    }),
  }));

  // A thin, mostly unsupported answer should be treated with less confidence, so the user is asked instead of misled.
  if (checked >= 4 && dropped / checked > 0.5) {
    const before = bd.confidence;
    bd.confidence = Math.max(0, Math.round((bd.confidence - 0.15) * 100) / 100);
    repairs.push(`grounding.confidence: ${before} -> ${bd.confidence} (${dropped} of ${checked} claims were not on the site)`);
  }

  return { analysis: { ...analysis, brand_detail: bd, target_audience: audiences }, repairs };
}

/** The page a statement most likely came from, from the checked evidence, or null. */
export function sourceFor(value: string, evidence: { claim: string; source: string }[]): string | null {
  const want = new Set(content(value));
  if (!want.size) return null;
  let best: { source: string; score: number } | null = null;
  for (const e of evidence) {
    const got = content(e.claim).filter((w) => want.has(w)).length;
    const score = got / want.size;
    if (got && (!best || score > best.score)) best = { source: e.source, score };
  }
  return best && best.score >= 0.25 ? best.source : null;
}
