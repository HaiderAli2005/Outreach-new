"use client";

import { Select } from "@/components/ui/Select";
import { useEffect, useMemo, useState } from "react";
import { Button, ErrorState, Field, SkeletonRows, TextField, ViewHead } from "@/components/ui/primitives";
import { useRole, useToast } from "@/store";
import { errorMessage, useCockpitQuery, useSettingsQuery, useUpdateSettingsMutation } from "@/store/api";
import { windowNow } from "@/lib/sendWindow";

const DAYS: [number, string][] = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
];

function useNow(ms: number) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

type Schedule = { sendDays: number[]; sendingWindowStart: string; sendingWindowEnd: string; prospectTimezone: string | null };

/**
 * Setup > Sending schedule. The one place the send days and window are set. Both are in the prospect's own time:
 * an email goes out in their morning, not yours.
 */
export default function SchedulePage() {
  const { data, isLoading, isError, error, refetch } = useSettingsQuery();
  const [save, { isLoading: saving }] = useUpdateSettingsMutation();
  const { canManage } = useRole();
  const { data: cockpit } = useCockpitQuery();
  const now = useNow(30_000);
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<Schedule>>({});
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      return ["UTC"];
    }
  }, []);
  if (isError) return <ErrorState error={error} onRetry={refetch} />;
  if (isLoading || !data) return <SkeletonRows rows={3} h={70} />;
  const saved: Schedule = { sendDays: data.settings.sendDays, sendingWindowStart: data.settings.sendingWindowStart, sendingWindowEnd: data.settings.sendingWindowEnd, prospectTimezone: data.settings.prospectTimezone ?? null };
  const s = { ...saved, ...draft };
  const set = (p: Partial<Schedule>) => setDraft((d) => ({ ...d, ...p }));
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);
  const badWindow = s.sendingWindowStart >= s.sendingWindowEnd;

  return (
    <>
      <ViewHead kicker="Setup" title="Sending schedule" sub="When your campaign's emails go out. Days and hours are in each prospect's own time zone, and sends are spread through the window, never all at once." />
      <fieldset disabled={!canManage} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="panel glass">
          <h3>Days</h3>
          <div className="chips" role="group" aria-label="Sending days" style={{ marginTop: 12 }}>
            {DAYS.map(([d, l]) => {
              const on = s.sendDays.includes(d);
              return (
                <button key={d} type="button" className="pill-btn" aria-pressed={on} disabled={!canManage || (on && s.sendDays.length === 1)} onClick={() => set({ sendDays: on ? s.sendDays.filter((x) => x !== d) : [...s.sendDays, d].sort((a, b) => a - b) })}>
                  {l}
                </button>
              );
            })}
          </div>
          <p className="fine" style={{ marginTop: 8 }}>In the prospect&apos;s own week. Follow-ups that fall on a day off go out on the next sending day.</p>
        </div>
        <div className="panel glass">
          <h3>Hours</h3>
          <div className="grid2" style={{ marginTop: 12, alignItems: "start" }}>
            <TextField label="Sending starts" hint="Their local time" type="time" value={s.sendingWindowStart} onChange={(e) => set({ sendingWindowStart: e.target.value })} />
            <TextField label="Sending ends" hint="Their local time" type="time" value={s.sendingWindowEnd} onChange={(e) => set({ sendingWindowEnd: e.target.value })} error={badWindow ? "Sending has to end after it starts." : null} />
          </div>
          {!badWindow && (s.prospectTimezone || cockpit?.outlook.window.tz) ? (
            (() => {
              const w = windowNow(s.prospectTimezone || cockpit!.outlook.window.tz, s.sendDays, s.sendingWindowStart, s.sendingWindowEnd, now);
              return (
                <p className={`sched-now ${w.open ? "open" : "closed"}`} role="status">
                  <span className="dot" />
                  {w.text}
                  {dirty ? " (with these hours, once saved)" : ""}
                </p>
              );
            })()
          ) : null}
        </div>
        <div className="panel glass">
          <h3>Time zone</h3>
          <div style={{ marginTop: 12 }}>
            <Field label="Your prospects' time zone" htmlFor="ptz" hint="Used only when a person's own location doesn't tell us where they are.">
              <Select id="ptz" className="input" value={s.prospectTimezone ?? ""} onChange={(e) => set({ prospectTimezone: e.target.value || null })}>
                <option value="">From their location (recommended)</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </fieldset>
      {canManage && dirty ? (
        <div className="ob-foot glass" style={{ marginTop: 4 }}>
          <span className="spacer muted" style={{ fontSize: 14 }}>
            Applies to every email still to send.
          </span>
          <Button variant="text" onClick={() => setDraft({})}>
            Discard
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={badWindow}
            onClick={() =>
              save(draft)
                .unwrap()
                .then(() => (setDraft({}), toast("Sending schedule saved", "good")))
                .catch((e) => toast(errorMessage(e), "bad"))
            }
          >
            Save schedule
          </Button>
        </div>
      ) : null}
    </>
  );
}
