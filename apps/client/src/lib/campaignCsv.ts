import type { LeadSource, NewCampaignInput } from "./types";

/**
 * Campaigns from a spreadsheet: one row per campaign. Lists inside a cell (keywords, titles, locations, sizes,
 * seniority) are separated by semicolons, so a cell never needs quotes; commas inside a quoted cell work too.
 */

export const CSV_COLUMNS = ["name", "who_they_are", "why_they_buy", "people", "job_titles", "exact_titles", "seniority", "keywords", "locations", "company_sizes", "source", "named_only", "maps_cities"] as const;

const OWNERS = ["owner", "founder", "c_suite", "partner"];
const MANAGERS = ["vp", "head", "director", "manager", "senior"];
const SENIORITY: Record<string, string> = {
  owner: "owner",
  owners: "owner",
  founder: "founder",
  founders: "founder",
  "c-level": "c_suite",
  "c level": "c_suite",
  c_suite: "c_suite",
  "c-suite": "c_suite",
  csuite: "c_suite",
  partner: "partner",
  partners: "partner",
  vp: "vp",
  "vice president": "vp",
  head: "head",
  director: "director",
  manager: "manager",
  senior: "senior",
  entry: "entry",
};
const SIZE: Record<string, string> = {
  "1-10": "1,10",
  "11-50": "11,50",
  "51-200": "51,200",
  "201-500": "201,500",
  "501-1000": "501,1000",
  "1001-5000": "1001,5000",
  "5001+": "5001,",
};
/** Apollo's own bands, smaller ones (11-20, 21-50 ...) folded into the band that holds them. */
function sizeOf(raw: string): string | null {
  const v = raw.replace(/\s|,(?=\d{3})/g, "").replace(/to/gi, "-").replace(/–|—/g, "-");
  if (SIZE[v]) return SIZE[v];
  const m = /^(\d+)(?:-(\d+)|\+)?$/.exec(v);
  if (!m) return null;
  const lo = +m[1];
  if (lo >= 5001 || v.endsWith("+")) return lo >= 5001 ? "5001," : null;
  const bands: [number, number][] = [[1, 10], [11, 50], [51, 200], [201, 500], [501, 1000], [1001, 5000]];
  const band = bands.find(([a, b]) => lo >= a && lo <= b);
  return band ? `${band[0]},${band[1]}` : null;
}

/** RFC 4180-ish: quoted cells, doubled quotes, commas and line breaks inside quotes; a BOM is ignored. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const list = (v: string | undefined) =>
  (v ?? "")
    .split(/[;|\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const key = (h: string) => h.trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
const ALIASES: Record<string, (typeof CSV_COLUMNS)[number]> = {
  name: "name",
  campaign: "name",
  campaign_name: "name",
  who_they_are: "who_they_are",
  description: "who_they_are",
  why_they_buy: "why_they_buy",
  why_they_would_buy: "why_they_buy",
  why: "why_they_buy",
  people: "people",
  who_to_reach: "people",
  reach: "people",
  job_titles: "job_titles",
  titles: "job_titles",
  exact_titles: "exact_titles",
  only_exact_titles: "exact_titles",
  seniority: "seniority",
  seniorities: "seniority",
  keywords: "keywords",
  industry_keywords: "keywords",
  locations: "locations",
  location: "locations",
  regions: "locations",
  company_sizes: "company_sizes",
  company_size: "company_sizes",
  sizes: "company_sizes",
  source: "source",
  lead_source: "source",
  find_on: "source",
  named_only: "named_only",
  named_people_only: "named_only",
  maps_cities: "maps_cities",
  cities: "maps_cities",
  google_maps_cities: "maps_cities",
};

export interface CsvCampaigns {
  rows: NewCampaignInput[];
  /** Problems with the file itself: a missing column, an unreadable value. Row problems come from the server. */
  problems: string[];
  /** Per row, values the reader could not use (for example a size it does not know), shown next to the row. */
  notes: string[][];
}

