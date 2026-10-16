"use client";

import { Select } from "@/components/ui/Select";
import { useMemo, useState } from "react";
import { Button, Chip, Empty, ErrorState, Field, PasswordInput, Seg, SkeletonRows, TextField, ViewHead } from "@/components/ui/primitives";
import { Confirm, Modal } from "@/components/ui/overlays";
import { useToast } from "@/store";
import {
  errorMessage,
  useAdminAddDomainMutation,
  useAdminAddMailboxMutation,
  useAdminDomainActionMutation,
  useAdminDomainsQuery,
  useAdminMailboxActionMutation,
  useAdminResumeDomainMutation,
} from "@/store/api";
import { ago, dateLong, n0 } from "@/lib/format";
import type { NewPoolMailbox, PoolDomain, PoolMailbox } from "@/lib/types";

/** Mail hosts and their standard server settings. "Other" lets the operator type them. */
const PROVIDERS = {
  google: { label: "Google Workspace", smtpHost: "smtp.gmail.com", smtpPort: 587, imapHost: "imap.gmail.com", imapPort: 993, hint: "Use an app password: Google Account, Security, App passwords. 2-step sign-in must be on." },
  microsoft: { label: "Microsoft 365", smtpHost: "smtp.office365.com", smtpPort: 587, imapHost: "outlook.office365.com", imapPort: 993, hint: "SMTP sign-in (Authenticated SMTP) must be switched on for each mailbox in the Microsoft 365 admin centre." },
  zoho: { label: "Zoho Mail", smtpHost: "smtp.zoho.com", smtpPort: 587, imapHost: "imap.zoho.com", imapPort: 993, hint: "Turn on IMAP access in Zoho Mail settings. Use an app-specific password if 2-step sign-in is on." },
  other: { label: "Other", smtpHost: "", smtpPort: 587, imapHost: "", imapPort: 993, hint: "Your mail host lists its SMTP and IMAP servers in its help pages." },
} as const;
type ProviderKey = keyof typeof PROVIDERS;

const REGIONS = [
  ["global", "Any market"],
  ["pk", "Pakistan"],
  ["uk", "United Kingdom"],
  ["us", "United States"],
  ["eu-de", "Germany, Austria, Switzerland"],
] as const;

const LOCALES = [
  ["en", "English"],
  ["ur", "Urdu"],
  ["ar", "Arabic"],
  ["de", "German"],
  ["fr", "French"],
  ["es", "Spanish"],
] as const;

const DOMAIN_TONE: Record<PoolDomain["status"], "g" | "b" | "v" | "y" | "r"> = { ACTIVE: "g", WARMING: "b", AGING: "v", REGISTERED: "y", DEGRADED: "r", RETIRED: "v" };
const DOMAIN_LABEL: Record<PoolDomain["status"], string> = { ACTIVE: "Sending", WARMING: "Warming up", AGING: "Resting", REGISTERED: "Waiting for DNS", DEGRADED: "Pulled", RETIRED: "Retired" };
const BOX_TONE: Record<PoolMailbox["status"], "g" | "b" | "v" | "y" | "r"> = { ACTIVE: "g", WARMING: "b", CONNECTING: "y", ERROR: "r", REPLIES_ONLY: "v", RETIRED: "v" };
const BOX_LABEL: Record<PoolMailbox["status"], string> = { ACTIVE: "Sending", WARMING: "Warming", CONNECTING: "Ready, waiting", ERROR: "Can't sign in", REPLIES_ONLY: "Replies only", RETIRED: "Retired" };

const live = (d: PoolDomain) => d.mailboxes.filter((m) => m.status !== "RETIRED");
const dnsOk = (d: PoolDomain) => !!(d.dns.spf && d.dns.dkim && d.dns.dmarc);

