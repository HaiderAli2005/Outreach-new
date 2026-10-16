"use client";

import { useEffect, useState } from "react";
import { Button, ChipInput, ErrorState, SkeletonRows, TextArea, TextField, ViewHead } from "@/components/ui/primitives";
import { ProofPoints } from "@/components/app/ProofPoints";
import { useRole, useToast } from "@/store";
import { errorMessage, useBusinessProfileQuery, useSaveBusinessProfileMutation } from "@/store/api";
import type { BusinessProfile } from "@/lib/types";
import { dateLong } from "@/lib/format";

type Draft = Omit<BusinessProfile, "updatedAt" | "suggested">;

const pick = (p: BusinessProfile): Draft => ({ company: p.company, sell: p.sell, who: p.who, where: p.where, offerings: p.offerings, differentiators: p.differentiators, tone: p.tone, proofPoints: p.proofPoints });

/**
 * Setup > Business profile. What the AI believes about the business, editable. It starts as what the setup analysis
 * found; once saved it is the one record every email is written from. Saving never rewrites drafts already approved.
 */
export default function BusinessProfilePage() {
  const { data, isLoading, isError, error, refetch } = useBusinessProfileQuery();
  const [save, { isLoading: saving }] = useSaveBusinessProfileMutation();
  const { canManage } = useRole();
  const toast = useToast();
  const [d, setD] = useState<Draft | null>(null);
  useEffect(() => {
    if (data) setD(pick(data));
  }, [data]);

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data || !d) return <SkeletonRows rows={6} h={64} />;
  const set = (p: Partial<Draft>) => setD((x) => (x ? { ...x, ...p } : x));
  const dirty = JSON.stringify(d) !== JSON.stringify(pick(data)) || !!data.suggested?.length;
  const fromAnalysis = (k: keyof Draft) => (data.suggested?.includes(k) ? " · from your setup analysis" : "");

  return (
    <>
      <ViewHead kicker="Setup" title="Business profile" sub="This is what the AI uses to write every email, so getting it right improves the copy. Changes apply to every email written from now on; emails you already approved stay as they are." />
      <fieldset disabled={!canManage} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="panel glass">
          <h3>What you sell</h3>
          <div className="stack" style={{ marginTop: 14 }}>
            <TextField label="Company" value={d.company} maxLength={160} onChange={(e) => set({ company: e.target.value })} hint={`The name emails introduce you by${fromAnalysis("company")}`} />
            <TextArea label="What you sell" rows={3} maxLength={700} value={d.sell} onChange={(e) => set({ sell: e.target.value })} hint={`One or two plain sentences. Every email builds on this${fromAnalysis("sell")}.`} />
            <ChipInput label="What you offer" values={d.offerings} onChange={(v) => set({ offerings: v })} placeholder="+ Add a product or service" max={12} />
            <ChipInput label="What makes you different" values={d.differentiators} onChange={(v) => set({ differentiators: v })} placeholder="+ Add a difference" max={12} />
          </div>
        </div>
        <div className="panel glass">
          <h3>Who you sell to</h3>
          <div className="stack" style={{ marginTop: 14 }}>
            <TextArea label="Your buyers" rows={2} maxLength={500} value={d.who} onChange={(e) => set({ who: e.target.value })} hint={`The people and companies you sell to${fromAnalysis("who")}. Who gets emailed is set in Targeting.`} />
            <TextField label="Where you sell" value={d.where} maxLength={300} onChange={(e) => set({ where: e.target.value })} hint={`Countries or regions${fromAnalysis("where")}`} />
          </div>
        </div>
        <div className="panel glass">
          <h3>
            Proof<small>the only numbers and results an email may quote{fromAnalysis("proofPoints")}</small>
          </h3>
          <p className="fine" style={{ marginTop: 6 }}>Emails never invent a result, a customer or a number. Keep the ones you can stand behind, with where they come from. An email uses at most one.</p>
          <div style={{ marginTop: 12 }}>
            <ProofPoints value={d.proofPoints} disabled={!canManage} onChange={(v) => set({ proofPoints: v })} />
          </div>
        </div>
        <div className="panel glass">
          <h3>How you sound</h3>
          <div style={{ marginTop: 14 }}>
            <TextArea label="Tone notes" rows={2} maxLength={500} value={d.tone} onChange={(e) => set({ tone: e.target.value })} hint="For example: plain and direct, no hype, never call it a platform." />
          </div>
        </div>
      </fieldset>
      {canManage ? (
        <div className="ob-foot glass" style={{ marginTop: 4 }}>
          <span className="spacer muted" style={{ fontSize: 14 }}>
            {data.suggested?.length ? "Filled from your setup analysis. Save to make it what the AI uses." : data.updatedAt ? `Last saved ${dateLong(data.updatedAt)}` : ""}
          </span>
          {dirty && !data.suggested?.length ? (
            <Button variant="text" onClick={() => setD(pick(data))}>
              Discard
            </Button>
          ) : null}
          <Button
            variant="primary"
            loading={saving}
            disabled={!dirty || !d.sell.trim()}
            onClick={() =>
              save({ ...d, proofPoints: d.proofPoints.filter((x) => x.claim.trim().length >= 3 && x.source.trim().length >= 3) })
                .unwrap()
                .then(() => toast("Business profile saved. New emails use it from now on.", "good"))
                .catch((e) => toast(errorMessage(e), "bad"))
            }
          >
            Save profile
          </Button>
        </div>
      ) : null}
    </>
  );
}
