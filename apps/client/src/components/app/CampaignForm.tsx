"use client";

import { Select } from "@/components/ui/Select";
import { ChipInput, Field, TextArea, TextField } from "@/components/ui/primitives";
import type { Campaign } from "@/lib/types";

const SIZES: [string, string][] = [
  ["1,10", "1 to 10"],
  ["11,50", "11 to 50"],
  ["51,200", "51 to 200"],
  ["201,500", "201 to 500"],
  ["501,1000", "501 to 1,000"],
  ["1001,5000", "1,001 to 5,000"],
  ["5001,1000000", "5,001+"],
];
const SENIORITIES = ["owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager", "senior"];

export interface CampaignInput {
  name: string;
  niche: string | null;
  marketBrief: string | null;
  language: string;
  apolloFilters: {
    person_titles: string[];
    person_seniorities: string[];
    organization_num_employees_ranges: string[];
    person_locations: string[];
    q_organization_keyword_tags: string[];
    q_keywords?: string;
  };
}

const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

export function initialCampaign(c?: Campaign | null): CampaignInput {
  const f = (c?.apolloFilters ?? {}) as Record<string, unknown>;
  return {
    name: c?.name ?? "",
    niche: c?.niche ?? "",
    marketBrief: c?.marketBrief ?? "",
    language: c?.language ?? "en",
    apolloFilters: {
      person_titles: arr(f.person_titles),
      person_seniorities: arr(f.person_seniorities),
      organization_num_employees_ranges: arr(f.organization_num_employees_ranges),
      person_locations: arr(f.person_locations),
      q_organization_keyword_tags: arr(f.q_organization_keyword_tags),
      q_keywords: typeof f.q_keywords === "string" ? f.q_keywords : "",
    },
  };
}

export function toPayload(v: CampaignInput) {
  const f = { ...v.apolloFilters };
  if (!f.q_keywords) delete f.q_keywords;
  return { ...v, name: v.name.trim(), niche: v.niche?.trim() || null, marketBrief: v.marketBrief?.trim() || null, apolloFilters: f };
}

export function CampaignForm({ value, onChange, disabled }: { value: CampaignInput; onChange: (v: CampaignInput) => void; disabled?: boolean }) {
  const f = value.apolloFilters;
  const setF = (patch: Partial<CampaignInput["apolloFilters"]>) => onChange({ ...value, apolloFilters: { ...f, ...patch } });
  return (
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
      <TextField label="Campaign name" value={value.name} maxLength={120} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="UK agencies, spring" />
      <div className="grid2">
        <TextField label="Market or niche" value={value.niche ?? ""} maxLength={200} onChange={(e) => onChange({ ...value, niche: e.target.value })} placeholder="Marketing agencies" />
        <div className="grid2">
          <Field label="Language" htmlFor="cLang">
            <Select id="cLang" className="input" value={value.language} onChange={(e) => onChange({ ...value, language: e.target.value })}>
              {[
                ["en", "English"],
                ["sv", "Swedish"],
                ["de", "German"],
                ["fr", "French"],
                ["es", "Spanish"],
                ["nl", "Dutch"],
                ["da", "Danish"],
                ["no", "Norwegian"],
              ].map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <TextArea label="Market brief" hint="What makes this market different. Used when writing emails." rows={3} maxLength={2000} value={value.marketBrief ?? ""} onChange={(e) => onChange({ ...value, marketBrief: e.target.value })} />
      <div className="h5" style={{ marginTop: 6 }}>
        Targeting
      </div>
      <div className="grid2">
        <Field label="Job titles">
          <ChipInput values={f.person_titles} onChange={(v) => setF({ person_titles: v })} label="Job titles" max={40} />
        </Field>
        <Field label="Locations">
          <ChipInput values={f.person_locations} onChange={(v) => setF({ person_locations: v })} label="Locations" max={20} />
        </Field>
        <Field label="Industry keywords">
          <ChipInput values={f.q_organization_keyword_tags} onChange={(v) => setF({ q_organization_keyword_tags: v })} label="Industry keywords" max={30} />
        </Field>
        <TextField label="Extra keywords" value={f.q_keywords ?? ""} maxLength={200} onChange={(e) => setF({ q_keywords: e.target.value })} />
      </div>
      <Field label="Company size">
        <div className="chips">
          {SIZES.map(([k, l]) => {
            const on = f.organization_num_employees_ranges.includes(k);
            return (
              <button key={k} type="button" className="pill-btn" aria-pressed={on} onClick={() => setF({ organization_num_employees_ranges: on ? f.organization_num_employees_ranges.filter((x) => x !== k) : [...f.organization_num_employees_ranges, k] })}>
                {l}
              </button>
            );
          })}
        </div>
      </Field>
      <Field label="Seniority">
        <div className="chips">
          {SENIORITIES.map((k) => {
            const on = f.person_seniorities.includes(k);
            return (
              <button key={k} type="button" className="pill-btn" aria-pressed={on} onClick={() => setF({ person_seniorities: on ? f.person_seniorities.filter((x) => x !== k) : [...f.person_seniorities, k] })}>
                {k.replace("_", " ")}
              </button>
            );
          })}
        </div>
      </Field>
    </fieldset>
  );
}