/** One plain sentence on where a domain is and what happens next. */
function nextStep(d: PoolDomain): string {
  const days = Math.max(0, ...live(d).map((m) => m.warmupDay));
  switch (d.status) {
    case "REGISTERED":
      return d.warmed ? "Goes live the moment SPF, DKIM and DMARC pass. Fix the missing records below, then press Check DNS." : "Waiting for SPF, DKIM and DMARC. Once they pass it rests 30 days, then warms up.";
    case "AGING":
      return `Resting, sending nothing, until ${d.agingUntil ? dateLong(d.agingUntil) : "its 30 days are up"}. Warmup then starts at 5 emails a mailbox a day.`;
    case "WARMING":
      return `Warming up, day ${Math.min(days, 28)} of 28. Each mailbox sends ${days >= 22 ? 30 : days >= 15 ? 20 : days >= 8 ? 10 : 5} a day today.`;
    case "ACTIVE":
      return `Sending, up to ${n0(live(d).filter((m) => m.status === "ACTIVE").length * 30)} a day. ${n0(d.sent7)} emails in the last 7 days.`;
    case "DEGRADED":
      return "Pulled from new sends because too many emails bounced. Its mailboxes only finish conversations already started.";
    default:
      return "Retired. Cancel its mailboxes with your mail host so they stop costing money.";
  }
}

interface BoxDraft extends NewPoolMailbox {
  key: number;
}

const blankBox = (key: number, p: ProviderKey): BoxDraft => ({ key, address: "", firstName: "", lastName: "", password: "", smtpHost: PROVIDERS[p].smtpHost, smtpPort: PROVIDERS[p].smtpPort, imapHost: PROVIDERS[p].imapHost, imapPort: PROVIDERS[p].imapPort });

/** Server settings shared by every mailbox in the form: a preset, or typed for "Other". */
function ServerFields({ provider, setProvider, server, setServer }: { provider: ProviderKey; setProvider: (p: ProviderKey) => void; server: Pick<NewPoolMailbox, "smtpHost" | "smtpPort" | "imapHost" | "imapPort">; setServer: (s: Partial<NewPoolMailbox>) => void }) {
  return (
    <>
      <Field label="Where the mailboxes are hosted" hint={PROVIDERS[provider].hint}>
        <Seg<ProviderKey>
          label="Mail host"
          size="sm"
          value={provider}
          onChange={(p) => {
            setProvider(p);
            const { smtpHost, smtpPort, imapHost, imapPort } = PROVIDERS[p];
            setServer({ smtpHost, smtpPort, imapHost, imapPort });
          }}
          options={(Object.keys(PROVIDERS) as ProviderKey[]).map((k) => ({ value: k, label: PROVIDERS[k].label }))}
        />
      </Field>
      {provider === "other" ? (
        <div className="dm-grid4">
          <TextField label="SMTP server" placeholder="smtp.example.com" value={server.smtpHost} onChange={(e) => setServer({ smtpHost: e.target.value.trim() })} />
          <TextField label="SMTP port" type="number" value={server.smtpPort} onChange={(e) => setServer({ smtpPort: Number(e.target.value) || 587 })} />
          <TextField label="IMAP server" placeholder="imap.example.com" value={server.imapHost} onChange={(e) => setServer({ imapHost: e.target.value.trim() })} />
          <TextField label="IMAP port" type="number" value={server.imapPort} onChange={(e) => setServer({ imapPort: Number(e.target.value) || 993 })} />
        </div>
      ) : null}
    </>
  );
}

function BoxRow({ b, domain, onChange, onRemove, first }: { b: BoxDraft; domain: string; onChange: (p: Partial<BoxDraft>) => void; onRemove?: () => void; first: boolean }) {
  return (
    <div className="dm-box">
      <TextField label={first ? "Email address" : " "} placeholder={`madison@${domain || "yourdomain.com"}`} value={b.address} autoComplete="off" onChange={(e) => onChange({ address: e.target.value.trim().toLowerCase() })} />
      <TextField label={first ? "First name" : " "} placeholder="Madison" value={b.firstName} autoComplete="off" onChange={(e) => onChange({ firstName: e.target.value })} />
      <TextField label={first ? "Last name" : " "} placeholder="Reed" value={b.lastName ?? ""} autoComplete="off" onChange={(e) => onChange({ lastName: e.target.value })} />
      <Field label={first ? "Password" : " "}>
        <PasswordInput autoComplete="new-password" value={b.password} onChange={(e) => onChange({ password: e.target.value })} aria-label={`Password for ${b.address || "this mailbox"}`} />
      </Field>
      {onRemove ? (
        <button type="button" className="btn btn-text btn-xs dm-x" onClick={onRemove} aria-label="Remove this mailbox">
          Remove
        </button>
      ) : (
        <span className="dm-x" />
      )}
    </div>
  );
}

