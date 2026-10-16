"use client";

import { Icon } from "@/components/ui/Icon";
import { Button, TextField } from "@/components/ui/primitives";

export interface ProofPoint {
  claim: string;
  source: string;
}

/** The results an email may quote, each with where it comes from. Emails never invent one. */
export function ProofPoints({ value, onChange, disabled }: { value: ProofPoint[]; onChange: (v: ProofPoint[]) => void; disabled?: boolean }) {
  return (
    <div className="stack">
      {value.map((p, i) => (
        <div className="grid2 proof-row" key={i}>
          <TextField label={i === 0 ? "Result you can prove" : " "} placeholder="Cut review time by about 60% in the first week" value={p.claim} maxLength={300} disabled={disabled} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, claim: e.target.value } : x)))} />
          <div style={{ display: "flex", gap: 8, alignItems: "end" }}>
            <TextField label={i === 0 ? "Where it comes from" : " "} placeholder="Case study with Acme, 2026" value={p.source} maxLength={300} disabled={disabled} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, source: e.target.value } : x)))} />
            <button type="button" className="btn btn-text btn-sm" aria-label="Remove this result" disabled={disabled} onClick={() => onChange(value.filter((_, k) => k !== i))}>
              <Icon id="x" />
            </button>
          </div>
        </div>
      ))}
      <div>
        <Button size="sm" disabled={disabled || value.length >= 20} onClick={() => onChange([...value, { claim: "", source: "" }])}>
          Add a result
        </Button>
      </div>
    </div>
  );
}
