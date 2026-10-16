import { ALLOWED_COMPANY_SIZES, ALLOWED_SENIORITIES } from "./analysisPrompt.js";

export interface Sourced {
  text: string;
  source: string;
}

export interface BrandDetail {
  company_name: string;
  one_liner: string;
  offerings: string[];
  business_model: "B2B" | "B2C" | "both" | null;
  customer_types: string[];
  customer_size_hint: string | null;
  geographies: string[];
  price_level: string | null;
  proof: Sourced[];
  differentiators: Sourced[];
  named_customers: string[];
  buyer_titles_seen: string[];
  competitors: string[];
  language: string;
  brand_voice: string;
  confidence: number;
  evidence: { claim: string; source: string }[];
}

export interface Audience {
  id: string;
  priority: number;
  name: string;
  description: string;
  why_they_buy: string;
  goals: string[];
  pain_points: string[];
  objections: string[];
  titles: string[];
  include_similar_titles: boolean;
  seniorities: string[];
  company_sizes: string[];
  countries: string[];
  keywords: string[];
  keyword_suggestions: string[];
  revenue_range: { min: number | null; max: number | null };
  technologies: string[];
  signals: { hiring_for_titles: string[]; headcount_growth_pct_min: number | null; recently_funded: boolean };
  lookalike_domains: string[];
  exclude_domains: string[];
  email_status: ["verified"];
}

export interface Analysis {
  brand_detail: BrandDetail;
  warning: string | null;
  target_audience: Audience[];
}

type Raw = Record<string, unknown>;

const COUNTRY_ALIASES: Record<string, string> = {
  uk: "United Kingdom",
  "u.k.": "United Kingdom",
  gb: "United Kingdom",
  "great britain": "United Kingdom",
  britain: "United Kingdom",
  us: "United States",
  "u.s.": "United States",
  usa: "United States",
  "u.s.a.": "United States",
  america: "United States",
  "united states of america": "United States",
  uae: "United Arab Emirates",
  "u.a.e.": "United Arab Emirates",
  emirates: "United Arab Emirates",
  ksa: "Saudi Arabia",
  holland: "Netherlands",
  "the netherlands": "Netherlands",
  nl: "Netherlands",
  de: "Germany",
  deutschland: "Germany",
  fr: "France",
  ie: "Ireland",
  "republic of ireland": "Ireland",
  ca: "Canada",
  au: "Australia",
  nz: "New Zealand",
  pk: "Pakistan",
  in: "India",
  sg: "Singapore",
  za: "South Africa",
};

const DESCRIPTION = /^(people|those|anyone|someone|teams?|companies|businesses|owners of|leaders of)\b|\b(who|that|which|responsible for|in charge of|looking to|working in)\b/i;

// Words that are a seniority or a function on their own, not a job title a person would put on LinkedIn.
const BARE_TITLE = /^(manager|head|director|senior|junior|vp|svp|evp|vice president|lead|leader|executive|exec|officer|specialist|staff|employee|team|intern|entry|c[-_ ]?suite|c[-_ ]?level|decision maker|management|leadership|senior management)$/i;
const ACRONYM = /^(ceo|coo|cfo|cto|cmo|cro|cio|ciso|cpo|cco|chro|vp|svp|evp|hr|it|pr|seo|ppc|crm|erp|ux|ui|qa|r&d|b2b|b2c|saas|ai|gm|md|pa|ea|smb|sme|uk|us|eu|emea|apac)$/i;

