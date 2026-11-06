"use client";

import { Select } from "@/components/ui/Select";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Button, Chip, Empty, ErrorState, Field, Notice, Seg, SettingRow, SkeletonRows, Switch, TextArea, TextField, ViewHead } from "@/components/ui/primitives";
import { Confirm, Modal } from "@/components/ui/overlays";
import { useAppDispatch, useAppSelector, useRole, useToast } from "@/store";
import { sessionReceived } from "@/store/authSlice";
import {
  api,
  refreshSession,
  useDeleteWorkspaceMutation,
  errorMessage,
  useAutopilotQuery,
  useChangeRoleMutation,
  useInviteMutation,
  useMembersQuery,
  useOrganizationQuery,
  useSaveVocabMutation,
  useVocabQuery,
  useRemoveCredentialMutation,
  useRemoveMemberMutation,
  useSaveCredentialMutation,
  useSettingsQuery,
  useSourcingUsageQuery,
  useUpdateOrganizationMutation,
  useUpdateSettingsMutation,
  useVerifyEmailMutation,
} from "@/store/api";
import { ago, dateLong, n0, titleCase } from "@/lib/format";
import type { LaunchMode, OrgSettings, Provider, SettingsView, VocabItem } from "@/lib/types";
import Link from "next/link";

/** The languages emails can be written in (the server's list in domain/languages.ts). */
const EMAIL_LANGUAGES: [string, string][] = [
  ["en", "English"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"], ["nl", "Dutch"], ["pt", "Portuguese"],
  ["sv", "Swedish"], ["da", "Danish"], ["no", "Norwegian"], ["fi", "Finnish"], ["pl", "Polish"], ["cs", "Czech"], ["tr", "Turkish"],
  ["ru", "Russian"], ["ar", "Arabic"], ["he", "Hebrew"], ["ja", "Japanese"], ["zh", "Chinese (Simplified)"], ["ko", "Korean"],
];


type Patch = Partial<OrgSettings>;

/**
 * Settings, grouped by the question a user has in mind: what gets sent, what happens with replies, what is printed
 * under every email, who is in the workspace, which tools are connected, and the workspace itself. Each tab opens
 * with one sentence saying what it holds; rarely used controls sit under "Advanced" so the first screen stays short.
 * The keys stay the same so old links (?tab=autopilot, ?tab=brand) keep working.
 */
const TABS = [
  ["autopilot", "Sending", "Who gets emailed, how you approve it, and the pace.", "plane", "Outreach"],
  ["replies", "Replies", "What happens when someone writes back.", "inbox", "Outreach"],
  ["brand", "Email details", "Your company details and the line under every email.", "st-mail", "Outreach"],
  ["team", "Team", "Who can use this workspace and what they can change.", "users", "Workspace"],
  ["integrations", "Integrations", "The tools Aperture uses to find and check people.", "link", "Workspace"],
  ["workspace", "Workspace", "This workspace's name, and deleting it.", "building", "Workspace"],
] as const;
const GROUPS = ["Outreach", "Workspace"] as const;

function Advanced({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="set-adv">
      <summary>{title}</summary>
      <div className="stack">{children}</div>
    </details>
  );
}

function useDraft(view: SettingsView | undefined) {
  const [draft, setDraft] = useState<Patch>({});
  const s = useMemo(() => (view ? { ...view.settings, ...draft } : null), [view, draft]);
  const changed = useMemo(() => {
    if (!view) return {} as Patch;
    const out: Patch = {};
    for (const [k, v] of Object.entries(draft)) {
      if (JSON.stringify(v) !== JSON.stringify((view.settings as unknown as Record<string, unknown>)[k])) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  }, [view, draft]);
  return { s, set: (p: Patch) => setDraft((d) => ({ ...d, ...p })), changed, reset: () => setDraft({}) };
}

function SaveBar({ changed, reset, disabled }: { changed: Patch; reset: () => void; disabled?: boolean }) {
  const [save, { isLoading }] = useUpdateSettingsMutation();
  const toast = useToast();
  const n = Object.keys(changed).length;
  if (!n) return null;
  return (
    <div className="ob-foot glass" style={{ marginTop: 4 }}>
      <span className="spacer muted" style={{ fontSize: 14 }}>
        {n} unsaved change{n === 1 ? "" : "s"}
      </span>
      <Button variant="text" onClick={reset}>
        Discard
      </Button>
      <Button
        variant="primary"
        loading={isLoading}
        disabled={disabled}
        onClick={() =>
          save(changed.proofPoints ? { ...changed, proofPoints: changed.proofPoints.filter((x) => x.claim.trim().length >= 3 && x.source.trim().length >= 3) } : changed)
            .unwrap()
            .then((r) => {
              reset();
              toast("Settings saved", "good");
              void r;
            })
            .catch((e) => toast(errorMessage(e), "bad"))
        }
      >
        Save changes
      </Button>
    </div>
  );
}

function Num({ label, value, onChange, min, max, hint, disabled }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; hint?: ReactNode; disabled?: boolean }) {
  return <TextField label={label} type="number" min={min} max={max} value={value} hint={hint} disabled={disabled} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))} />;
}

