import { parseCsv } from "../lib/csv.js";
import { EMAIL_RE, normalizeEmail } from "../lib/normalize.js";

const PLACEHOLDER = new Set(["", "null", "n/a", "#n/a", "na", "none", "nil", "-", "--", "n.a.", "undefined", "(empty)"]);

const FIELD_ALIASES: Record<string, string[]> = {
  email: [
    "primary email", "primary_email", "work email", "work_email", "business email", "professional email", "verified email",
    "email (found)", "found email", "email", "email address", "e-mail", "e-mail address", "emailaddress", "email_address",
    "e-post", "epost", "contact email", "contact_email", "mail", "email 1", "email_1", "email1", "personal email",
  ],
  first_name: ["first name", "firstname", "first_name", "given name", "given_name", "contact first name", "förnamn", "fornamn", "fname", "first"],
  last_name: ["last name", "lastname", "last_name", "surname", "family name", "family_name", "contact last name", "efternamn", "lname", "last"],
  full_name: ["full name", "fullname", "full_name", "contact name", "contact_name", "lead name", "prospect name", "display name", "person name", "person", "namn", "name"],
  company: [
    "company name cleaned", "company name", "company_name", "companyname", "organization name", "organisation", "organization", "org name",
    "account name", "business name", "business_name", "current company", "företag", "foretag", "employer", "account", "org", "company", "brand", "business",
  ],
  title: ["job title", "job_title", "jobtitle", "current position", "person title", "position", "designation", "occupation", "headline", "befattning", "titel", "role", "title"],
  website: [
    "company website", "company_website", "organization website", "business website", "website url", "website_url", "company domain", "company_domain",
    "website", "web site", "webbplats", "hemsida", "homepage", "site", "domain", "www", "web", "url",
  ],
  phone: ["direct phone", "work phone", "mobile phone", "phone number", "phone_number", "telefon", "telephone", "mobile", "cell", "tel", "phone"],
  linkedin_url: ["person linkedin url", "person_linkedin_url", "linkedin profile url", "linkedin profile", "profile url", "linkedin url", "linkedin_url", "linkedin"],
  location: ["full address", "full_address", "street address", "company address", "location", "address", "adress", "plats"],
  city: ["person city", "company city", "city", "town", "ort", "stad"],
  state: ["person state", "company state", "state", "province", "region", "county", "län"],
  country: ["person country", "company country", "country", "country code"],
  industry: ["industry", "industries", "category", "categories", "business category", "business type", "sector", "vertical", "niche", "main category"],
};

const NEVER_MAP = new Set(["query", "search", "search url", "list name", "source", "keyword", "keywords"]);

export interface ParsedLead {
  email: string;
  emailNormalized: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  company: string | null;
  title: string | null;
  website: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  location: string | null;
  industry: string | null;
}

export interface ParsedCsv {
  leads: ParsedLead[];
  totalRows: number;
  skipped: number;
  mapped: string[];
  column: string;
}

export const normHeader = (h: string) => String(h ?? "").replace(/^﻿/, "").replace(/ /g, " ").trim().toLowerCase().replace(/\s+/g, " ");

const clean = (v: unknown): string | null => {
  const s = String(v ?? "").replace(/^﻿/, "").trim();
  return PLACEHOLDER.has(s.toLowerCase()) ? null : s;
};

export function buildColumnMap(header: string[]): Record<string, number> {
  const ranked: Record<string, { col: number; rank: number }> = {};
  header.forEach((h, i) => {
    const norm = normHeader(h);
    if (!norm || NEVER_MAP.has(norm)) return;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      const rank = aliases.indexOf(norm);
      if (rank === -1) continue;
      if (!ranked[field] || rank < ranked[field].rank) ranked[field] = { col: i, rank };
      return;
    }
    if (/^e-?mail[\s_]*\d+$/.test(norm) && !ranked.email) ranked.email = { col: i, rank: 90 };
  });
  return Object.fromEntries(Object.entries(ranked).map(([k, v]) => [k, v.col]));
}

