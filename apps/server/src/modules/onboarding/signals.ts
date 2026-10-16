import type { SiteHome, SitePage } from "../../integrations/site.js";
import type { Signals } from "./analysisPrompt.js";

const TLD_COUNTRY: [RegExp, string][] = [
  [/\.(co|org|ac)\.uk$|\.uk$/, "United Kingdom"],
  [/\.ie$/, "Ireland"],
  [/\.de$/, "Germany"],
  [/\.fr$/, "France"],
  [/\.nl$/, "Netherlands"],
  [/\.be$/, "Belgium"],
  [/\.es$/, "Spain"],
  [/\.it$/, "Italy"],
  [/\.se$/, "Sweden"],
  [/\.no$/, "Norway"],
  [/\.dk$/, "Denmark"],
  [/\.fi$/, "Finland"],
  [/\.ch$/, "Switzerland"],
  [/\.at$/, "Austria"],
  [/\.pl$/, "Poland"],
  [/\.pt$/, "Portugal"],
  [/\.ca$/, "Canada"],
  [/\.com\.au$|\.au$/, "Australia"],
  [/\.co\.nz$|\.nz$/, "New Zealand"],
  [/\.ae$/, "United Arab Emirates"],
  [/\.sa$/, "Saudi Arabia"],
  [/\.pk$/, "Pakistan"],
  [/\.co\.in$|\.in$/, "India"],
  [/\.sg$/, "Singapore"],
  [/\.co\.za$|\.za$/, "South Africa"],
  [/\.com\.br$|\.br$/, "Brazil"],
  [/\.mx$/, "Mexico"],
  [/\.jp$/, "Japan"],
];

const PHONE_COUNTRY: [RegExp, string][] = [
  [/\+44[\s(]/g, "United Kingdom"],
  [/\+1[\s(-]\d{3}/g, "United States"],
  [/\+353[\s(]/g, "Ireland"],
  [/\+49[\s(]/g, "Germany"],
  [/\+33[\s(]/g, "France"],
  [/\+31[\s(]/g, "Netherlands"],
  [/\+61[\s(]/g, "Australia"],
  [/\+971[\s(]/g, "United Arab Emirates"],
  [/\+92[\s(]/g, "Pakistan"],
  [/\+91[\s(]/g, "India"],
  [/\+46[\s(]/g, "Sweden"],
  [/\+65[\s(]/g, "Singapore"],
];

const DOLLAR_BY_COUNTRY: Record<string, string> = { Canada: "CAD", Australia: "AUD", "New Zealand": "NZD", Singapore: "SGD" };

const TITLE_WORDS =
  "(?:Co-?founder|Founder|Owner|CEO|COO|CFO|CTO|CMO|CRO|Chief [A-Z][a-z]+ Officer|Managing Director|Managing Partner|Partner|President|Vice President|VP|SVP|Head|Director|Manager|Lead)";
const TESTIMONIAL = new RegExp(`\\b[A-Z][a-z]+(?: [A-Z][a-z'-]+){1,2}\\s*[,|–—-]\\s*(${TITLE_WORDS}(?:[ ,&/-]+(?:of|for|[A-Z][A-Za-z&]+)){0,5})`, "g");

function mostCommon(counts: Map<string, number>): string | null {
  let best: [string, number] | null = null;
  for (const e of counts) if (!best || e[1] > best[1]) best = e;
  return best ? best[0] : null;
}

function countryOf(domain: string, text: string): string | null {
  const byTld = TLD_COUNTRY.find(([re]) => re.test(domain))?.[1];
  if (byTld) return byTld;
  const counts = new Map<string, number>();
  for (const [re, c] of PHONE_COUNTRY) {
    const n = text.match(re)?.length ?? 0;
    if (n) counts.set(c, (counts.get(c) ?? 0) + n);
  }
  return mostCommon(counts);
}

function currencyOf(text: string, country: string | null): string | null {
  const counts = new Map<string, number>();
  const add = (code: string, re: RegExp) => {
    const n = text.match(re)?.length ?? 0;
    if (n) counts.set(code, (counts.get(code) ?? 0) + n);
  };
  add("GBP", /£\s?\d/g);
  add("EUR", /€\s?\d|\d\s?€/g);
  add((country && DOLLAR_BY_COUNTRY[country]) ?? "USD", /(?<![A-Za-z])\$\s?\d/g);
  add("INR", /₹\s?\d/g);
  add("PKR", /\b(?:PKR|Rs\.?)\s?\d/g);
  add("AED", /\bAED\s?\d/g);
  return mostCommon(counts);
}

function testimonialTitles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TESTIMONIAL)) {
    const t = m[1].replace(/[\s,&/-]+$/, "").replace(/\s+/g, " ").trim();
    if (t.length >= 2 && t.length <= 60) out.add(t);
    if (out.size >= 15) break;
  }
  return [...out];
}

export function extractSignals(domain: string, home: SiteHome | null, pages: SitePage[]): Signals {
  const text = pages.map((p) => p.text).join("\n");
  const country = countryOf(domain.toLowerCase(), text);
  return {
    country,
    language: home?.lang ?? null,
    currency: currencyOf(text, country),
    named_customers: [...new Set(pages.flatMap((p) => p.logos ?? []))].slice(0, 20),
    testimonial_titles: testimonialTitles(text),
  };
}