const boxReady = (b: NewPoolMailbox, domain: string) => b.address.endsWith(`@${domain}`) && b.address.split("@")[0].replace(/[^a-z]/g, "").length >= 2 && b.firstName.trim().length >= 2 && !!b.password && !!b.smtpHost && !!b.imapHost;

function AddDomainModal({ warmed: startWarmed, onClose }: { warmed: boolean; onClose: () => void }) {
  const [warmed, setWarmed] = useState(startWarmed);
  const [name, setName] = useState("");
  const [region, setRegion] = useState("global");
  const [locale, setLocale] = useState("en");
  const [provider, setProvider] = useState<ProviderKey>("google");
  const [server, setServerState] = useState<Pick<NewPoolMailbox, "smtpHost" | "smtpPort" | "imapHost" | "imapPort">>({ smtpHost: PROVIDERS.google.smtpHost, smtpPort: PROVIDERS.google.smtpPort, imapHost: PROVIDERS.google.imapHost, imapPort: PROVIDERS.google.imapPort });
  const [boxes, setBoxes] = useState<BoxDraft[]>([blankBox(1, "google")]);
  const [registrar, setRegistrar] = useState("");
  const [selector, setSelector] = useState("");
  const [err, setErr] = useState("");
  const [add, { isLoading }] = useAdminAddDomainMutation();
  const toast = useToast();
  const domain = name.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const ready = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && boxes.every((b) => boxReady({ ...b, ...server }, domain));

  const submit = () => {
    setErr("");
    add({ name: domain, warmed, region, locale, registrar: registrar.trim() || null, dkimSelector: selector.trim() || null, mailboxes: boxes.map(({ key: _k, ...b }) => ({ ...b, ...server, lastName: b.lastName?.trim() || null })) })
      .unwrap()
      .then((r) => {
        const failed = r.mailboxes.filter((m) => !m.ok);
        const where = r.dns.moved === "active" ? "It is sending now." : r.dns.moved === "aging" ? "DNS passes; it rests 30 days, then warms up." : "Waiting for SPF, DKIM and DMARC.";
        toast(`${r.name} added. ${where}${failed.length ? ` ${failed.length} mailbox${failed.length === 1 ? "" : "es"} could not sign in.` : ""}`, failed.length ? "bad" : "good");
        onClose();
      })
      .catch((e) => setErr(errorMessage(e)));
  };

  return (
    <Modal
      wide
      title={warmed ? "Add a warmed domain" : "Add a new domain"}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={isLoading} disabled={!ready} onClick={submit}>
            Add domain
          </Button>
        </>
      }
    >
      <div className="stack dm-form">
        <Seg<"warmed" | "new">
          label="Is this domain already warmed up?"
          value={warmed ? "warmed" : "new"}
          onChange={(v) => setWarmed(v === "warmed")}
          options={[
            { value: "warmed", label: "Already warmed" },
            { value: "new", label: "New, needs warmup" },
          ]}
        />
        <p className="muted dm-lede">
          {warmed
            ? "For a domain that has been sending for weeks. It goes live as soon as its DNS passes, at 30 emails a mailbox a day."
            : "For a fresh domain. Once its DNS passes it rests 30 days sending nothing, then warms up over 4 weeks: 5, 10, 20, then 30 emails a mailbox a day."}
        </p>
        <div className="dm-grid3">
          <TextField label="Domain" placeholder="decoderhubs.com" value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
          <Field label="Market it sends to" htmlFor="dm-region">
            <Select id="dm-region" className="input" value={region} onChange={(e) => setRegion(e.target.value)}>
              {REGIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Language of the sender names" htmlFor="dm-locale">
            <Select id="dm-locale" className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>
              {LOCALES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ServerFields provider={provider} setProvider={setProvider} server={server} setServer={(s) => setServerState((x) => ({ ...x, ...s }))} />
        <div className="dm-boxes">
          <div className="dm-boxes-h">
            <b>Mailboxes</b>
            <span className="muted">Up to 3 a domain, each a real first name. Passwords go to the secret store, never the database.</span>
          </div>
          {boxes.map((b, i) => (
            <BoxRow
              key={b.key}
              b={b}
              domain={domain}
              first={i === 0}
              onChange={(p) => setBoxes((list) => list.map((x) => (x.key === b.key ? { ...x, ...p } : x)))}
              onRemove={boxes.length > 1 ? () => setBoxes((list) => list.filter((x) => x.key !== b.key)) : undefined}
            />
          ))}
          {boxes.length < 3 ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBoxes((list) => [...list, blankBox(Math.max(...list.map((x) => x.key)) + 1, provider)])}>
              Add another mailbox
            </button>
          ) : null}
        </div>
        <details className="dm-more">
          <summary>More options</summary>
          <div className="dm-grid3" style={{ marginTop: 12 }}>
            <TextField label="Registrar" hint="Where you bought it, for the footprint view" placeholder="Namecheap" value={registrar} onChange={(e) => setRegistrar(e.target.value)} />
            <TextField label="DKIM selector" hint="Only if your host uses an unusual one" placeholder="google" value={selector} onChange={(e) => setSelector(e.target.value.trim())} />
          </div>
        </details>
        <div className="dm-dnshelp">
          <b>DNS records the domain needs</b>
          <span>SPF and DKIM come from your mail host&apos;s setup guide. For DMARC add a TXT record named _dmarc with the value v=DMARC1; p=none</span>
        </div>
        {err ? (
          <div className="banner bad" role="alert">
            {err}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function AddMailboxModal({ d, onClose }: { d: PoolDomain; onClose: () => void }) {
  const [provider, setProvider] = useState<ProviderKey>("google");
  const [b, setB] = useState<BoxDraft>(blankBox(1, "google"));
  const [locale, setLocale] = useState(live(d)[0]?.locale ?? "en");
  const [err, setErr] = useState("");
  const [add, { isLoading }] = useAdminAddMailboxMutation();
  const toast = useToast();
  return (
    <Modal
      wide
      title={`Add a mailbox to ${d.name}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={isLoading}
            disabled={!boxReady(b, d.name)}
            onClick={() =>
              add({ domainId: d.id, locale, ...b, lastName: b.lastName?.trim() || null })
                .unwrap()
                .then((r) => {
                  toast(r.ok ? `${r.address} added.` : `${r.address} added, but it could not sign in: ${r.error ?? "check the password"}`, r.ok ? "good" : "bad");
                  onClose();
                })
                .catch((e) => setErr(errorMessage(e)))
            }
          >
            Add mailbox
          </Button>
        </>
      }
    >
      <div className="stack dm-form">
        <ServerFields provider={provider} setProvider={setProvider} server={b} setServer={(s) => setB((x) => ({ ...x, ...s }))} />
        <Field label="Language of the sender name" htmlFor="mb-locale">
          <Select id="mb-locale" className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>
            {LOCALES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <BoxRow b={b} domain={d.name} first onChange={(p) => setB((x) => ({ ...x, ...p }))} />
        {err ? (
          <div className="banner bad" role="alert">
            {err}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function SignInModal({ m, onClose }: { m: PoolMailbox; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [run, { isLoading }] = useAdminMailboxActionMutation();
  const [result, setResult] = useState<string | null>(null);
  const toast = useToast();
  return (
    <Modal
      title={`Test sign-in for ${m.address}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            loading={isLoading}
            onClick={() =>
              run({ id: m.id, action: "test", password: password || undefined })
                .unwrap()
                .then((r) => {
                  if (r.ok) {
                    toast(`${m.address} signs in.`, "good");
                    onClose();
                  } else setResult(r.error ?? "Sign-in failed");
                })
                .catch((e) => setResult(errorMessage(e)))
            }
          >
            {password ? "Save and test" : "Test again"}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Signs in to {m.smtpHost} and {m.imapHost}. Leave the password empty to test the one already saved, or type a new one to replace it.
        </p>
        <Field label="New password (optional)">
          <PasswordInput autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="New password" />
        </Field>
        {result ? (
          <div className="banner bad" role="alert">
            {result}
          </div>
        ) : m.error ? (
          <div className="banner bad">Last attempt: {m.error}</div>
        ) : null}
      </div>
    </Modal>
  );
}

function PauseModal({ d, onClose }: { d: PoolDomain; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [act, { isLoading }] = useAdminDomainActionMutation();
  const toast = useToast();
  return (
    <Modal
      title={`Pause ${d.name}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={isLoading}
            disabled={reason.trim().length < 3}
            onClick={() =>
              act({ id: d.id, action: "pause", reason: reason.trim() })
                .unwrap()
                .then(() => {
                  toast(`${d.name} paused. Nobody new is sent from it.`, "good");
                  onClose();
                })
                .catch((e) => toast(errorMessage(e), "bad"))
            }
          >
            Pause
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          No new person is emailed from it. Follow-ups and replies to people already on it carry on.
        </p>
        <TextField label="Why" placeholder="Checking a complaint" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Modal>
  );
}

function DnsChip({ label, ok }: { label: string; ok: boolean | null }) {
  return <span className={`dm-dnschip ${ok ? "ok" : ok === false ? "bad" : ""}`}>{label}</span>;
}

function DomainCard({ d, onAddMailbox, onPause, onTest }: { d: PoolDomain; onAddMailbox: () => void; onPause: () => void; onTest: (m: PoolMailbox) => void }) {
  const [domainAct, { isLoading: domainBusy }] = useAdminDomainActionMutation();
  const [mailboxAct] = useAdminMailboxActionMutation();
  const [resume, { isLoading: resuming }] = useAdminResumeDomainMutation();
  const [confirm, setConfirm] = useState<null | { kind: "domain" } | { kind: "mailbox"; m: PoolMailbox; action: "replies-only" | "retire" }>(null);
  const toast = useToast();
  const boxes = d.mailboxes.filter((m) => m.status !== "RETIRED");
  const retired = d.status === "RETIRED";

  const checkDns = () =>
    domainAct({ id: d.id, action: "dns-check" })
      .unwrap()
      .then(() => toast(`Checked ${d.name}.`, "good"))
      .catch((e) => toast(errorMessage(e), "bad"));

  return (
    <section className={`dm-card glass${retired ? " off" : ""}`} aria-label={d.name}>
      <div className="dm-head">
        <div className="dm-title">
          <b>{d.name}</b>
          <Chip tone={DOMAIN_TONE[d.status]}>{DOMAIN_LABEL[d.status]}</Chip>
          <span className="dm-tag">{d.warmed ? "Warmed" : "New"}</span>
          {d.pausedAt ? <Chip tone="r">Paused</Chip> : null}
        </div>
        {!retired ? (
          <div className="dm-actions">
            <Button size="sm" variant="ghost" loading={domainBusy} onClick={checkDns}>
              Check DNS
            </Button>
            {boxes.length < 3 && d.status !== "DEGRADED" ? (
              <Button size="sm" variant="ghost" onClick={onAddMailbox}>
                Add mailbox
              </Button>
            ) : null}
            {d.pausedAt ? null : (
              <Button size="sm" variant="ghost" onClick={onPause}>
                Pause
              </Button>
            )}
            <Button size="sm" variant="text" onClick={() => setConfirm({ kind: "domain" })}>
              Retire
            </Button>
          </div>
        ) : null}
      </div>
      <p className="dm-next">{nextStep(d)}</p>
      <div className="dm-meta">
        <span className="dm-dns">
          <DnsChip label="SPF" ok={d.dns.spf} />
          <DnsChip label="DKIM" ok={d.dns.dkim} />
          <DnsChip label="DMARC" ok={d.dns.dmarc} />
          <small>{d.dns.checkedAt ? `checked ${ago(d.dns.checkedAt)}` : "not checked yet"}</small>
        </span>
        <span>{REGIONS.find(([v]) => v === d.region)?.[1] ?? d.region}</span>
        {d.registrar && d.registrar !== "unknown" ? <span>{d.registrar}</span> : null}
        <span>added {dateLong(d.createdAt)}</span>
      </div>
      {d.pausedAt ? (
        <div className="dm-paused">
          <span>
            Paused {ago(d.pausedAt)}: {d.pauseReason ?? "no reason given"}
          </span>
          <Button
            size="sm"
            loading={resuming}
            onClick={() =>
              resume({ id: d.id, reason: "Resumed from the Domains page" })
                .unwrap()
                .then(() => toast(`${d.name} is sending again.`, "good"))
                .catch((e) => toast(errorMessage(e), "bad"))
            }
          >
            Resume
          </Button>
        </div>
      ) : null}
      {d.mailboxes.length ? (
        <div className="tbl-scroll">
          <table className="tbl dm-tbl">
            <colgroup>
              <col />
              <col style={{ width: 150 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 190 }} />
              <col style={{ width: 290 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Mailbox</th>
                <th>Status</th>
                <th className="right">Today</th>
                <th>Server</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {d.mailboxes.map((m) => (
                <tr key={m.id} className={m.status === "RETIRED" ? "off" : undefined}>
                  <td>
                    <div className="dm-addr">{m.address}</div>
                    <small className="muted">
                      {m.name ?? ""}
                      {m.locale ? ` · ${LOCALES.find(([v]) => v === m.locale)?.[1] ?? m.locale}` : ""}
                    </small>
                    {m.error && m.status !== "RETIRED" ? <div className="dm-err">{m.error}</div> : null}
                  </td>
                  <td>
                    <Chip tone={BOX_TONE[m.status]}>{BOX_LABEL[m.status]}</Chip>
                  </td>
                  <td className="num-cell">{m.status === "ACTIVE" || m.status === "WARMING" ? `${n0(m.sentToday)} of ${n0(m.capToday)}` : ""}</td>
                  <td className="m mono">{m.smtpHost ?? ""}</td>
                  <td className="right">
                    {m.status !== "RETIRED" ? (
                      <div className="dm-row-actions">
                        <Button size="sm" variant="text" onClick={() => onTest(m)}>
                          Test sign-in
                        </Button>
                        {m.status === "ACTIVE" || m.status === "WARMING" ? (
                          <Button size="sm" variant="text" onClick={() => setConfirm({ kind: "mailbox", m, action: "replies-only" })}>
                            Replies only
                          </Button>
                        ) : null}
                        <Button size="sm" variant="text" onClick={() => setConfirm({ kind: "mailbox", m, action: "retire" })}>
                          Retire
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {confirm ? (
        <Confirm
          title={confirm.kind === "domain" ? `Retire ${d.name}?` : confirm.action === "retire" ? `Retire ${confirm.m.address}?` : `Replies only for ${confirm.m.address}?`}
          body={
            confirm.kind === "domain"
              ? "Every mailbox on it stops for good, including follow-ups to people already emailed. Cancel the mailboxes with your mail host afterwards."
              : confirm.action === "retire"
                ? "It stops for good, including follow-ups to people already emailed from it. Cancel it with your mail host afterwards."
                : "It takes nobody new but still sends follow-ups and replies to the people already on it."
          }
          confirmLabel={confirm.kind === "mailbox" && confirm.action === "replies-only" ? "Replies only" : "Retire"}
          danger={confirm.kind === "domain" || confirm.action === "retire"}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            (confirm.kind === "domain" ? domainAct({ id: d.id, action: "retire" }) : mailboxAct({ id: confirm.m.id, action: confirm.action }))
              .unwrap()
              .then(() => toast("Done.", "good"))
              .catch((e) => toast(errorMessage(e), "bad"))
              .finally(() => setConfirm(null))
          }
        />
      ) : null}
    </section>
  );
}

export default function AdminDomains() {
  const { data, isLoading, isError, error, refetch } = useAdminDomainsQuery(undefined, { pollingInterval: 60_000 });
  const [adding, setAdding] = useState<null | "warmed" | "new">(null);
  const [mailboxFor, setMailboxFor] = useState<PoolDomain | null>(null);
  const [pausing, setPausing] = useState<PoolDomain | null>(null);
  const [testing, setTesting] = useState<PoolMailbox | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  const counts = useMemo(() => {
    const list = data ?? [];
    const boxes = (s: PoolDomain["status"]) => list.filter((d) => d.status === s).reduce((n, d) => n + live(d).length, 0);
    return {
      active: list.filter((d) => d.status === "ACTIVE").length,
      activeBoxes: boxes("ACTIVE"),
      warming: list.filter((d) => d.status === "WARMING").length,
      waiting: list.filter((d) => d.status === "REGISTERED" || d.status === "AGING").length,
      attention: list.filter((d) => d.status !== "RETIRED" && (!dnsOk(d) || !!d.pausedAt || live(d).some((m) => m.status === "ERROR"))).length,
      capacity: list.filter((d) => d.status === "ACTIVE").reduce((n, d) => n + live(d).filter((m) => m.status === "ACTIVE").length * 30, 0),
      retired: list.filter((d) => d.status === "RETIRED").length,
    };
  }, [data]);

  if (isError) return <ErrorState error={error} onRetry={refetch} />;

  const shown = (data ?? []).filter((d) => showRetired || d.status !== "RETIRED");

  return (
    <>
      <ViewHead
        kicker="Admin"
        title="Domains."
        sub="The domains and mailboxes every customer sends from. You buy them yourself, from any registrar and mail host, and add them here. Customers never see any of this."
        actions={
          <>
            <Button size="sm" onClick={() => setAdding("new")}>
              Add new domain
            </Button>
            <Button size="sm" variant="primary" onClick={() => setAdding("warmed")}>
              Add warmed domain
            </Button>
          </>
        }
      />

      {isLoading || !data ? (
        <SkeletonRows rows={4} h={120} />
      ) : (
        <>
          <div className="stats4 glass">
            <div className="stat">
              <div className="big num">{n0(counts.active)}</div>
              <div className="sub">
                Sending · {n0(counts.activeBoxes)} mailboxes, {n0(counts.capacity)} a day
              </div>
            </div>
            <div className="stat">
              <div className="big num">{n0(counts.warming)}</div>
              <div className="sub">Warming up</div>
            </div>
            <div className="stat">
              <div className="big num">{n0(counts.waiting)}</div>
              <div className="sub">Waiting for DNS or resting</div>
            </div>
            <div className="stat">
              <div className="big num">{n0(counts.attention)}</div>
              <div className="sub">Need attention</div>
            </div>
          </div>

          {shown.length ? (
            <div className="dm-list">
              {shown.map((d) => (
                <DomainCard key={d.id} d={d} onAddMailbox={() => setMailboxFor(d)} onPause={() => setPausing(d)} onTest={setTesting} />
              ))}
            </div>
          ) : (
            <Empty
              icon="at"
              title="No domains yet"
              action={
                <Button variant="primary" onClick={() => setAdding("warmed")}>
                  Add warmed domain
                </Button>
              }
            >
              Nothing can send until the pool has at least one domain with mailboxes. Buy a domain and 3 mailboxes on it, then add it here.
            </Empty>
          )}
          {counts.retired ? (
            <button type="button" className="btn btn-text btn-sm" style={{ marginTop: 12 }} onClick={() => setShowRetired((v) => !v)}>
              {showRetired ? "Hide" : "Show"} {n0(counts.retired)} retired domain{counts.retired === 1 ? "" : "s"}
            </button>
          ) : null}
        </>
      )}

      {adding ? <AddDomainModal warmed={adding === "warmed"} onClose={() => setAdding(null)} /> : null}
      {mailboxFor ? <AddMailboxModal d={mailboxFor} onClose={() => setMailboxFor(null)} /> : null}
      {pausing ? <PauseModal d={pausing} onClose={() => setPausing(null)} /> : null}
      {testing ? <SignInModal m={testing} onClose={() => setTesting(null)} /> : null}
    </>
  );
}