export function titleCase(t: string): string {
  return t
    .split(/(\s+|-|\/)/)
    .map((w, i) => {
      if (!w.trim() || w === "-" || w === "/") return w;
      if (ACRONYM.test(w)) return w.toUpperCase();
      if (i > 0 && /^(of|and|for|the|to|in|at|&)$/i.test(w)) return w.toLowerCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join("");
}

// Keyword rules from "HOW TO WRITE KEYWORDS" in the analysis prompt.
const GENERIC_KEYWORDS = new Set([
  "business", "businesses", "company", "companies", "sme", "smes", "small business", "small businesses", "startup", "startups",
  "services", "service", "solutions", "solution", "technology", "tech", "enterprise", "enterprises", "b2b", "b2c", "industry",
  "organization", "organisation", "corporate", "commercial", "general",
]);
const JOB_FUNCTIONS = new Set([
  "finance", "operations", "sales", "marketing", "hr", "human resources", "procurement", "purchasing", "admin", "administration",
  "management", "leadership", "accounts", "customer service", "customer support",
]);
// Words that name a kind of product, not a kind of company.
const CATEGORY_WORDS = new Set([
  "software", "erp", "crm", "saas", "platform", "app", "apps", "system", "systems", "tool", "tools", "management", "tracking",
  "invoicing", "billing", "integration", "integrations", "automation", "automations", "module", "modules", "solution", "solutions",
]);
const PURE_CATEGORY = new Set(["erp", "crm", "billing", "invoicing", "tracking", "integration", "integrations", "module", "modules", "tool", "tools", "app", "apps", "platform", "system", "systems"]);
const STOP_WORDS = new Set(["and", "of", "for", "the", "&", "with", "to", "a", "an"]);

export const kwNorm = (v: string) => v.toLowerCase().replace(/[^a-z0-9&+ -]+/g, " ").replace(/\s+/g, " ").trim();
const kwCore = (v: string) => kwNorm(v).split(" ").filter((w) => !CATEGORY_WORDS.has(w) && !STOP_WORDS.has(w)).join(" ");

export interface SellerTerms {
  full: Set<string>;
  cores: Set<string>;
  names: string[];
}

export function sellerTerms(offerings: string[], companyName: string, domain: string): SellerTerms {
  const full = new Set<string>();
  const cores = new Set<string>();
  for (const o of offerings) {
    full.add(kwNorm(o));
    const c = kwCore(o);
    if (c) cores.add(c);
  }
  const names = [kwNorm(companyName), normalizeDomain(domain).split(".")[0]].filter((n) => n.length >= 3);
  return { full, cores, names };
}

export type KeywordProblem = "long" | "generic" | "function" | "own-name" | "seller";

const REPAIR_REASON: Record<KeywordProblem, string> = {
  long: "more than 3 words, not a kind of company",
  generic: "too generic",
  function: "a job function, belongs in titles",
  "own-name": "the company's own name",
  seller: "what the company sells, matches competitors not customers",
};

export const KEYWORD_PROBLEM_MESSAGE: Record<KeywordProblem, string> = {
  long: "is longer than 3 words. Use a kind of company, like \"wholesale\" or \"dental clinic\".",
  generic: "is too generic to narrow the search. Use a kind of company, like \"wholesale\" or \"dental clinic\".",
  function: "is a job function. Job functions belong in titles, keywords describe the kind of company.",
  "own-name": "is your own company name.",
  seller: "describes what you sell, so it would find your competitors, not your customers.",
};

/** Checks one normalised keyword against the rules in "HOW TO WRITE KEYWORDS". */
export function keywordProblem(k: string, seller: SellerTerms): KeywordProblem | null {
  if (k.split(" ").length > 3) return "long";
  if (GENERIC_KEYWORDS.has(k)) return "generic";
  if (JOB_FUNCTIONS.has(k)) return "function";
  if (seller.names.some((n) => k.includes(n))) return "own-name";
  const core = kwCore(k);
  if (seller.full.has(k) || (core && seller.cores.has(core)) || (!core && k.split(" ").some((w) => PURE_CATEGORY.has(w)))) return "seller";
  return null;
}

function checkKeywords(raw: unknown, label: string, seller: SellerTerms, repairs: string[], field = "keywords", skip: string[] = []): string[] {
  const out: string[] = [];
  for (const original of strings(raw, 60)) {
    const k = kwNorm(original);
    if (!k || out.includes(k) || skip.includes(k)) continue;
    const problem = keywordProblem(k, seller);
    if (problem) {
      repairs.push(`${label}.${field}: removed "${original}" (${REPAIR_REASON[problem]})`);
      continue;
    }
    if (k !== original.toLowerCase().trim()) repairs.push(`${label}.${field}: "${original}" -> "${k}"`);
    out.push(k);
  }
  if (field !== "keywords") return out.slice(0, 5);
  if (out.length > 5) repairs.push(`${label}.keywords: trimmed to 5`);
  if (out.length < 2) repairs.push(`${label}.keywords: only ${out.length} usable, expected 2 to 5`);
  return out.slice(0, 5);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const nullableStr = (v: unknown, max: number) => str(v, max) || null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown, max: number) => [...new Set(arr(v).map((x) => str(x, max)).filter(Boolean))];
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function normalizeCountry(v: string): string {
  const key = v.trim().toLowerCase();
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  return v
    .trim()
    .split(/\s+/)
    .map((w) => (/^(of|and|the)$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export function normalizeDomain(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#\s]/)[0];
}

const isDomain = (v: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v);

export function validateAnalysis(
  raw: unknown,
  domain: string,
  fallbackLanguage: string | null,
  fallbackCountry: string | null = null,
): { analysis: Analysis; repairs: string[] } {
  const repairs: string[] = [];
  const root = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const bd = (root.brand_detail && typeof root.brand_detail === "object" ? root.brand_detail : {}) as Raw;
  const own = normalizeDomain(domain);

  const sourced = (v: unknown, field: string): Sourced[] => {
    const out: Sourced[] = [];
    for (const item of arr(v)) {
      const r = (item ?? {}) as Raw;
      const text = str(r.text, 300);
      const source = str(r.source, 300);
      if (!text) continue;
      if (!source) {
        repairs.push(`${field}: dropped "${text.slice(0, 60)}" (no source)`);
        continue;
      }
      out.push({ text, source });
    }
    return out;
  };

  let confidence = num(bd.confidence);
  if (confidence === null) {
    repairs.push("brand_detail.confidence: missing, set to 0");
    confidence = 0;
  } else if (confidence < 0 || confidence > 1) {
    repairs.push(`brand_detail.confidence: ${confidence} clamped to 0..1`);
    confidence = Math.min(1, Math.max(0, confidence));
  }

  let language = str(bd.language, 10).toLowerCase().slice(0, 2);
  if (!/^[a-z]{2}$/.test(language)) {
    language = fallbackLanguage && /^[a-z]{2}$/.test(fallbackLanguage) ? fallbackLanguage : "en";
    repairs.push(`brand_detail.language: missing or invalid, set to "${language}"`);
  }

  const model = bd.business_model;
  const competitors = strings(bd.competitors, 120).map(normalizeDomain).filter((d) => isDomain(d) && d !== own);

  const brand_detail: BrandDetail = {
    company_name: str(bd.company_name, 120),
    one_liner: str(bd.one_liner, 200),
    offerings: strings(bd.offerings, 120).slice(0, 6),
    business_model: model === "B2B" || model === "B2C" || model === "both" ? model : null,
    customer_types: strings(bd.customer_types, 120).slice(0, 10),
    customer_size_hint: nullableStr(bd.customer_size_hint, 120),
    geographies: strings(bd.geographies, 80).map(normalizeCountry).slice(0, 10),
    price_level: nullableStr(bd.price_level, 120),
    proof: sourced(bd.proof, "proof").slice(0, 4),
    differentiators: sourced(bd.differentiators, "differentiators").slice(0, 4),
    named_customers: strings(bd.named_customers, 80).slice(0, 20),
    buyer_titles_seen: strings(bd.buyer_titles_seen, 80).slice(0, 15),
    competitors: [...new Set(competitors)].slice(0, 10),
    language,
    brand_voice: str(bd.brand_voice, 400),
    confidence,
    evidence: arr(bd.evidence)
      .map((e) => ({ claim: str((e as Raw)?.claim, 300), source: str((e as Raw)?.source, 300) }))
      .filter((e) => e.claim && e.source)
      .slice(0, 20),
  };
  if (model !== undefined && model !== null && brand_detail.business_model === null) repairs.push(`brand_detail.business_model: "${String(model)}" not allowed, set to null`);

  const seller = sellerTerms(brand_detail.offerings, brand_detail.company_name, own);
  const seenTitles = new Set<string>();
  const rawAudiences = arr(root.target_audience);
  if (rawAudiences.length > 6) repairs.push(`target_audience: ${rawAudiences.length} returned, kept the first 6 by priority`);
  const sorted = rawAudiences
    .map((a, i) => ({ a: (a ?? {}) as Raw, i }))
    .sort((x, y) => (num(x.a.priority) ?? 99) - (num(y.a.priority) ?? 99) || x.i - y.i);

  const audiences: Audience[] = [];
  for (const { a, i } of sorted) {
    if (audiences.length >= 6) break;
    const label = `target_audience[${i}]`;
    const name = str(a.name, 80);
    if (!name) {
      repairs.push(`${label}: dropped (no name)`);
      continue;
    }

    const titles: string[] = [];
    for (const original of strings(a.titles, 80)) {
      if (BARE_TITLE.test(original)) {
        repairs.push(`${label}.titles: removed "${original}" (a seniority, not a job title)`);
        continue;
      }
      if (DESCRIPTION.test(original) || original.split(/\s+/).length > 6) {
        repairs.push(`${label}.titles: removed description "${original}"`);
        continue;
      }
      let t = original;
      if (t === t.toLowerCase() || t === t.toUpperCase()) {
        t = titleCase(t.toLowerCase());
        if (t !== original) repairs.push(`${label}.titles: "${original}" -> "${t}"`);
      }
      const key = t.toLowerCase();
      if (seenTitles.has(key)) {
        repairs.push(`${label}.titles: removed duplicate "${t}"`);
        continue;
      }
      if (titles.length >= 8) {
        repairs.push(`${label}.titles: trimmed "${t}" (more than 8)`);
        continue;
      }
      seenTitles.add(key);
      titles.push(t);
    }
    if (!titles.length) {
      repairs.push(`${label}: dropped (no usable job titles)`);
      continue;
    }

    const allowed = <T extends readonly string[]>(v: unknown, list: T, field: string) => {
      const out: string[] = [];
      for (const x of strings(v, 40)) {
        const val = x.toLowerCase().replace(/\s+/g, "");
        const hit = list.find((l) => l.replace(/\s+/g, "") === val);
        if (hit) out.push(hit);
        else repairs.push(`${label}.${field}: dropped "${x}" (not in allowed list)`);
      }
      return [...new Set(out)];
    };

    const rawCountries = strings(a.countries, 80);
    const countries = [...new Set(rawCountries.map(normalizeCountry))];
    rawCountries.forEach((c) => {
      const n = normalizeCountry(c);
      if (n !== c.trim()) repairs.push(`${label}.countries: "${c}" -> "${n}"`);
    });
    if (countries.length > 3) repairs.push(`${label}.countries: trimmed to 3`);
    if (!countries.length) {
      const fill = fallbackCountry ? [normalizeCountry(fallbackCountry)] : brand_detail.geographies.slice(0, 3);
      if (fill.length) {
        countries.push(...fill);
        repairs.push(`${label}.countries: empty, set to ${fill.join(", ")} (${fallbackCountry ? "site signals" : "brand geographies"})`);
      }
    }

    const keywords = checkKeywords(a.keywords, label, seller, repairs);
    const keywordSuggestions = checkKeywords(a.keyword_suggestions, label, seller, repairs, "keyword_suggestions", keywords);

    const lookalikes = [...new Set(strings(a.lookalike_domains, 120).map(normalizeDomain).filter(isDomain))].filter((d) => {
      if (d === own) return false;
      if (!brand_detail.competitors.includes(d)) return true;
      repairs.push(`${label}.lookalike_domains: removed competitor ${d}`);
      return false;
    });
    const exclude = [...new Set(strings(a.exclude_domains, 120).map(normalizeDomain).filter(isDomain))];
    if (!exclude.includes(own)) {
      exclude.unshift(own);
      repairs.push(`${label}.exclude_domains: added ${own}`);
    }

    const rr = (a.revenue_range ?? {}) as Raw;
    const sig = (a.signals ?? {}) as Raw;
    audiences.push({
      id: `seg_${audiences.length + 1}`,
      priority: audiences.length + 1,
      name,
      description: str(a.description, 300),
      why_they_buy: str(a.why_they_buy, 300),
      goals: strings(a.goals, 120).slice(0, 3),
      pain_points: strings(a.pain_points, 80).slice(0, 4),
      objections: strings(a.objections, 120).slice(0, 3),
      titles,
      include_similar_titles: a.include_similar_titles !== false,
      seniorities: allowed(a.seniorities, ALLOWED_SENIORITIES, "seniorities"),
      company_sizes: allowed(a.company_sizes, ALLOWED_COMPANY_SIZES, "company_sizes"),
      countries: countries.slice(0, 3),
      keywords,
      keyword_suggestions: keywordSuggestions,
      revenue_range: { min: num(rr.min), max: num(rr.max) },
      technologies: strings(a.technologies, 60).map((t) => t.toLowerCase()).slice(0, 10),
      signals: {
        hiring_for_titles: strings(sig.hiring_for_titles, 80).slice(0, 8),
        headcount_growth_pct_min: num(sig.headcount_growth_pct_min),
        recently_funded: sig.recently_funded === true,
      },
      lookalike_domains: lookalikes.slice(0, 5),
      exclude_domains: [...new Set([...exclude, ...brand_detail.competitors])].slice(0, 20),
      email_status: ["verified"],
    });
  }
  if (audiences.length < 3) repairs.push(`target_audience: only ${audiences.length} usable audience(s), expected 3 to 6`);

  return { analysis: { brand_detail, warning: customerWarning(nullableStr(root.warning, 400), repairs), target_audience: audiences }, repairs };
}

/**
 * The warning is shown to the business owner, so it may only say the business sells to consumers.
 * Notes the model writes about its own work (unclear pricing, what is verified, how filters work) are dropped.
 */
export function customerWarning(text: string | null | undefined, repairs?: string[]): string | null {
  if (!text) return null;
  const aboutConsumers = /\b(consumers?|shoppers?|households?|homeowners?|patients?|individuals|the public|B2C|retail customers|end customers|parents|students|travell?ers|diners)\b/i.test(text);
  const internal = /\b(ambiguous|conflicting|contradict|unclear|not verified|unverified|verified|recommendations?|filters?|headcounts?|prospecting|inferred|estimated|the model|extracted|billing labels?)\b/i.test(text);
  if (aboutConsumers && !internal) return text;
  repairs?.push(`warning: dropped "${text.slice(0, 80)}" (internal note, not for the customer)`);
  return null;
}
