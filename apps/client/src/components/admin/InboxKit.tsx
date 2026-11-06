"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Chip, Field, PasswordInput, Seg, Switch, TextField } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/store";
import {
  errorMessage,
  fieldErrors,
  useAdminInboxKitKeyMutation,
  useAdminInboxKitOrderMutation,
  useAdminInboxKitPipelineQuery,
  useAdminInboxKitPlanQuery,
  useAdminInboxKitQuery,
  useAdminInboxKitQuoteMutation,
  useAdminInboxKitSettingsMutation,
  useAdminInboxKitSyncMutation,
} from "@/store/api";
import { dateLong, dateTime, n0 } from "@/lib/format";
import { LOCALES, REGIONS } from "@/lib/poolOptions";
import { countries } from "@/lib/countries";
import type { InboxKitContact, InboxKitPlan, InboxKitSettingsPatch, InboxKitStatus, PipelineDomain, PipelineStage, SupplierOrder } from "@/lib/types";

/**
 * Admin > Domains, InboxKit: the setup card, "Order new domains" (how many, the price check, one confirmation) and the
 * board that follows every ordered domain from InboxKit's setup through its warmup to sending.
 */

const usd = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? "–" : `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);

// ─── Setup ──────────────────────────────────────────────────────────────────────────────────────────────────────

const CONTACT_FIELDS: { key: keyof InboxKitContact; label: string; placeholder?: string; required?: boolean }[] = [
  { key: "first_name", label: "First name", required: true },
  { key: "last_name", label: "Last name", required: true },
  { key: "email", label: "Email", placeholder: "ops@yourcompany.com", required: true },
  { key: "phone", label: "Phone, with country code", placeholder: "+92 300 1234567", required: true },
  { key: "organization", label: "Company" },
  { key: "address_line1", label: "Address", required: true },
  { key: "address_line2", label: "Address line 2" },
  { key: "city", label: "City", required: true },
  { key: "state", label: "State or province", required: true },
  { key: "country", label: "Country", required: true },
  { key: "postal_code", label: "Postal code", required: true },
];

function SetupForm({ data, onSaved }: { data: InboxKitStatus; onSaved?: () => void }) {
  const s = data.settings;
  const [save, { isLoading }] = useAdminInboxKitSettingsMutation();
  const toast = useToast();
  const [workspace, setWorkspace] = useState(s.workspaceUid ?? "");
  const [contact, setContact] = useState<Partial<InboxKitContact>>(s.contact ?? {});
  const [redirectUrl, setRedirectUrl] = useState(s.redirectUrl ?? "");
  const [platform, setPlatform] = useState(s.platform);
  const [warmupDays, setWarmupDays] = useState(String(s.warmupDays));
  const [keepWarmup, setKeepWarmup] = useState(s.keepWarmupAfterLive);
  const [maxPrice, setMaxPrice] = useState(String(s.maxDomainPriceUsd));
  const [err, setErr] = useState("");
  /** Problems by field, from the checks below or from the server: "contact.city", "redirectUrl", ... */
  const [bad, setBad] = useState<Record<string, string>>({});

  /** The same rules the server applies, checked before saving so each problem shows under its own field. */
  const check = (): Record<string, string> => {
    const out: Record<string, string> = {};
    // Saving part of it is fine (what is still missing is listed below the form); what is typed must be valid.
    const c = { ...(s.contact ?? {}), ...contact };
    if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.email).trim())) out["contact.email"] = "An email address, for example ops@yourcompany.com";
    if (c.phone && !/^\+?[0-9 ().-]{6,20}$/.test(String(c.phone).trim())) out["contact.phone"] = "Digits with the country code, for example +92 300 1234567";
    if (c.country && !/^[A-Z]{2}$/.test(String(c.country))) out["contact.country"] = "Choose the country from the list";
    if (redirectUrl.trim() && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(redirectUrl.trim())) out.redirectUrl = "A full web address starting with https://, for example https://yourcompany.com";
    if (!Number.isInteger(Number(warmupDays)) || Number(warmupDays) < 14 || Number(warmupDays) > 90) out.warmupDays = "14 to 90 days";
    if (!(Number(maxPrice) >= 5 && Number(maxPrice) <= 100)) out.maxDomainPriceUsd = "$5 to $100";
    return out;
  };

  const patch = (): InboxKitSettingsPatch => {
    const p: InboxKitSettingsPatch = {};
    if (workspace && workspace !== s.workspaceUid) p.workspaceUid = workspace;
    const changed = Object.fromEntries(Object.entries(contact).filter(([k, v]) => (v ?? "") !== ((s.contact ?? {})[k as keyof InboxKitContact] ?? "") && String(v ?? "").trim())) as Partial<InboxKitContact>;
    if (Object.keys(changed).length) p.contact = changed;
    if (redirectUrl.trim() && redirectUrl.trim() !== s.redirectUrl) p.redirectUrl = redirectUrl.trim();
    if (platform !== s.platform) p.platform = platform;
    if (Number(warmupDays) !== s.warmupDays) p.warmupDays = Number(warmupDays);
    if (keepWarmup !== s.keepWarmupAfterLive) p.keepWarmupAfterLive = keepWarmup;
    if (Number(maxPrice) !== s.maxDomainPriceUsd) p.maxDomainPriceUsd = Number(maxPrice);
    return p;
  };
  const dirty = Object.keys(patch()).length > 0;

  /** What is still empty and needed before ordering, marked on the field itself (not only in the list below). */
  const NEEDED = "Needed before you can order";
  const saved = s.contact ?? {};
  const needed: Record<string, string> = {};
  if (!workspace) needed.workspace = "Choose one. Needed before you can order";
  if (!redirectUrl.trim()) needed.redirectUrl = NEEDED;
  for (const f of CONTACT_FIELDS) if (f.required && !String(contact[f.key] ?? saved[f.key] ?? "").trim()) needed[`contact.${f.key}`] = NEEDED;
  const contactIncomplete = CONTACT_FIELDS.some((f) => needed[`contact.${f.key}`]);
  const show = (k: string) => bad[k] ?? needed[k];

  return (
    <div className="stack">
      <div className="dm-grid3">
        <Field label="Workspace new domains go into" htmlFor="ik-ws" error={needed.workspace}>
          <Select id="ik-ws" className="input" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            <option value="">Choose a workspace</option>
            {data.workspaces.map((w) => (
              <option key={w.uid} value={w.uid}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <TextField label="Each domain forwards to" hint="Where a domain goes when someone opens it in a browser. Use your company website." placeholder="https://yourcompany.com" value={redirectUrl} error={show("redirectUrl")} onChange={(e) => setRedirectUrl(e.target.value)} />
        <Field label="Mailbox type" htmlFor="ik-platform">
          <Seg
            label="Mailbox type"
            value={platform}
            onChange={setPlatform}
            options={[
              { value: "GOOGLE", label: "Google Workspace" },
              { value: "MICROSOFT", label: "Microsoft 365" },
            ]}
          />
        </Field>
      </div>
      <details className="dm-more" open={contactIncomplete}>
        <summary>Registrant contact InboxKit registers every domain with</summary>
        <div className="dm-grid3" style={{ marginTop: 10 }}>
          {CONTACT_FIELDS.map((f) =>
            f.key === "country" ? (
              <Field key={f.key} label={f.label} htmlFor="ik-country" error={show("contact.country")}>
                <Select id="ik-country" className="input" value={contact.country ?? ""} searchable onChange={(e) => setContact((c) => ({ ...c, country: e.target.value }))}>
                  <option value="">Choose a country</option>
                  {countries().map((k) => (
                    <option key={k.code} value={k.code}>
                      {k.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <TextField key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`} placeholder={f.placeholder} value={contact[f.key] ?? ""} error={show(`contact.${f.key}`)} onChange={(e) => setContact((c) => ({ ...c, [f.key]: e.target.value }))} />
            ),
          )}
        </div>
      </details>
      <details className="dm-more">
        <summary>Warmup and price rules</summary>
        <div className="dm-grid3" style={{ marginTop: 10 }}>
          <TextField label="Days of InboxKit warmup before sending" type="number" min={14} max={90} value={warmupDays} error={bad.warmupDays} onChange={(e) => setWarmupDays(e.target.value)} hint="28 recommended. Sending then starts at 10 a mailbox a day, then 20 and 30." />
          <TextField label="Highest price for a domain, per year" type="number" min={5} max={100} value={maxPrice} error={bad.maxDomainPriceUsd} onChange={(e) => setMaxPrice(e.target.value)} hint="Names that cost more are skipped." />
          <Field label="Keep InboxKit warmup on once a domain sends">
            <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 40 }}>
              <Switch checked={keepWarmup} onChange={setKeepWarmup} label="Keep InboxKit warmup on once a domain sends" />
              <small className="muted">{keepWarmup ? "On: keeps reputation up, $3 a mailbox a month." : "Off: saves $3 a mailbox a month, more risk of burns."}</small>
            </div>
          </Field>
        </div>
      </details>
      {err ? (
        <div className="banner bad" role="alert">
          {err}
        </div>
      ) : null}
      <div className="dm-actions">
        <Button
          size="sm"
          variant="primary"
          loading={isLoading}
          onClick={() => {
            setErr("");
            if (!dirty) {
              setErr(Object.keys(needed).length ? "Nothing new to save yet. Fill in the fields marked as needed, then save." : "Nothing has changed.");
              return;
            }
            const problems = check();
            setBad(problems);
            if (Object.keys(problems).length) {
              setErr(`Fix the ${Object.keys(problems).length === 1 ? "field" : `${Object.keys(problems).length} fields`} marked in red.`);
              return;
            }
            save(patch())
              .unwrap()
              .then((r) => {
                // Saved; say plainly if something is still missing, so it never looks like nothing happened.
                toast(r.blockers.length ? `Saved. Still needed before you can order: ${r.blockers.length} item${r.blockers.length === 1 ? "" : "s"} (listed below).` : "Saved. InboxKit is ready: you can order new domains.", r.blockers.length ? "bad" : "good");
                onSaved?.();
              })
              .catch((e) => {
                setBad(fieldErrors(e));
                setErr(errorMessage(e));
              });
          }}
        >
          Save settings
        </Button>
      </div>
    </div>
  );
}

