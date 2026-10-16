"use client";

import { useEffect, useState } from "react";
import { Button, Chip, Empty, TextField } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/store";
import { errorMessage, useAdminActivateNowMutation, useAdminPoolSettingsQuery, useAdminSavePoolSettingsMutation } from "@/store/api";
import { ago, dateLong, n0 } from "@/lib/format";
import type { AdminPoolView, PoolSettings, PoolWarmingRow } from "@/lib/types";

const WARMUP_DAYS = 29;
const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const day = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long" });

export const DRIVER_TEXT: Record<NonNullable<AdminPoolView["shelf"]["reorderBecause"]["driver"]>, string> = {
  burnReplacement: "domains are burning faster than spare domains go live",
  spareShortfall: "spare domains are below the minimum",
  demandShortfall: "customers are asking for more than the pool can send",
};

/** Burned in the last 30 days: what went, when, why, and how long it lasted. */
export function BurnedTable({ rows }: { rows: AdminPoolView["burned"] }) {
  if (!rows.length)
    return (
      <Empty icon="shield" title="No domain burned in the last 30 days">
        A domain that burns or retires shows here with the reason and the bad rate that decided it.
      </Empty>
    );
  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Burned on</th>
            <th>Why</th>
            <th className="right" title="Hard bounces, plus complaints counted ten times, over the emails that decided it">Bad rate</th>
            <th className="right">Days it lasted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td className="strong mono">
                {b.domain} {b.forcedFromDay !== null ? <Chip tone="r">promoted early, day {b.forcedFromDay}</Chip> : null}
              </td>
              <td>
                {dateLong(b.on)} <span className="m">· {b.kind === "degraded" ? "burned" : "retired"}</span>
              </td>
              <td>{b.reason ?? "not recorded"}</td>
              <td className="num-cell">
                {pct(b.bounceRate)}
                {b.sends !== null ? <span className="m"> of {n0(b.sends)}</span> : null}
              </td>
              <td className="num-cell">{b.daysLasted === null ? "never active" : n0(b.daysLasted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivateDialog({ row, onClose }: { row: PoolWarmingRow; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [go, { isLoading }] = useAdminActivateNowMutation();
  const toast = useToast();
  const ok = reason.trim().length >= 10;
  return (
    <Modal
      title={`Promote ${row.domain} to active now?`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-text btn-sm" onClick={onClose}>
            Keep warming
          </button>
          <Button
            variant="danger"
            size="sm"
            loading={isLoading}
            disabled={!ok}
            onClick={() =>
              go({ id: row.id, reason: reason.trim() })
                .unwrap()
                .then(() => {
                  toast(`${row.domain} is active at full capacity.`, "good");
                  onClose();
                })
                .catch((e) => setErr(errorMessage(e)))
            }
          >
            Promote now
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        It is on {row.status === "AGING" ? "its quiet month and has not started warmup" : `warmup day ${row.warmupDay} of ${WARMUP_DAYS}`}, with a 7-day bounce rate of {pct(row.bounce7)} over {n0(row.sends7)} sends. Promoting it early sends it to full volume before its reputation is built, which raises the risk of burning it.
      </p>
      <p className="fine" style={{ marginTop: 8 }}>
        It is refused anyway if SPF, DKIM or DMARC don&apos;t resolve, if our DKIM signature hasn&apos;t passed the seed test in the last 3 days, or if its 7-day bounce rate is 2% or more.
      </p>
      <label className="au-field" htmlFor="forceReason" style={{ display: "grid", gap: 6, marginTop: 14 }}>
        <span className="muted" style={{ fontSize: 13 }}>Why now? (required, logged with your name)</span>
        <textarea id="forceReason" className="input" rows={3} maxLength={300} value={reason} onChange={(e) => (setReason(e.target.value), setErr(""))} />
      </label>
      {err ? (
        <p className="au-err" role="alert">
          {err}
        </p>
      ) : null}
    </Modal>
  );
}

/** Every domain on the shelf, soonest to go live first. Held ones need an operator to look. */
export function WarmingTable({ rows }: { rows: PoolWarmingRow[] }) {
  const [open, setOpen] = useState<PoolWarmingRow | null>(null);
  if (!rows.length)
    return (
      <Empty icon="flame" title="Nothing warming up">
        Domains you add start a 30-day quiet month, then the ladder.
      </Empty>
    );
  return (
    <>
      <div className="tbl-scroll">
        <table className="tbl pool-warming">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Progress</th>
              <th className="right">Can send today</th>
              <th className="right">Bounce, 7 days</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id} className={w.held ? "held" : ""}>
                <td className="strong mono">
                  {w.domain}
                  {w.held ? (
                    <div>
                      <Chip tone="r">held {w.behindDays} days, look at it</Chip>
                    </div>
                  ) : null}
                </td>
                <td style={{ minWidth: 240 }}>
                  <div className="wu-bar" role="progressbar" aria-valuemin={0} aria-valuemax={WARMUP_DAYS} aria-valuenow={w.warmupDay} aria-label={`${w.domain} warmup`}>
                    <span style={{ width: `${Math.round((w.warmupDay / WARMUP_DAYS) * 100)}%` }} />
                  </div>
                  <small className="m">
                    {w.status === "AGING" ? `quiet month, warmup starts after` : `day ${w.warmupDay} of ${WARMUP_DAYS}`}, active around {day(w.activeOn)}
                  </small>
                </td>
                <td className="num-cell">{n0(w.capToday)}</td>
                <td className="num-cell">
                  {pct(w.bounce7)}
                  <span className="m"> of {n0(w.sends7)}</span>
                </td>
                <td className="right">
                  <Button size="sm" onClick={() => setOpen(w)}>
                    Activate now
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open ? <ActivateDialog row={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** Domains promoted early, kept in view so a later burn can be traced to the decision. */
export function ForcedTable({ rows }: { rows: AdminPoolView["forced"] }) {
  if (!rows.length) return null;
  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Promoted</th>
            <th>Skipped from</th>
            <th>By</th>
            <th>Why</th>
            <th className="right">Bounce, 7 days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id}>
              <td className="strong mono">
                {f.domain} <Chip tone={f.status === "ACTIVE" ? "y" : "r"}>{f.status === "ACTIVE" ? "forced active" : f.status.toLowerCase()}</Chip>
              </td>
              <td className="m">{ago(f.at)}</td>
              <td>{f.fromDay ? `warmup day ${f.fromDay}` : "quiet month"}</td>
              <td className="m">{f.by ?? "unknown"}</td>
              <td>{f.reason}</td>
              <td className="num-cell">{pct(f.bounce7)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The restock targets: the spare shelf floor, the demand margin and the buy limits. */
export function PoolSettingsPanel() {
  const { data } = useAdminPoolSettingsQuery();
  const [save, { isLoading }] = useAdminSavePoolSettingsMutation();
  const toast = useToast();
  const [d, setD] = useState<Omit<PoolSettings, "updatedAt"> | null>(null);
  const fromData = (x: PoolSettings) => ({ spareDomainsMin: x.spareDomainsMin, spareMultiplier: x.spareMultiplier, maxBuyPerBatch: x.maxBuyPerBatch, maxBuyPerDay: x.maxBuyPerDay, autoBuyEnabled: x.autoBuyEnabled });
  useEffect(() => {
    if (data) setD(fromData(data));
  }, [data]);
  if (!data || !d) return null;
  const set = (p: Partial<typeof d>) => setD((x) => (x ? { ...x, ...p } : x));
  const num = (v: string, min: number) => Math.max(min, Number(v) || min);
  const dirty = (Object.keys(d) as (keyof typeof d)[]).some((k) => d[k] !== data[k]);
  return (
    <div className="panel glass">
      <h3>
        Restock targets<small>changed {ago(data.updatedAt)}</small>
      </h3>
      <div className="grid2" style={{ marginTop: 12, alignItems: "start" }}>
        <TextField label="Spare domains, minimum" type="number" min={0} max={500} value={d.spareDomainsMin} onChange={(e) => set({ spareDomainsMin: num(e.target.value, 0) })} hint="Domains bought but not sending yet (aging or warming up) to always have ready" />
        <TextField label="Demand margin" type="number" step={0.05} min={0.5} max={5} value={d.spareMultiplier} onChange={(e) => set({ spareMultiplier: Math.max(0.5, Number(e.target.value) || 1) })} hint="Keep capacity at this multiple of what customers asked for (1.2 means 20% extra)" />
        <TextField label="Most domains per restock" type="number" min={1} max={50} value={d.maxBuyPerBatch} onChange={(e) => set({ maxBuyPerBatch: num(e.target.value, 1) })} hint="A restock request never asks for more than this" />
      </div>
      <p className="fine" style={{ marginTop: 10 }}>
        Nothing is bought automatically. A restock request tells you how many to buy; you buy them and add them on the Domains page.
      </p>
      {dirty ? (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <Button size="sm" variant="text" onClick={() => setD(fromData(data))}>
            Discard
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={isLoading}
            onClick={() =>
              save(d)
                .unwrap()
                .then(() => toast("Restock targets saved.", "good"))
                .catch((e) => toast(errorMessage(e), "bad"))
            }
          >
            Save targets
          </Button>
        </div>
      ) : null}
    </div>
  );
}
