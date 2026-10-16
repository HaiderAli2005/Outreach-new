"use client";

import { useEffect, useState } from "react";
import { Button, ChipInput, Empty, ErrorState, Notice, SkeletonRows, Switch, ViewHead } from "@/components/ui/primitives";
import { useRole, useToast } from "@/store";
import { errorMessage, useNavCountsQuery, useSaveTargetingMutation, useTargetingCheckMutation, useTargetingQuery } from "@/store/api";
import type { TargetingEdit, TargetingImpact, TargetingView } from "@/lib/types";
import { n0 } from "@/lib/format";

const sizeLabel = (s: string) => {
  const [a, b] = s.split(",");
  return b ? `${n0(+a)} to ${n0(+b)}` : `${n0(+a)}+`;
};
const editsOf = (v: TargetingView): TargetingEdit[] => v.groups.map((g) => ({ id: g.id, on: g.on, titles: g.titles, keywords: g.keywords, sizes: g.sizes, regions: g.regions }));
const count = (n: number | null) => (n == null ? "not counted yet" : n0(n));

/**
 * Setup > Targeting. The audiences confirmed in setup, editable after launch. The campaign searches each one on its
 * own; a change applies to people found from now on. People already waiting from a changed audience are named
 * before saving, and are only removed when the customer says so.
 */
export default function TargetingPage() {
  const { data, isLoading, isError, error, refetch } = useTargetingQuery();
  const { data: nav } = useNavCountsQuery();
  const [check, checking] = useTargetingCheckMutation();
  const [save, saving] = useSaveTargetingMutation();
  const { canManage } = useRole();
  const toast = useToast();
  const [edits, setEdits] = useState<TargetingEdit[] | null>(null);
  const [impact, setImpact] = useState<TargetingImpact | null>(null);
  useEffect(() => {
    if (data) setEdits(editsOf(data));
  }, [data]);

  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data || !edits) return <SkeletonRows rows={4} h={120} />;
  if (!data.groups.length)
    return (
      <>
        <ViewHead kicker="Setup" title="Targeting" />
        <Empty icon="target" title="No audiences yet">
          Your audiences appear here once setup has analysed your business.
        </Empty>
      </>
    );

  const set = (id: string, p: Partial<TargetingEdit>) => {
    setImpact(null);
    setEdits((e) => (e ? e.map((x) => (x.id === id ? { ...x, ...p } : x)) : e));
  };
  const dirty = JSON.stringify(edits) !== JSON.stringify(editsOf(data));
  const doSave = (dropQueued: boolean) =>
    save({ groups: edits, dropQueued })
      .unwrap()
      .then((r) => {
        setImpact(null);
        toast(r.dropped ? `Targeting saved. ${n0(r.dropped)} queued ${r.dropped === 1 ? "person was" : "people were"} removed and won't be emailed.` : "Targeting saved. New people are found for these audiences from now on.", "good");
      })
      .catch((e) => toast(errorMessage(e), "bad"));
  const onSave = () =>
    check({ groups: edits })
      .unwrap()
      .then((r) => (r.queued ? setImpact(r) : doSave(false)))
      .catch((e) => toast(errorMessage(e), "bad"));

  const verifying = !!nav?.verifying;
  return (
    <>
      <ViewHead
        kicker="Setup"
        title="Targeting"
        sub={`Who your campaign looks for. Each audience is searched on its own${verifying ? ", and every address is checked before anyone is emailed" : ""}. Changes apply to people found from now on.`}
      />
      <div className="panel glass kvgrid kv3">
        <div>
          <small>Matching people</small>
          <b>{count(data.matching)}</b>
        </div>
        <div>
          <small>With a findable email</small>
          <b>{count(data.reachable)}</b>
        </div>
        <div>
          <small>Audiences on</small>
          <b>
            {data.groups.filter((g) => g.on).length} of {data.groups.length}
          </b>
        </div>
      </div>
      <fieldset disabled={!canManage || saving.isLoading} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        {data.groups.map((g) => {
          const e = edits.find((x) => x.id === g.id)!;
          return (
            <div className={`panel glass tg-aud${e.on ? "" : " off"}`} key={g.id}>
              <div className="tg-head">
                <div>
                  <h3>{g.name}</h3>
                  {g.description ? <p className="muted">{g.description}</p> : null}
                </div>
                <Switch label={`${g.name} on`} checked={e.on} disabled={!canManage} onChange={(v) => set(g.id, { on: v })} />
              </div>
              <p className="tg-count">
                {e.on ? (
                  <>
                    <b>{count(g.matching)}</b> matching people{g.reachable != null ? ` · ${n0(g.reachable)} with a findable email` : ""}
                  </>
                ) : (
                  "Off: nobody new is found for this audience."
                )}
                {g.queued ? ` · ${n0(g.queued)} found and waiting to be emailed` : ""}
              </p>
              {e.on ? (
                <div className="stack" style={{ marginTop: 12 }}>
                  <ChipInput label="Job titles" values={e.titles} onChange={(v) => set(g.id, { titles: v })} placeholder="+ Add a title" max={25} />
                  <ChipInput label="Company keywords" values={e.keywords} onChange={(v) => set(g.id, { keywords: v })} placeholder="+ Add a keyword" max={25} />
                  <ChipInput label="Countries or regions" values={e.regions} onChange={(v) => set(g.id, { regions: v })} placeholder="+ Add a country" max={25} />
                  <div>
                    <span className="tg-label">Company size</span>
                    <div className="chips" role="group" aria-label={`${g.name} company size`}>
                      {data.sizeOptions.map((s) => {
                        const on = e.sizes.includes(s);
                        return (
                          <button key={s} type="button" className="pill-btn" aria-pressed={on} onClick={() => set(g.id, { sizes: on ? e.sizes.filter((x) => x !== s) : [...e.sizes, s] })}>
                            {sizeLabel(s)}
                          </button>
                        );
                      })}
                    </div>
                    <p className="fine" style={{ marginTop: 6 }}>None selected means any size.</p>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      {impact ? (
        <Notice tone="warn" icon="alert" title={`${n0(impact.queued)} ${impact.queued === 1 ? "person is" : "people are"} already queued from ${impact.affected.length === 1 ? "an audience" : "audiences"} you changed`}>
          {impact.affected.map((a) => `${a.name}: ${n0(a.queued)}${a.off ? " (switched off)" : ""}`).join(" · ")}. They were found for the old targeting. Keep them and they are still emailed, or remove them and they are never emailed or charged.
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <Button size="sm" variant="primary" loading={saving.isLoading} onClick={() => doSave(true)}>
              Save and remove them
            </Button>
            <Button size="sm" loading={saving.isLoading} onClick={() => doSave(false)}>
              Save and keep them
            </Button>
            <Button size="sm" variant="text" onClick={() => setImpact(null)}>
              Cancel
            </Button>
          </div>
        </Notice>
      ) : null}
      {canManage && dirty && !impact ? (
        <div className="ob-foot glass" style={{ marginTop: 4 }}>
          <span className="spacer muted" style={{ fontSize: 14 }}>
            Saving recounts your market for the new audiences.
          </span>
          <Button variant="text" onClick={() => setEdits(editsOf(data))}>
            Discard
          </Button>
          <Button variant="primary" loading={checking.isLoading || saving.isLoading} disabled={!edits.some((x) => x.on)} onClick={onSave}>
            Save targeting
          </Button>
        </div>
      ) : null}
    </>
  );
}