/** The InboxKit card: API key, workspace, registrant contact, warmup rules. Folded once everything is set. */
export function InboxKitSetup() {
  const { data, isError, refetch } = useAdminInboxKitQuery();
  const [saveKey, { isLoading: savingKey }] = useAdminInboxKitKeyMutation();
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();
  if (isError)
    return (
      <div className="banner bad" style={{ marginBottom: 16 }}>
        InboxKit settings didn't load.{" "}
        <button type="button" className="btn btn-text btn-xs" onClick={() => refetch()}>
          Try again
        </button>
      </div>
    );
  if (!data) return null;
  const ready = data.connected && !data.blockers.length;
  const showKey = !data.key.set || replacing || (data.key.set && !data.connected);
  return (
    <details className="dm-card glass" open={!ready} style={{ marginBottom: 16 }}>
      <summary className="dm-title" style={{ cursor: "pointer" }}>
        <b>InboxKit</b>
        <Chip tone={ready ? "g" : data.error ? "r" : "y"}>{ready ? "Ready" : data.error ? "Can't connect" : "Needs setup"}</Chip>
        <span className="muted">Orders new domains with 3 mailboxes each and InboxKit warmup</span>
      </summary>
      <div className="stack" style={{ marginTop: 12 }}>
        {data.connected ? (
          <div className="dm-meta">
            <span>
              Wallet <b className="num">{usd(data.wallet)}</b>
            </span>
            <span>
              Mailbox {usd(data.prices.mailboxMonthUsd)} a month{data.prices.estimated ? "*" : ""}
            </span>
            <span>
              Warmup {usd(data.prices.warmupMonthUsd)} a mailbox a month{data.prices.estimated ? "*" : ""}
            </span>
            {data.settings.workspaceName ? <span>Workspace {data.settings.workspaceName}</span> : null}
            <span>Key {data.key.source === "env" ? "from the server environment" : "saved"}</span>
          </div>
        ) : null}
        {data.error ? (
          <div className="banner bad" role="alert">
            {data.error}
          </div>
        ) : null}
        {showKey ? (
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>
              Paste your InboxKit API key (InboxKit, Settings, API). Aperture checks it with InboxKit, keeps it in the secret store and never shows it again.
            </p>
            <div className="dm-grid3">
              <Field label="InboxKit API key" htmlFor="ik-key">
                <PasswordInput id="ik-key" value={key} autoComplete="off" onChange={(e) => setKey(e.target.value)} />
              </Field>
            </div>
            {err ? (
              <div className="banner bad" role="alert">
                {err}
              </div>
            ) : null}
            <div className="dm-actions">
              <Button
                size="sm"
                variant="primary"
                loading={savingKey}
                disabled={key.trim().length < 16}
                onClick={() => {
                  setErr("");
                  saveKey({ key: key.trim() })
                    .unwrap()
                    .then(() => {
                      setKey("");
                      setReplacing(false);
                      toast("InboxKit is connected.", "good");
                    })
                    .catch((e) => setErr(errorMessage(e)));
                }}
              >
                Save key
              </Button>
              {replacing ? (
                <Button size="sm" variant="text" onClick={() => setReplacing(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {data.connected ? <SetupForm key={JSON.stringify(data.settings)} data={data} /> : null}
        {data.blockers.length ? (
          <div className="dm-dnshelp">
            <b>Before you can order</b>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {data.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ol>
          </div>
        ) : null}
        {data.connected && !showKey ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {data.prices.estimated ? <>* InboxKit's published price; your account's own price shows once InboxKit reports it. </> : null}
            {/localhost|127\.0\.0\.1/.test(data.webhook.url) ? (
              <>InboxKit can't reach this computer, so while you test locally new domains update every 10 minutes from InboxKit instead of instantly. </>
            ) : (
              <>
                Status updates arrive at <span className="mono">{data.webhook.url}</span> (set on the workspace automatically) and are read back from InboxKit every 10 minutes either way.{" "}
              </>
            )}
            <button type="button" className="btn btn-text btn-xs" onClick={() => setReplacing(true)}>
              Replace the key
            </button>
          </p>
        ) : null}
      </div>
    </details>
  );
}

// ─── Order new domains ──────────────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n0(n)} ${n === 1 ? one : many}`;

/** The suggestion, worked out line by line from the pool's own numbers (server: orders.ts orderPlan). */
function PlanMaths({ plan }: { plan: InboxKitPlan }) {
  const m = plan.maths;
  const rows: [string, string, string][] = [
    ["Needed for customers", `${n0(m.committedPerDay)} emails a day ÷ ${m.perMailbox} per mailbox`, `${n0(m.neededMailboxes)}`],
    ["Spare", `${Math.round(m.spareShare * 100)}% on top`, `+ ${n0(m.spareMailboxes)}`],
    [
      "Expected to burn before new ones send",
      m.weeklyBurnDomains > 0 ? `${m.weeklyBurnDomains} domains a week × ${m.weeksToSend} weeks × 3` : "none measured yet (no domain has burned)",
      `+ ${n0(m.burnMailboxes)}`,
    ],
    ["Already sending", "mailboxes in rotation now", `− ${n0(m.sendingMailboxes)}`],
    ["Already bought, not sending yet", "setting up, DNS or warming", `− ${n0(m.onTheWayMailboxes)}`],
    ["Already ordered", "in an order, not at InboxKit yet", `− ${n0(m.orderedMailboxes)}`],
  ];
  return (
    <div className="ik-cost" aria-label="How the suggestion is worked out">
      {rows.map(([label, how, value]) => (
        <div key={label}>
          <span>
            {label} <small className="muted">· {how}</small>
          </span>
          <b className="num">{value}</b>
        </div>
      ))}
      <div className="ik-total">
        <span>Mailboxes short {m.shortMailboxes ? `· ${n0(m.shortMailboxes)} ÷ 3 per domain, rounded up` : ""}</span>
        <b className="num">
          {n0(m.shortMailboxes)} → {plural(plan.suggested.domains, "domain")}
        </b>
      </div>
    </div>
  );
}

function PlanStep({ plan, count, setCount, region, setRegion, locale, setLocale }: { plan: InboxKitPlan; count: string; setCount: (v: string) => void; region: string; setRegion: (v: string) => void; locale: string; setLocale: (v: string) => void }) {
  const n = plan.suggested.domains;
  return (
    <div className="stack">
      <div className="ik-suggest">
        {n > 0 ? (
          <>
            <div className="ik-big num">{n0(n)}</div>
            <div>
              <b>
                {n === 1 ? "domain" : "domains"} suggested ({plural(plan.suggested.mailboxes, "mailbox", "mailboxes")})
              </b>
              <div className="muted">
                Customers have {n0(plan.maths.committedPerDay)} emails a day committed; the pool sends {n0(plan.pool.capacityPerDay)} a day today. Worked out below from your pool's own numbers.
              </div>
            </div>
          </>
        ) : (
          <div>
            <b>{plan.maths.committedPerDay ? "The pool already covers what customers committed." : "No customer is sending yet, so nothing is needed."}</b>
            <div className="muted">Order more only if you expect new customers soon. Each new domain takes about {plan.maths.weeksToSend} weeks to send at full speed.</div>
          </div>
        )}
      </div>
      <PlanMaths plan={plan} />
      <div className="dm-grid3">
        <TextField label="How many domains to order" type="number" min={1} max={plan.limits.perQuote} value={count} onChange={(e) => setCount(e.target.value)} hint={`3 mailboxes each. Up to ${plan.limits.perQuote} per order.`} />
        <Field label="Market they send to" htmlFor="ik-region">
          <Select id="ik-region" className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Language of the sender names" htmlFor="ik-locale">
          <Select id="ik-locale" className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>
            {LOCALES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Ordered {plan.limits.perBatch} at a time and at most {plan.limits.perDay} a day ({plan.limits.placedToday} today so far), so a big order never looks like a spam batch. The rest goes out on the next days by itself. Change the limits on Admin, Pool, Settings.
      </p>
    </div>
  );
}

function QuoteStep({ order }: { order: SupplierOrder }) {
  const e = order.estimate;
  const firstBatch = e.schedule[0] ? (e.firstMonthUsd * e.schedule[0].domains) / Math.max(1, e.domains) : e.firstMonthUsd;
  const walletShort = e.walletUsd !== null && e.walletUsd < firstBatch;
  const [left, setLeft] = useState(() => new Date(order.expiresAt).getTime() - Date.now());
  useEffect(() => {
    const t = setInterval(() => setLeft(new Date(order.expiresAt).getTime() - Date.now()), 1000);
    return () => clearInterval(t);
  }, [order.expiresAt]);
  return (
    <div className="stack">
      {order.short ? (
        <div className="banner info">
          InboxKit had clean names for {e.domains} of the {e.domains + order.short} asked for right now. Order these, then check again for the rest.
        </div>
      ) : null}
      <div className="ik-cost">
        <div>
          <span>Domains, first year ({n0(e.domains)} × {usd(e.unit.avgDomainUsd)})</span>
          <b className="num">{usd(e.domainsUsd)}</b>
        </div>
        <div>
          <span>
            Mailboxes ({n0(e.mailboxes)} × {usd(e.unit.mailboxMonthUsd)} a month)
          </span>
          <b className="num">{usd(e.mailboxMonthUsd)}</b>
        </div>
        <div>
          <span>
            InboxKit warmup ({n0(e.mailboxes)} × {usd(e.unit.warmupMonthUsd)} a month)
          </span>
          <b className="num">{usd(e.warmupMonthUsd)}</b>
        </div>
        <div className="ik-total">
          <span>First charge, from the InboxKit wallet</span>
          <b className="num">{usd(e.firstMonthUsd)}</b>
        </div>
        <div>
          <span>Then every month</span>
          <b className="num">{usd(e.perMonthUsd)}</b>
        </div>
        <div>
          <span>Mailbox cost per email once sending (30 a day, 22 days)</span>
          <b className="num">{e.perEmailUsd === null ? "–" : `$${e.perEmailUsd.toFixed(4)}`}</b>
        </div>
      </div>
      {e.unit.estimated ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Mailbox and warmup prices are InboxKit's published prices: your account didn't report its own. InboxKit charges its exact price when the order goes out.
        </p>
      ) : null}
      <div className="dm-meta">
        <span>Wallet {usd(e.walletUsd)}</span>
        <span>Goes out: {e.schedule.map((s) => `${n0(s.domains)} on ${dateLong(s.day)}`).join(", ")}</span>
        <span>{left > 0 ? `Price held ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}` : "Price check expired"}</span>
      </div>
      {walletShort ? (
        <div className="banner bad" role="alert">
          The InboxKit wallet ({usd(e.walletUsd)}) doesn't cover the first batch (about {usd(firstBatch)}). You can still confirm: the order waits and goes out by itself once you top up InboxKit.
        </div>
      ) : null}
      <div className="tbl-scroll">
        <table className="tbl dm-tbl" style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th>Domain</th>
              <th className="right">A year</th>
              <th>Mailboxes</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((i) => (
              <tr key={i.id}>
                <td className="dm-addr">{i.domain}</td>
                <td className="num-cell">{usd(i.priceUsd)}</td>
                <td>
                  <small className="muted">{i.mailboxes.map((m) => m.email).join(", ")}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DoneStep({ order }: { order: SupplierOrder }) {
  return (
    <div className="stack">
      <div className={`banner ${order.lastError && !order.placed ? "bad" : "info"}`}>
        {order.placed ? `${n0(order.placed)} domain${order.placed === 1 ? "" : "s"} ordered at InboxKit now.` : "Nothing ordered yet."} {order.pending ? `${n0(order.pending)} more go out by themselves${order.nextRunAt ? `, next ${dateLong(order.nextRunAt)}` : ""}.` : ""}
        {order.lastError ? ` ${order.lastError}` : ""}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        InboxKit now builds the mailboxes and sets SPF, DKIM and DMARC. Aperture signs each mailbox in by itself, waits out the InboxKit warmup, then starts it at 10 emails a day, then 20 and 30. Follow every domain on the board below.
      </p>
    </div>
  );
}

/**
 * What still stops ordering, filled in right here in the order window: only the missing fields are shown, and once
 * they are saved the price check unlocks without leaving the window.
 */
function FinishSetup({ blockers }: { blockers: string[] }) {
  const { data } = useAdminInboxKitQuery();
  const [save, { isLoading }] = useAdminInboxKitSettingsMutation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [bad, setBad] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const toast = useToast();
  const s = data?.settings;
  if (!data || !s || !data.connected) {
    return (
      <div className="dm-dnshelp" style={{ marginBottom: 12 }}>
        <b>Finish the InboxKit setup first</b>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ol>
      </div>
    );
  }
  const saved = (s.contact ?? {}) as Partial<InboxKitContact>;
  const missingContact = CONTACT_FIELDS.filter((f) => f.required && !String(saved[f.key] ?? "").trim());
  const needWorkspace = !s.workspaceUid;
  const needRedirect = !s.redirectUrl;
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));
  const filled = (!needWorkspace || !!values.workspace) && (!needRedirect || !!values.redirectUrl?.trim()) && missingContact.every((f) => (values[f.key] ?? "").trim());

  const submit = () => {
    setErr("");
    const patch: InboxKitSettingsPatch = {};
    if (needWorkspace) patch.workspaceUid = values.workspace;
    if (needRedirect) patch.redirectUrl = values.redirectUrl.trim();
    if (missingContact.length) patch.contact = Object.fromEntries(missingContact.map((f) => [f.key, values[f.key].trim()])) as Partial<InboxKitContact>;
    save(patch)
      .unwrap()
      .then((r) => {
        setBad({});
        if (!r.blockers.length) toast("InboxKit is ready. Check names and price now.", "good");
      })
      .catch((e) => {
        setBad(fieldErrors(e));
        setErr(errorMessage(e));
      });
  };

  return (
    <div className="dm-dnshelp stack" style={{ marginBottom: 12 }}>
      <b>Finish the InboxKit setup here, then check names and price</b>
      <div className="dm-grid3">
        {needWorkspace ? (
          <Field label="Workspace new domains go into" htmlFor="ik-fs-ws">
            <Select id="ik-fs-ws" className="input" value={values.workspace ?? ""} onChange={(e) => set("workspace", e.target.value)}>
              <option value="">Choose a workspace</option>
              {data.workspaces.map((w) => (
                <option key={w.uid} value={w.uid}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {needRedirect ? <TextField label="Each domain forwards to" placeholder="https://yourcompany.com" value={values.redirectUrl ?? ""} error={bad.redirectUrl} onChange={(e) => set("redirectUrl", e.target.value)} /> : null}
        {missingContact.map((f) =>
          f.key === "country" ? (
            <Field key={f.key} label="Country" htmlFor="ik-fs-country" error={bad["contact.country"]}>
              <Select id="ik-fs-country" className="input" searchable value={values.country ?? ""} onChange={(e) => set("country", e.target.value)}>
                <option value="">Choose a country</option>
                {countries().map((k) => (
                  <option key={k.code} value={k.code}>
                    {k.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <TextField key={f.key} label={f.label} placeholder={f.placeholder} value={values[f.key] ?? ""} error={bad[`contact.${f.key}`]} onChange={(e) => set(f.key, e.target.value)} />
          ),
        )}
      </div>
      {err ? (
        <div className="banner bad" role="alert">
          {err}
        </div>
      ) : null}
      <div className="dm-actions">
        <Button size="sm" variant="primary" loading={isLoading} disabled={!filled} onClick={submit}>
          Save and continue
        </Button>
      </div>
    </div>
  );
}

/** "Order new domains": how many (with the pool's suggestion), the price check, one confirmation. */
export function OrderDomainsModal({ onClose }: { onClose: () => void }) {
  const { data: plan, isLoading: planLoading, error: planError } = useAdminInboxKitPlanQuery(undefined, { refetchOnMountOrArgChange: true });
  const [quote, { isLoading: quoting }] = useAdminInboxKitQuoteMutation();
  const [act, { isLoading: acting }] = useAdminInboxKitOrderMutation();
  const [count, setCount] = useState("");
  const [region, setRegion] = useState("global");
  const [locale, setLocale] = useState("en");
  const [order, setOrder] = useState<SupplierOrder | null>(null);
  const [err, setErr] = useState("");
  const toast = useToast();

  useEffect(() => {
    if (plan && !count) setCount(String(Math.min(plan.limits.perQuote, Math.max(1, plan.suggested.domains || 1))));
  }, [plan, count]);

  const n = Number(count);
  const valid = Number.isInteger(n) && n >= 1 && n <= (plan?.limits.perQuote ?? 50);
  const step = !order ? "plan" : order.status === "QUOTED" ? "quote" : "done";
  const blocked = plan?.blockers.length ? plan.blockers : null;

  const check = () => {
    setErr("");
    quote({ domains: n, region, locale })
      .unwrap()
      .then(setOrder)
      .catch((e) => setErr(errorMessage(e)));
  };
  const confirm = () => {
    if (!order) return;
    setErr("");
    act({ id: order.id, action: "confirm" })
      .unwrap()
      .then((o) => {
        setOrder(o);
        toast(o.placed ? `${o.placed} domain${o.placed === 1 ? "" : "s"} ordered at InboxKit.` : "Order confirmed. It goes out by itself.", "good");
      })
      .catch((e) => setErr(errorMessage(e)));
  };

  const actions =
    step === "plan" ? (
      <>
        <Button variant="text" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={quoting} disabled={!plan || !valid || !!blocked} onClick={check}>
          {quoting ? "Checking names at InboxKit…" : "Check names and price"}
        </Button>
      </>
    ) : step === "quote" ? (
      <>
        <Button variant="text" onClick={() => setOrder(null)}>
          Back
        </Button>
        <Button variant="primary" loading={acting} disabled={new Date(order!.expiresAt).getTime() < Date.now()} onClick={confirm}>
          Order {n0(order!.estimate.domains)} domain{order!.estimate.domains === 1 ? "" : "s"} · {usd(order!.estimate.firstMonthUsd)}
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    );

  return (
    <Modal wide title={step === "plan" ? "Order new domains" : step === "quote" ? "Check and confirm" : "Ordered"} onClose={onClose} actions={actions}>
      {planLoading ? <p className="muted">Working out what the pool needs…</p> : null}
      {planError ? (
        <div className="banner bad" role="alert">
          {errorMessage(planError)}
        </div>
      ) : null}
      {blocked && step === "plan" ? <FinishSetup blockers={blocked} /> : null}
      {plan && step === "plan" ? <PlanStep plan={plan} count={count} setCount={setCount} region={region} setRegion={setRegion} locale={locale} setLocale={setLocale} /> : null}
      {order && step === "quote" ? <QuoteStep order={order} /> : null}
      {order && step === "done" ? <DoneStep order={order} /> : null}
      {err ? (
        <div className="banner bad" role="alert" style={{ marginTop: 12 }}>
          {err}
        </div>
      ) : null}
    </Modal>
  );
}

// ─── The board ──────────────────────────────────────────────────────────────────────────────────────────────────

const STAGE_ORDER: PipelineStage[] = ["setting_up", "dns", "warmup_booked", "warming", "held", "ladder", "live", "burned"];
const STAGE_SHORT: Record<PipelineStage, string> = { setting_up: "Setting up", dns: "DNS", warmup_booked: "Warmup booked", warming: "Warming", held: "Held", ladder: "Starting", live: "Sending", burned: "Burned" };
const STAGE_TONE: Record<PipelineStage, "g" | "b" | "v" | "y" | "r"> = { setting_up: "y", dns: "y", warmup_booked: "v", warming: "b", held: "r", ladder: "b", live: "g", burned: "r" };
const HEALTH_TONE: Record<string, string> = { excellent: "ok", good: "ok", warning: "warn", critical: "bad" };
const ORDER_LABEL: Record<SupplierOrder["status"], string> = { QUOTED: "Price checked", SCHEDULED: "Ordering", WAITING_FOR_FUNDS: "Waiting for the InboxKit wallet", DONE: "Done", PARTIAL: "Done, some rejected", FAILED: "Failed", CANCELLED: "Cancelled", EXPIRED: "Expired" };
const ORDER_TONE: Record<SupplierOrder["status"], "g" | "b" | "v" | "y" | "r"> = { QUOTED: "v", SCHEDULED: "b", WAITING_FOR_FUNDS: "r", DONE: "g", PARTIAL: "y", FAILED: "r", CANCELLED: "v", EXPIRED: "v" };

function progressText(d: PipelineDomain): string {
  if (d.stage === "warming" && d.day && d.of) return `Day ${d.day} of ${d.of}${d.readyOn ? ` · starts sending about ${dateLong(d.readyOn)}` : ""}`;
  if (d.stage === "ladder" && d.day && d.of) return `Day ${d.day} of ${d.of} on the ramp · ${d.note ?? ""}${d.readyOn ? ` · full speed about ${dateLong(d.readyOn)}` : ""}`;
  if (d.stage === "warmup_booked") return "Warmup starts once InboxKit finishes every mailbox";
  return d.note ?? "";
}

function DomainRow({ d }: { d: PipelineDomain }) {
  const pct = d.day && d.of ? Math.min(100, Math.round((d.day / d.of) * 100)) : d.stage === "live" ? 100 : 0;
  return (
    <div className="ik-row">
      <div className="ik-name">
        <b>{d.name}</b>
        <Chip tone={STAGE_TONE[d.stage]}>{d.label}</Chip>
      </div>
      {d.stage === "warming" || d.stage === "ladder" ? (
        <div className="ik-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${d.name} progress`}>
          <span style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <div className={`ik-note${d.stage === "held" ? " bad" : ""}`}>{progressText(d)}</div>
      <div className="ik-boxes">
        {d.mailboxes.map((m) => (
          <span key={m.id} className="ik-box" title={m.error ?? `${m.supplierStatus ?? ""}${m.health ? ` · warmup ${m.health}` : ""}`}>
            <i className={`ik-dot ${m.error ? "bad" : (m.health && HEALTH_TONE[m.health]) || ""}`} />
            {m.address}
            {m.inboxRate !== null ? <small className="muted"> · inbox {Math.round(m.inboxRate)}%</small> : null}
            {m.error ? <small className="dm-err"> {m.error}</small> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Every domain ordered through InboxKit, where it is, and recent orders. Refreshes every minute. */
export function WarmupBoard() {
  const { data } = useAdminInboxKitPipelineQuery(undefined, { pollingInterval: 60_000 });
  const [sync, { isLoading: syncing }] = useAdminInboxKitSyncMutation();
  const [act, { isLoading: acting }] = useAdminInboxKitOrderMutation();
  const [filter, setFilter] = useState<PipelineStage | "all">("all");
  const toast = useToast();
  const shown = useMemo(() => (data?.domains ?? []).filter((d) => filter === "all" || d.stage === filter), [data, filter]);
  if (!data || (!data.domains.length && !data.orders.length)) return null;
  const openOrders = data.orders.filter((o) => o.status === "SCHEDULED" || o.status === "WAITING_FOR_FUNDS" || o.lastError);
  return (
    <section className="dm-card glass" style={{ marginBottom: 16 }}>
      <div className="dm-head">
        <div className="dm-title">
          <b>New domains</b>
          <span className="muted">ordered through InboxKit, from setup to sending</span>
        </div>
        <div className="dm-actions">
          <Button
            size="sm"
            variant="ghost"
            loading={syncing}
            onClick={() =>
              sync()
                .unwrap()
                .then(() => toast("Read the latest from InboxKit.", "good"))
                .catch((e) => toast(errorMessage(e), "bad"))
            }
          >
            Sync now
          </Button>
        </div>
      </div>
      <div className="ik-stages" role="group" aria-label="Filter by stage">
        <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All <b>{n0(data.domains.length)}</b>
        </button>
        {STAGE_ORDER.filter((s) => data.counts[s]).map((s) => (
          <button key={s} type="button" aria-pressed={filter === s} onClick={() => setFilter(s)}>
            {STAGE_SHORT[s]} <b>{n0(data.counts[s])}</b>
          </button>
        ))}
      </div>
      {openOrders.length ? (
        <div className="stack">
          {openOrders.map((o) => (
            <div key={o.id} className={o.status === "WAITING_FOR_FUNDS" ? "dm-paused" : "ik-order"}>
              <span>
                <Chip tone={ORDER_TONE[o.status]}>{ORDER_LABEL[o.status]}</Chip> {n0(o.placed)} of {n0(o.requested)} domains ordered{o.pending ? `, ${n0(o.pending)} to go${o.nextRunAt ? ` (next ${dateTime(o.nextRunAt)})` : ""}` : ""}.
                {o.lastError ? <span className="muted"> {o.lastError}</span> : null}
              </span>
              {o.status === "SCHEDULED" || o.status === "WAITING_FOR_FUNDS" ? (
                <Button
                  size="sm"
                  variant="text"
                  loading={acting}
                  onClick={() =>
                    act({ id: o.id, action: "cancel" })
                      .unwrap()
                      .then(() => toast("The rest of that order is cancelled.", "good"))
                      .catch((e) => toast(errorMessage(e), "bad"))
                  }
                >
                  Cancel the rest
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="ik-list">
        {shown.map((d) => (
          <DomainRow key={d.id} d={d} />
        ))}
      </div>
    </section>
  );
}