export function firstEmailInCell(cell: unknown): { email: string; normalized: string } | null {
  const raw = clean(cell);
  if (!raw) return null;
  for (const part of raw.replace(/[[\]"'{}\\]/g, " ").split(/[\s,;|]+/).filter(Boolean)) {
    const { email, normalized } = normalizeEmail(part.replace(/^mailto:/i, ""));
    if (EMAIL_RE.test(normalized)) return { email, normalized };
  }
  return null;
}

function lenientEmailColumn(rows: string[][]): number {
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
  const hits = new Array<number>(width).fill(0);
  for (const r of rows) for (let c = 0; c < Math.min(r.length, width); c++) if (EMAIL_RE.test(String(r[c] ?? "").trim().toLowerCase())) hits[c]++;
  let best = -1;
  let bestN = 0;
  hits.forEach((n, c) => {
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  });
  return best;
}

export function splitName(full: string | null): { first: string | null; last: string | null } {
  if (!full) return { first: null, last: null };
  const s = full.trim();
  if (s.includes(",")) {
    const [lastPart, firstPart] = s.split(",").map((x) => x.trim());
    if (firstPart) return { first: firstPart.split(/\s+/)[0], last: lastPart || null };
  }
  const toks = s.split(/\s+/);
  return toks.length === 1 ? { first: toks[0], last: null } : { first: toks[0], last: toks.slice(1).join(" ") };
}

const BIZ_NAME_RE = /[&@0-9]|\b(ab|hb|as|oy|aps|ltd|llc|inc|gmbh|bv|srl|co\.|studio|caf[eé]|restaurant|bistro|hotel|clinic|gym|bar|pub|shop|store|group|holding|consulting|agency|bakery|garage|center|centre)\b/i;
const looksLikeUrl = (v: string) => /(^https?:\/\/|^www\.|\.[a-z]{2,})(\/|$|\?)/i.test(v);

export function parseLeadCsv(text: string): ParsedCsv | null {
  if (!text?.trim()) return null;
  const rows = parseCsv(text);
  if (!rows.length) return null;
  const header = rows[0];
  const cols = buildColumnMap(header);
  const viaHeader = Object.keys(cols).length > 0;
  let emailCol = cols.email ?? -1;
  if (emailCol < 0) emailCol = lenientEmailColumn(viaHeader ? rows.slice(1) : rows);
  if (emailCol < 0) return null;
  const dataRows = rows.slice(viaHeader ? 1 : 0);
  const get = (r: string[], f: string) => (cols[f] != null ? clean(r[cols[f]]) : null);

  const businessMode = cols.first_name == null && cols.last_name == null && cols.industry != null && (cols.title == null || cols.full_name == null);
  const seen = new Set<string>();
  const leads: ParsedLead[] = [];
  let skipped = 0;
  for (const r of dataRows) {
    const em = firstEmailInCell(r[emailCol]);
    if (!em || seen.has(em.normalized)) {
      skipped++;
      continue;
    }
    seen.add(em.normalized);
    let full = get(r, "full_name");
    let first = get(r, "first_name");
    let last = get(r, "last_name");
    let company = get(r, "company");
    if (businessMode) {
      company = company ?? full;
      full = full ?? company;
    } else {
      if (!full && (first || last)) full = [first, last].filter(Boolean).join(" ");
      const businessLabel = !!full && ((!!company && normHeader(full) === normHeader(company)) || (!company && (full.split(/\s+/).length > 4 || BIZ_NAME_RE.test(full))));
      if (full && !first && !last && !businessLabel) ({ first, last } = splitName(full));
      if (businessLabel && !company) company = full;
      if (!full && !first && !last) full = company;
    }
    let website = get(r, "website");
    if (website && (/linkedin\.com/i.test(website) || (!looksLikeUrl(website) && !website.includes(".")))) website = null;
    const location = get(r, "location") ?? ([get(r, "city"), get(r, "state"), get(r, "country")].filter(Boolean).join(", ") || null);
    let linkedin = get(r, "linkedin_url");
    if (linkedin && !/linkedin\.com/i.test(linkedin)) linkedin = null;
    leads.push({
      email: em.email,
      emailNormalized: em.normalized,
      firstName: first,
      lastName: last,
      fullName: full,
      company,
      title: get(r, "title"),
      website,
      phone: get(r, "phone")?.replace(/^tel:/i, "").trim() || null,
      linkedinUrl: linkedin,
      location,
      industry: get(r, "industry"),
    });
  }
  if (!leads.length) return null;
  return { leads, totalRows: dataRows.length, skipped, mapped: Object.keys(cols), column: String(header[emailCol] ?? `column ${emailCol + 1}`) };
}

export function parseEmailOrDomainList(text: string): { emails: string[]; domains: string[] } {
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const token of text.split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    if (token.includes("@")) {
      const { normalized } = normalizeEmail(token);
      if (EMAIL_RE.test(normalized)) emails.add(normalized);
    } else {
      const d = token.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split("/")[0];
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) domains.add(d);
    }
  }
  return { emails: [...emails], domains: [...domains] };
}