export function campaignsFromCsv(text: string): CsvCampaigns {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], problems: ["The file has no campaign rows under the header."], notes: [] };
  const header = table[0].map((h) => ALIASES[key(h)] ?? null);
  const missing = ["name", "keywords", "locations"].filter((c) => !header.includes(c as (typeof CSV_COLUMNS)[number]));
  if (missing.length) return { rows: [], problems: [`The header row needs these columns: ${missing.join(", ")}. Download the template to see the layout.`], notes: [] };
  const notes: string[][] = [];
  const rows = table.slice(1).map((cells) => {
    const get = (c: (typeof CSV_COLUMNS)[number]) => {
      const i = header.indexOf(c);
      return i >= 0 ? (cells[i] ?? "").trim() : "";
    };
    const note: string[] = [];
    const titles = list(get("job_titles"));
    const people = get("people").toLowerCase();
    const byTitle = people ? /title|manager|people with/.test(people) : titles.length > 0;
    const rawSeniority = list(get("seniority"));
    const seniorities = [...new Set(rawSeniority.map((s) => SENIORITY[s.toLowerCase()] ?? null).filter((s): s is string => !!s))];
    const unknown = rawSeniority.filter((s) => !SENIORITY[s.toLowerCase()]);
    if (unknown.length) note.push(`Seniority not recognised: ${unknown.join(", ")}`);
    const rawSizes = list(get("company_sizes"));
    const sizes = [...new Set(rawSizes.map(sizeOf).filter((s): s is string => !!s))];
    const badSizes = rawSizes.filter((s) => !sizeOf(s));
    if (badSizes.length) note.push(`Company size not recognised: ${badSizes.join(", ")}`);
    const exact = get("exact_titles").toLowerCase();
    const rawSource = get("source").toLowerCase();
    const source: LeadSource | null = !rawSource ? "apollo" : /both|\+|and/.test(rawSource) ? "both" : /map|google/.test(rawSource) ? "maps" : /apollo|lead|search/.test(rawSource) ? "apollo" : null;
    if (!source) note.push(`Source not recognised: ${get("source")} (use apollo, maps or both)`);
    notes.push(note);
    return {
      name: get("name"),
      description: get("who_they_are"),
      why: get("why_they_buy"),
      keywords: list(get("keywords")),
      regions: list(get("locations")),
      sizes,
      titles: byTitle ? titles : [],
      includeSimilarTitles: byTitle ? ["no", "false", "0", "off"].includes(exact) : false,
      seniorities: byTitle ? (seniorities.length ? seniorities : MANAGERS) : OWNERS,
      source: source ?? "apollo",
      namedOnly: ["yes", "true", "1", "on"].includes(get("named_only").toLowerCase()),
      mapsCities: source && source !== "apollo" ? list(get("maps_cities")) : [],
    };
  });
  return { rows, problems: [], notes };
}

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The template: the header and two example rows, owners and managers of one market. */
export function templateCsv(): string {
  const rows = [
    [...CSV_COLUMNS],
    ["Engineering offices · owners", "Engineering consultancies and architecture offices", "", "owners", "", "", "", "engineering consultancy; architectural design; structural engineering", "Saudi Arabia", "1-10; 11-50; 51-200", "apollo", "", ""],
    ["Engineering offices · managers", "Engineering consultancies and architecture offices", "", "titles", "managing director; business development manager; marketing manager", "yes", "vp; head; director; manager; senior", "engineering consultancy; architectural design; structural engineering", "Saudi Arabia", "1-10; 11-50; 51-200", "apollo", "", ""],
    ["Dental clinics · owners", "Dental clinics", "", "owners", "", "", "", "dental clinic; dentistry; orthodontics", "Saudi Arabia", "1-10; 11-50; 51-200", "both", "no", "Riyadh; Jeddah; Dammam"],
  ];
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function saveText(name: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