function Autopilot({ view, canManage }: { view: SettingsView; canManage: boolean }) {
  const { s, set, changed, reset } = useDraft(view);
  const { data: ap } = useAutopilotQuery();
  const { data: usage } = useSourcingUsageQuery();
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      return [s?.timezone ?? "UTC"];
    }
  }, [s?.timezone]);
  if (!s) return null;
  return (
    <>
      {ap ? (
        <div className="panel glass">
          <h3>
            Status<small>{ap.ready ? "ready to send" : "something below needs setting up"}</small>
          </h3>
          <ul className="checks" style={{ marginTop: 14 }}>
            {ap.readiness.map((r) => (
              <li key={r.key} className={r.ok ? "" : "off"}>
                <Icon id={r.ok ? "check" : "x"} />
                <span>
                  <b>{r.label}</b>
                  {r.optional ? " (optional)" : ""}
                  {!r.ok ? <span className="muted"> · not set up</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <div className="kvgrid" style={{ marginTop: 16 }}>
            <div>
              <small>Emails a day, at most</small>
              <b>{n0(ap.sending.dailyTarget)}</b>
            </div>
            <div>
              <small>Uploaded people waiting</small>
              <b>{n0(ap.sending.csvQueued)}</b>
            </div>
          </div>
        </div>
      ) : null}
      <fieldset disabled={!canManage} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
        <div className="panel glass">
          <h3>
            Approval<small>{s.firstBatchApprovedAt ? `first batch approved ${dateLong(s.firstBatchApprovedAt)}` : "nothing sends until you approve"}</small>
          </h3>
          <div style={{ marginTop: 14 }}>
            <Seg<LaunchMode> label="Before the first emails go out" value={s.launchMode} onChange={(v) => set({ launchMode: v })} options={LAUNCH_MODES.map((x) => ({ value: x.value, label: x.label }))} disabled={!canManage} />
            <p className="fine" style={{ marginTop: 8 }}>{LAUNCH_MODES.find((x) => x.value === s.launchMode)?.desc}</p>
            {!view.consentOnRecord ? <p className="fine" style={{ marginTop: 4 }}>Automatic launch needs your sending confirmation on record first. You give it when you approve your first batch.</p> : null}
            {!s.firstBatchApprovedAt && s.launchMode !== "AUTO" ? (
              <Link className="btn btn-ghost btn-sm" href="/app/approve" style={{ marginTop: 12 }}>
                Review your first 20
              </Link>
            ) : null}
          </div>
          <SettingRow title="Approve new people automatically" desc="After the first batch, people Aperture finds are emailed without waiting for you. Lists you upload never need approving.">
            <Switch label="Approve new people automatically" checked={s.autoApproveBatches} onChange={(v) => set({ autoApproveBatches: v })} disabled={!canManage} />
          </SettingRow>
        </div>
        <div className="panel glass">
          <h3>
            Finding people<small>where new prospects come from</small>
          </h3>
          <SettingRow title="Run every working day" desc="Aperture finds, writes and sends each working day on its own. Off: nothing new starts until you turn it back on.">
            <Switch label="Autopilot" checked={s.autopilotEnabled} onChange={(v) => set({ autopilotEnabled: v })} disabled={!canManage} />
          </SettingRow>
          <SettingRow title="Find new people automatically" desc="Searches for new prospects that match your audience. Off: only the people already on your list are emailed, including anyone you upload.">
            <Switch label="Find new people automatically" checked={s.leadSourcing === "AUTOMATIC"} onChange={(v) => set({ leadSourcing: v ? "AUTOMATIC" : "OFF" })} disabled={!canManage} />
          </SettingRow>
          <SettingRow title="Weekly review" desc="Collects each week's new people into one list for you to approve, instead of a few every day.">
            <Switch label="Weekly review" checked={s.weeklyBatchMode} onChange={(v) => set({ weeklyBatchMode: v })} disabled={!canManage} />
          </SettingRow>
        </div>
        <div className="panel glass">
          <h3>
            Email quality<small>what is checked before anything sends</small>
          </h3>
          <SettingRow title="Personalize every email" desc="Write each first email from the prospect's own details.">
            <Switch label="Personalize" checked={s.personalizationEnabled} onChange={(v) => set({ personalizationEnabled: v })} disabled={!canManage} />
          </SettingRow>
          <SettingRow title="Only send to verified emails" desc="Skip addresses the email checker can't confirm.">
            <Switch label="Verified only" checked={s.requireVerifiedEmail} onChange={(v) => set({ requireVerifiedEmail: v })} disabled={!canManage} />
          </SettingRow>
        </div>
        <div className="panel glass">
          <h3>
            Pace and language<small>the rest of the sending rules</small>
          </h3>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 13.5 }}>
            How much goes out each day is set by your daily budget on the <Link href="/app">dashboard</Link>. Send days and hours are under <Link href="/app/setup/schedule">Sending schedule</Link>.
          </p>
          <SettingRow
            title="Write to each prospect in their own language"
            desc="Each email is written in the main language of the prospect's company website (a German site gets German), else their country's. Off: everyone gets your email language."
          >
            <Switch label="Write to each prospect in their own language" checked={s.matchProspectLanguage !== false} onChange={(v) => set({ matchProspectLanguage: v })} disabled={!canManage} />
          </SettingRow>
          <div className="grid2" style={{ marginTop: 14, alignItems: "start" }}>
            <Num label="Contacts per company" min={1} max={10} value={s.perCompanyContactCap} onChange={(n) => set({ perCompanyContactCap: n })} />
            <Num label="Days before a non-responder is retired" min={3} max={60} value={s.blocklistNoReplyDays} onChange={(n) => set({ blocklistNoReplyDays: n })} />
            <Field label="Your time zone" htmlFor="tz">
              <Select id="tz" className="input" value={s.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={s.matchProspectLanguage !== false ? "Default email language" : "Email language"} htmlFor="lang" hint={s.matchProspectLanguage !== false ? "Used when a prospect's own language can't be told." : undefined}>
              <Select id="lang" className="input" value={s.language} onChange={(e) => set({ language: e.target.value })} disabled={!canManage}>
                {EMAIL_LANGUAGES.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
        <Advanced title="Advanced: limits on lead search credits">
        <div className="panel glass">
          <h3>
            Lead search credits<small>{usage?.pacing.unlimited ? "no monthly cap" : usage ? `${n0(usage.pacing.spentCycle)} used this cycle` : ""}</small>
          </h3>
          <div className="grid3" style={{ marginTop: 14 }}>
            <Num label="Monthly credit cap" min={0} max={10_000_000} value={s.monthlyCreditCap} onChange={(n) => set({ monthlyCreditCap: n })} hint="0 means no cap" />
            <Num label="Daily credit cap" min={0} max={1_000_000} value={s.dailyCreditCap} onChange={(n) => set({ dailyCreditCap: n })} hint="0 means paced from the monthly cap" />
            <Num label="Cycle resets on day" min={1} max={28} value={s.apolloCycleResetDay} onChange={(n) => set({ apolloCycleResetDay: n })} />
          </div>
          <p className="fine" style={{ marginTop: 10 }}>Limits on your lead search account&apos;s own credits. These are separate from your Aperture balance, which pays only for emails sent.</p>
        </div>
        </Advanced>
      </fieldset>
      <SaveBar changed={changed} reset={reset} />
    </>
  );
}

const LAUNCH_MODES: { value: LaunchMode; label: string; desc: string }[] = [
  { value: "APPROVE_FIRST_BATCH", label: "Approve the first 20", desc: "You see your first 20 people and every email they would get, and approve them before anything sends. After that, you approve the people we find, unless Approve new people automatically is on." },
  { value: "APPROVE_EACH", label: "Approve every person", desc: "Nobody is emailed until you approve them and their emails." },
  { value: "AUTO", label: "Automatic", desc: "No first-20 step. People we find still wait for your approval unless Approve new people automatically is on. Your sending confirmation must be on record." },
];


const VOCAB_TONES = [
  ["g", "Green"],
  ["b", "Blue"],
  ["v", "Violet"],
  ["y", "Amber"],
  ["r", "Red"],
  ["n", "Grey"],
] as const;

function StatusVocab({ canManage }: { canManage: boolean }) {
  const { data } = useVocabQuery();
  const [save, saving] = useSaveVocabMutation();
  const [items, setItems] = useState<VocabItem[] | null>(null);
  const [custom, setCustom] = useState("");
  const toast = useToast();
  const list = items ?? data ?? [];
  const dirty = !!items && JSON.stringify(items) !== JSON.stringify(data);
  const move = (i: number, d: -1 | 1) => {
    const next = [...list];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
  };
  return (
    <div className="panel glass">
      <h3>
        Lead statuses<small>what your inbox calls each kind of reply</small>
      </h3>
      <div className="vocab" style={{ marginTop: 12 }}>
        {list.map((v, i) => (
          <div className="vocab-row" key={v.key}>
            <span className="mono vocab-key">{v.key.toLowerCase().replace(/_/g, " ")}</span>
            <input className="input sm" aria-label={`Label for ${v.key}`} value={v.label} maxLength={40} disabled={!canManage} onChange={(e) => setItems(list.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} />
            <Select className="input sm" aria-label={`Colour for ${v.key}`} value={v.color ?? "n"} disabled={!canManage} onChange={(e) => setItems(list.map((x, k) => (k === i ? { ...x, color: e.target.value } : x)))}>
              {VOCAB_TONES.map(([t, l]) => (
                <option key={t} value={t}>
                  {l}
                </option>
              ))}
            </Select>
            <span className="vocab-move">
              <button type="button" className="btn btn-text btn-sm" aria-label="Move up" disabled={!canManage || i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="btn btn-text btn-sm" aria-label="Move down" disabled={!canManage || i === list.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
            </span>
          </div>
        ))}
      </div>
      {canManage ? (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <input className="input sm" style={{ flex: "1 1 200px" }} placeholder="Add your own, e.g. Meeting booked" value={custom} maxLength={40} onChange={(e) => setCustom(e.target.value)} />
          <Button
            size="sm"
            disabled={custom.trim().length < 2}
            onClick={() => {
              const key = custom.trim().toUpperCase().replace(/[^A-Z]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
              if (!key || list.some((x) => x.key === key)) return;
              setItems([...list, { key, label: custom.trim(), color: "b", sortOrder: list.length }]);
              setCustom("");
            }}
          >
            Add status
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty}
            loading={saving.isLoading}
            onClick={() =>
              save({ items: list.map(({ key, label, color }) => ({ key, label: label.trim() || key, color })) })
                .unwrap()
                .then(() => (setItems(null), toast("Statuses saved", "good")))
                .catch((e) => toast(errorMessage(e), "bad"))
            }
          >
            Save statuses
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Replies({ view, canManage }: { view: SettingsView; canManage: boolean }) {
  const { s, set, changed, reset } = useDraft(view);
  const toast = useToast();
  if (!s) return null;
  const perm = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  return (
    <>
      {!view.aiAvailable ? (
        <Notice tone="info" icon="sparkle" title="AI isn't configured on this server">
          Reply sorting and drafted answers need an AI key on the server.
        </Notice>
      ) : null}
      <fieldset disabled={!canManage} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
        <div className="panel glass">
          <h3>Drafted replies</h3>
          <SettingRow title="Draft replies for me" desc="When someone is interested or asks a question, an answer is written for you. You Send, Edit or Discard it.">
            <Switch label="Draft replies" checked={s.draftReplies} onChange={(v) => set({ draftReplies: v })} disabled={!canManage} />
          </SettingRow>
          <p className="fine" style={{ marginTop: 10 }}>
            Nothing is ever sent on its own. There is no timer anywhere: a draft waits for you as long as it takes. Unclear, negative or angry replies never get a draft; they come straight to you.
          </p>
        </div>
      </fieldset>
      <div className="panel glass">
        <h3>
          Notifications<small>this browser only</small>
        </h3>
        <SettingRow title="Tell me when a reply arrives" desc={perm === "denied" ? "Blocked in this browser. Allow notifications for this site in your browser settings." : "A desktop notice for each new reply while Aperture is open."}>
          <Switch
            label="Browser notifications"
            checked={s.browserNotifications}
            disabled={!canManage || perm === "unsupported"}
            onChange={async (v) => {
              if (v && perm === "default") {
                const r = await Notification.requestPermission();
                if (r !== "granted") return toast("Notifications weren't allowed in this browser", "bad");
              }
              set({ browserNotifications: v });
            }}
          />
        </SettingRow>
      </div>
      <Advanced title="Advanced: rename or recolour reply labels">
        <StatusVocab canManage={canManage} />
      </Advanced>
      <SaveBar changed={changed} reset={reset} />
    </>
  );
}

// Sending is managed by Aperture on its own infrastructure, so there is no sending account to connect here.
const PROVIDERS: { key: Provider; name: string; desc: string; placeholder: string }[] = [
  { key: "APOLLO", name: "Apollo", desc: "Finds and enriches leads that match your campaigns.", placeholder: "Apollo API key" },
  { key: "MILLIONVERIFIER", name: "MillionVerifier", desc: "Checks every address before it is emailed.", placeholder: "MillionVerifier API key" },
  { key: "GOOGLE_PLACES", name: "Google Maps", desc: "Finds local businesses (clinics, firms, shops) for campaigns that search Google Maps. A Google Cloud key with the Places API (New) on.", placeholder: "Google Maps Platform API key" },
  { key: "SLACK_WEBHOOK", name: "Slack", desc: "Posts new replies and weekly lists to a channel.", placeholder: "https://hooks.slack.com/services/…" },
];

function CredentialRow({ p, status, canManage }: { p: (typeof PROVIDERS)[number]; status?: SettingsView["credentials"][number]; canManage: boolean }) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [save, saveState] = useSaveCredentialMutation();
  const [remove, removeState] = useRemoveCredentialMutation();
  const toast = useToast();
  return (
    <div className="setting" style={{ alignItems: "flex-start" }}>
      <div className="t">
        <b>
          {p.name}{" "}
          {status?.source === "organization" ? <Chip tone="g">Your own key</Chip> : status?.source === "platform" ? <Chip tone="g">Included</Chip> : <Chip tone="y">Not connected</Chip>}
        </b>
        <small>
          {p.desc}
          {status?.source === "platform" ? " Already works through Aperture's account; nothing to do." : ""}
        </small>
        {status?.masked && status.source === "organization" ? <small className="mono">{status.masked}</small> : null}
        {editing ? (
          <div className="toolbar" style={{ marginTop: 10 }}>
            <input className="input sm grow" type="password" autoComplete="off" placeholder={p.placeholder} value={value} onChange={(e) => setValue(e.target.value)} aria-label={`${p.name} key`} />
            <Button
              size="sm"
              variant="primary"
              loading={saveState.isLoading}
              disabled={value.trim().length < 8}
              onClick={() =>
                save({ provider: p.key, value: value.trim() })
                  .unwrap()
                  .then(() => {
                    setEditing(false);
                    setValue("");
                    toast(`${p.name} connected`, "good");
                  })
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              Save
            </Button>
            <Button size="sm" variant="text" onClick={() => (setEditing(false), setValue(""))}>
              Cancel
            </Button>
          </div>
        ) : null}
      </div>
      {canManage && !editing ? (
        <div style={{ display: "flex", gap: 6 }}>
          <Button size="sm" onClick={() => setEditing(true)}>
            {status?.source === "organization" ? "Replace key" : status?.source === "platform" ? "Use my own key" : "Connect"}
          </Button>
          {status?.source === "organization" ? (
            <Button size="sm" variant="text" loading={removeState.isLoading} onClick={() => remove(p.key).unwrap().then(() => toast(`${p.name} disconnected`, "good")).catch((e) => toast(errorMessage(e), "bad"))}>
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Integrations({ view, canManage }: { view: SettingsView; canManage: boolean }) {
  const { data: org } = useOrganizationQuery(undefined, { skip: !canManage });
  const [email, setEmail] = useState("");
  const [verify, verifyState] = useVerifyEmailMutation();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const hooks = org?.webhookToken
    ? [
        ["Calendly bookings", `${origin}/api/v1/webhooks/calendly/${org.webhookToken}`],
        ["Apollo enrichment", `${origin}/api/v1/webhooks/apollo/${org.webhookToken}`],
      ]
    : [];
  return (
    <>
      <div className="panel glass">
        <h3>
          Connected tools<small>keys are encrypted at rest</small>
        </h3>
        <div style={{ marginTop: 8 }}>
          {PROVIDERS.map((p) => (
            <CredentialRow key={p.key} p={p} status={view.credentials.find((c) => c.provider === p.key)} canManage={canManage} />
          ))}
        </div>
      </div>
      {canManage ? (
        <Advanced title="Advanced: webhook addresses and a live address check">
      {hooks.length ? (
        <div className="panel glass">
          <h3>
            Webhook addresses<small>paste these into each tool, keep them private</small>
          </h3>
          <div className="stack" style={{ marginTop: 12 }}>
            {hooks.map(([l, u]) => (
              <div key={l}>
                <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                  {l}
                </div>
                <div className="toolbar">
                  <code className="code grow">{u}</code>
                  <Button size="xs" onClick={() => navigator.clipboard?.writeText(u)}>
                    Copy
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
        <div className="panel glass">
          <h3>Test an address</h3>
          <p style={{ marginTop: 6 }}>Runs one live check with your email verifier.</p>
          <div className="toolbar" style={{ marginTop: 12 }}>
            <input className="input sm grow" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email to check" />
            <Button size="sm" loading={verifyState.isLoading} disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)} onClick={() => verify({ email }).catch(() => undefined)}>
              Check
            </Button>
          </div>
          {verifyState.data ? (
            <div className={`ok-line ${verifyState.data.ok ? "g" : "w"}`} style={{ marginTop: 12 }}>
              <Icon id={verifyState.data.ok ? "check" : "alert"} />
              <span>
                {titleCase(verifyState.data.result)}
                {verifyState.data.quality ? ` · quality ${verifyState.data.quality}` : ""}
                {verifyState.data.transient ? " · temporary result, try again later" : ""}
              </span>
            </div>
          ) : verifyState.error ? (
            <div className="banner bad" style={{ marginTop: 12 }}>
              {errorMessage(verifyState.error)}
            </div>
          ) : null}
        </div>
        </Advanced>
      ) : null}
    </>
  );
}

function Brand({ view, canManage }: { view: SettingsView; canManage: boolean }) {
  const { s, set, changed, reset } = useDraft(view);
  if (!s) return null;
  return (
    <>
      <fieldset disabled={!canManage} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
        <div className="panel glass">
          <h3>
            Company details<small>used in replies and the footer</small>
          </h3>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 13.5 }}>Emails are signed by the mailbox they go out from, so the name always matches the address.</p>
          <div className="grid2" style={{ marginTop: 14, alignItems: "start" }}>
            <TextField label="Company" hint="Used in replies and the email footer" value={s.senderCompany ?? ""} maxLength={160} onChange={(e) => set({ senderCompany: e.target.value || null })} />
            <TextField label="Booking link" type="url" placeholder="https://cal.com/you/intro" value={s.meetingLink ?? ""} maxLength={500} onChange={(e) => set({ meetingLink: e.target.value || null })} hint="Offered to people who ask to talk" />
          </div>
          <div style={{ marginTop: 14 }}>
            <TextField label="Postal address" hint="Shown in the footer where the law asks for one" value={s.senderAddress ?? ""} maxLength={300} onChange={(e) => set({ senderAddress: e.target.value || null })} />
          </div>
        </div>
        <div className="panel glass">
          <h3>
            Under every email<small>the opt-out line</small>
          </h3>
          <div className="stack" style={{ marginTop: 14 }}>
            <TextField label="Opt-out line" hint="Added under the sign-off of every email" value={s.optOutLine ?? ""} maxLength={300} onChange={(e) => set({ optOutLine: e.target.value || null })} />
            <p className="fine" style={{ margin: 0 }}>
              What you sell, who you sell to, your proof and your tone are in your <Link href="/app/setup/profile">Business profile</Link>, the one record the AI writes every email from.
            </p>
          </div>
        </div>
      </fieldset>
      <SaveBar changed={changed} reset={reset} />
    </>
  );
}

function Team({ canManage }: { canManage: boolean }) {
  const { data: members, isLoading, isError, error, refetch } = useMembersQuery();
  const [invite, inviteState] = useInviteMutation();
  const [changeRole] = useChangeRoleMutation();
  const [remove, removeState] = useRemoveMemberMutation();
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("MEMBER");
  const [link, setLink] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const me = useAppSelector((s) => s.auth.user?.id);
  const toast = useToast();

  return (
    <>
      <div className="tbl-wrap glass">
        <div className="toolbar" style={{ padding: "16px 18px" }}>
          <b style={{ font: "600 17px var(--f-display)" }}>Members</b>
          <span className="grow" />
          {canManage ? (
            <Button size="sm" variant="primary" icon="plus" onClick={() => (setInviting(true), setLink(null), setInviteEmail(""))}>
              Invite
            </Button>
          ) : null}
        </div>
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading || !members ? (
          <SkeletonRows rows={3} />
        ) : members.length ? (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last seen</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <b>{m.name ?? m.email}</b>
                      <div className="m">{m.email}</div>
                    </td>
                    <td>
                      {canManage && m.userId !== me ? (
                        <Select
                          className="select"
                          value={m.role}
                          aria-label="Role"
                          onChange={(e) =>
                            changeRole({ id: m.id, role: e.target.value })
                              .unwrap()
                              .then(() => toast("Role updated", "good"))
                              .catch((er) => toast(errorMessage(er), "bad"))
                          }
                        >
                          <option value="OWNER">Owner</option>
                          <option value="ADMIN">Admin</option>
                          <option value="MEMBER">Member</option>
                        </Select>
                      ) : (
                        titleCase(m.role)
                      )}
                    </td>
                    <td>
                      <Chip tone={m.status === "ACTIVE" ? "g" : "y"}>{m.status === "ACTIVE" ? "Active" : "Invited"}</Chip>
                    </td>
                    <td className="m">{m.lastLoginAt ? ago(m.lastLoginAt) : "never"}</td>
                    <td className="right">
                      {canManage && m.userId !== me ? (
                        <Button size="xs" variant="text" onClick={() => setRemoving(m.id)}>
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="users" title="Just you so far" />
        )}
      </div>
      {inviting ? (
        <Modal
          title="Invite a teammate"
          onClose={() => setInviting(false)}
          actions={
            link ? (
              <Button variant="primary" onClick={() => setInviting(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button variant="text" onClick={() => setInviting(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={inviteState.isLoading}
                  disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteEmail)}
                  onClick={() =>
                    invite({ email: inviteEmail.trim(), role: inviteRole })
                      .unwrap()
                      .then((r) => setLink(`${window.location.origin}/invite?token=${encodeURIComponent(r.inviteToken)}`))
                      .catch((e) => toast(errorMessage(e), "bad"))
                  }
                >
                  Create invite
                </Button>
              </>
            )
          }
        >
          {link ? (
            <div className="stack">
              <p className="muted" style={{ margin: 0 }}>
                Send this link to {inviteEmail}. They sign up or sign in with that email, then accept. It expires in 7 days.
              </p>
              <div className="toolbar">
                <code className="code grow">{link}</code>
                <Button size="xs" onClick={() => navigator.clipboard?.writeText(link)}>
                  Copy
                </Button>
              </div>
            </div>
          ) : (
            <div className="stack">
              <TextField label="Email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
              <Field label="Role" htmlFor="invRole">
                <Select id="invRole" className="input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  <option value="MEMBER">Member · can work the inbox and leads</option>
                  <option value="ADMIN">Admin · can also change settings and billing</option>
                  <option value="OWNER">Owner · full control</option>
                </Select>
              </Field>
            </div>
          )}
        </Modal>
      ) : null}
      {removing ? (
        <Confirm
          title="Remove this member?"
          danger
          confirmLabel="Remove"
          loading={removeState.isLoading}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            remove(removing)
              .unwrap()
              .then(() => {
                setRemoving(null);
                toast("Member removed", "good");
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body="They lose access to this organization right away."
        />
      ) : null}
    </>
  );
}

/**
 * The workspace itself: which one this is, and deleting it. Deleting is for the owner, confirmed by typing the name
 * or website, and frees a place under the five-workspace limit.
 */
function WorkspaceTab() {
  const { role, canManage } = useRole();
  const { data: details } = useOrganizationQuery();
  const [updateOrg, orgState] = useUpdateOrganizationMutation();
  const [name, setName] = useState<string | null>(null);
  const { organizations, activeOrgId } = useAppSelector((s) => s.auth);
  const org = organizations.find((o) => o.id === activeOrgId) ?? null;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [del, { isLoading }] = useDeleteWorkspaceMutation();
  const dispatch = useAppDispatch();
  const router = useRouter();
  const toast = useToast();
  if (!org) return null;
  const label = org.primaryDomain ?? org.name;
  const typed = confirm.trim().toLowerCase();
  const matches = typed === org.name.trim().toLowerCase() || typed === (org.primaryDomain ?? "").toLowerCase();
  const others = organizations.filter((o) => o.id !== org.id);
  return (
    <>
      <div className="panel glass">
        <h3>
          About this workspace<small>{organizations.length} of 5 workspaces used</small>
        </h3>
        <div className="toolbar" style={{ marginTop: 14, alignItems: "flex-end" }}>
          <div className="grow">
            <TextField label="Workspace name" value={name ?? details?.name ?? org.name} disabled={!canManage} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </div>
          {canManage && name !== null && name.trim() && name !== (details?.name ?? org.name) ? (
            <Button
              variant="primary"
              size="sm"
              loading={orgState.isLoading}
              onClick={() =>
                updateOrg({ name: name.trim() })
                  .unwrap()
                  .then(() => {
                    setName(null);
                    toast("Workspace renamed", "good");
                  })
                  .catch((e) => toast(errorMessage(e), "bad"))
              }
            >
              Save
            </Button>
          ) : null}
        </div>
        <p className="fine" style={{ marginTop: 10 }}>
          Website {details?.primaryDomain ?? org.primaryDomain ?? "not set"}
          {details ? ` · created ${dateLong(details.createdAt)}` : ""}. Each website is its own workspace, with its own campaign, balance and settings. Switch between them from the menu at the top left.
        </p>
      </div>
      <div className="panel glass danger-zone">
        <div>
          <h3>Delete this workspace</h3>
          <p className="muted" style={{ marginTop: 6 }}>
            Sending stops at once, the saved card is removed, and the workspace disappears for everyone in it. Any credit left in it is lost. Payment records are kept. This can&apos;t be undone.
          </p>
          {role !== "OWNER" ? <p className="muted" style={{ marginTop: 6 }}>Only an owner can delete a workspace.</p> : null}
        </div>
        <Button size="sm" variant="danger" disabled={role !== "OWNER"} onClick={() => (setOpen(true), setConfirm(""), setErr(""))}>
          Delete workspace
        </Button>
      </div>
      {open ? (
        <Modal
          title={`Delete ${label}?`}
          onClose={() => setOpen(false)}
          actions={
            <>
              <button type="button" className="btn btn-text btn-sm" onClick={() => setOpen(false)}>
                Keep it
              </button>
              <Button
                variant="danger"
                size="sm"
                loading={isLoading}
                disabled={!matches}
                onClick={() =>
                  del({ confirm })
                    .unwrap()
                    .then(async () => {
                      const s = await refreshSession(others[0]?.id ?? null);
                      dispatch(api.util.resetApiState());
                      if (s) dispatch(sessionReceived(s));
                      toast(`${label} is deleted.`, "good");
                      router.push(others.length ? "/app" : "/onboarding");
                    })
                    .catch((e) => setErr(errorMessage(e)))
                }
              >
                Delete workspace
              </Button>
            </>
          }
        >
          <p style={{ margin: 0 }}>Sending stops at once, the saved card is removed, and any credit left in this workspace is lost. This can&apos;t be undone.</p>
          <label className="au-field" htmlFor="delConfirm" style={{ display: "grid", gap: 6, marginTop: 14 }}>
            <span className="muted" style={{ fontSize: 13 }}>
              Type <b>{label}</b> to confirm
            </span>
            <input id="delConfirm" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </label>
          {err ? (
            <p className="au-err" role="alert">
              {err}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}

function Settings() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const tab = params.get("tab") ?? "autopilot";
  const { canManage } = useRole();
  const { data: view, isLoading, isError, error, refetch } = useSettingsQuery();
  const [key, setKey] = useState(0);
  useEffect(() => setKey((k) => k + 1), [tab]);
  const cur = TABS.find(([k]) => k === tab) ?? TABS[0];

  return (
    <>
      <ViewHead kicker="Settings" title="How Aperture works for you." sub={canManage ? undefined : "You can view these settings. Owners and admins can change them."} />
      {/* A side menu, not a row of pills: six sections read as a list you scan down, and the open one stays in view. */}
      <div className="set-layout">
        <nav className="set-nav" role="tablist" aria-orientation="vertical" aria-label="Settings">
          {GROUPS.map((g) => (
            <div key={g} className="set-nav-g">
              <div className="set-nav-h">{g}</div>
              {TABS.filter((t) => t[4] === g).map(([k, l, , icon]) => (
                <button key={k} type="button" role="tab" aria-selected={cur[0] === k} onClick={() => router.replace(`${path}?tab=${k}`, { scroll: false })}>
                  <span className="set-ic">
                    <Icon id={icon} />
                  </span>
                  {l}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="set-pane">
          <div className="set-pane-h">
            <span className="set-ic lg">
              <Icon id={cur[3]} />
            </span>
            <div>
              <h2>{cur[1]}</h2>
              <p>{cur[2]}</p>
            </div>
          </div>
      {isError ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : isLoading || !view ? (
        <SkeletonRows rows={5} h={60} />
      ) : (
        <div className="stack" key={`${tab}-${key}`}>
          {tab === "replies" ? (
            <Replies view={view} canManage={canManage} />
          ) : tab === "integrations" ? (
            <Integrations view={view} canManage={canManage} />
          ) : tab === "brand" ? (
            <Brand view={view} canManage={canManage} />
          ) : tab === "team" ? (
            <Team canManage={canManage} />
          ) : tab === "workspace" ? (
            <WorkspaceTab />
          ) : (
            <Autopilot view={view} canManage={canManage} />
          )}
        </div>
      )}
        </div>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<SkeletonRows rows={5} />}>
      <Settings />
    </Suspense>
  );
}
