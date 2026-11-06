"use client";

import { useRef, useState } from "react";
import { Select } from "@/components/ui/Select";
import { Button, Field, Seg } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/store";
import {
  errorMessage,
  useAdminImportMailboxesMutation,
  useAdminMailboxGoogleMutation,
} from "@/store/api";
import { n0 } from "@/lib/format";
import type { MailboxImport } from "@/lib/types";
import { LOCALES, REGIONS } from "@/lib/poolOptions";

const TEMPLATE =
  "email,first_name,last_name,app_password\nmadison@yourdomain.com,Madison,Reed,abcd efgh ijkl mnop\n";
const MAX_BYTES = 2_000_000;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n0(n)} ${n === 1 ? one : many}`;

/**
 * Adds warmed mailboxes from a spreadsheet saved as CSV. Two steps: the file is read and shown (nothing is added),
 * then one press adds every domain and signs its mailboxes in. The file stays in this window only.
 */
export function ImportMailboxesModal({ onClose }: { onClose: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [platform, setPlatform] = useState<"google" | "microsoft">("google");
  // Google mailboxes with 2-Step Verification on can't send with their account password, so they sign in with Google.
  const [auth, setAuth] = useState<"google" | "password">("google");
  const signIn = platform === "google" ? auth : "password";
  const [region, setRegion] = useState("global");
  const [locale, setLocale] = useState("en");
  const [result, setResult] = useState<MailboxImport | null>(null);
  const [err, setErr] = useState("");
  const [run, { isLoading }] = useAdminImportMailboxesMutation();
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const pick = (file: File | undefined) => {
    setErr("");
    setResult(null);
    if (!file) return;
    if (file.size > MAX_BYTES)
      return setErr(
        "That file is too big. Upload at most 600 mailboxes at a time.",
      );
    if (!/\.(csv|tsv|txt)$/i.test(file.name))
      return setErr(
        "Choose a .csv file. In Google Sheets: File > Download > Comma-separated values (.csv).",
      );
    setFileName(file.name);
    file.text().then(setCsv, () => setErr("That file couldn't be read."));
  };

  const send = (commit: boolean) => {
    if (!csv) return;
    setErr("");
    run({ csv, platform, auth: signIn, region, locale, commit })
      .unwrap()
      .then((r) => {
        setResult(r);
        if (r.done) {
          // The passwords are in the secret store now; the copy in this window isn't needed.
          setCsv(null);
          const failed = r.domains
            .flatMap((d) => d.added ?? [])
            .filter((m) => !m.ok).length;
          toast(
            r.auth === "google" && failed
              ? `${plural(r.totals.toAdd, "mailbox", "mailboxes")} added. Press Connect with Google on ${failed === 1 ? "it" : "each one"} to finish signing in.`
              : `${plural(r.totals.signedIn ?? 0, "mailbox", "mailboxes")} added and signed in.${failed ? ` ${plural(failed, "mailbox", "mailboxes")} couldn't sign in.` : ""}`,
            failed ? "bad" : "good",
          );
        }
      })
      .catch((e) => setErr(errorMessage(e)));
  };

  const done = !!result?.done;
  const toAdd = result && !done ? result.totals.toAdd : 0;

  return (
    <Modal
      wide
      title="Upload warmed mailboxes"
      onClose={onClose}
      actions={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="text" onClick={onClose}>
              Cancel
            </Button>
            {result ? (
              <Button
                variant="primary"
                loading={isLoading}
                disabled={!toAdd}
                onClick={() => send(true)}
              >
                {toAdd
                  ? `Add ${plural(toAdd, "mailbox", "mailboxes")}`
                  : "Nothing new to add"}
              </Button>
            ) : (
              <Button
                variant="primary"
                loading={isLoading}
                disabled={!csv}
                onClick={() => send(false)}
              >
                Check file
              </Button>
            )}
          </>
        )
      }
    >
      <div className="stack dm-form">
        {!done ? (
          <>
            <p className="muted dm-lede">
              For mailboxes that are already warmed up, from InboxKit or anyone
              else. In your sheet: File &gt; Download &gt; Comma-separated
              values (.csv), then choose that file here. Each domain goes live
              as soon as its DNS passes, at 30 emails a mailbox a day. Nothing
              is added until you confirm on the next step.
            </p>
            <div className="imp-drop">
              <input
                ref={input}
                type="file"
                accept=".csv,text/csv,.tsv,.txt"
                aria-label="CSV file"
                hidden
                onChange={(e) => pick(e.target.files?.[0])}
              />
              <Button onClick={() => input.current?.click()}>
                {fileName ? "Choose another file" : "Choose CSV file"}
              </Button>
              <span className="muted">
                {fileName ? fileName : "No file chosen"}
              </span>
            </div>
            <div className="dm-grid3">
              <Seg<"google" | "microsoft">
                label="Mailboxes are on"
                value={platform}
                onChange={(v) => (setPlatform(v), setResult(null))}
                options={[
                  { value: "google", label: "Google" },
                  { value: "microsoft", label: "Microsoft" },
                ]}
              />
              {platform === "google" ? (
                <Seg<"google" | "password">
                  label="How they sign in"
                  value={auth}
                  onChange={(v) => (setAuth(v), setResult(null))}
                  options={[
                    { value: "google", label: "Google sign-in" },
                    { value: "password", label: "App password" },
                  ]}
                />
              ) : null}
              <Field label="Market they send to" htmlFor="imp-region">
                <Select
                  id="imp-region"
                  className="input"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                >
                  {REGIONS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Language" htmlFor="imp-locale">
                <Select
                  id="imp-locale"
                  className="input"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                >
                  {LOCALES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {signIn === "google" ? (
              <p className="ik-note">
                Google sign-in is for mailboxes with 2-Step Verification on
                (Google refuses their normal password for sending). The file
                only needs the email and names; any password in it is ignored
                and not kept. After adding, press <b>Connect with Google</b> on
                each mailbox and sign in once, or allow Aperture for the whole
                Workspace in Google sign-in above.
              </p>
            ) : null}
            <details className="imp-help">
              <summary>What the file needs</summary>
              <p>
                A header row, then one mailbox a row. Columns can be in any
                order and the names don&apos;t have to match exactly:{" "}
                <b>email</b> is needed, and with App password also{" "}
                <b>password</b> (or <b>app password</b>, which is used when both
                are filled); <b>first name</b> and <b>last name</b> are optional
                (the name is taken from the address otherwise). Google and
                Microsoft servers are filled in for you. Other hosts: add{" "}
                <b>smtp host</b>, <b>smtp port</b>, <b>imap host</b>,{" "}
                <b>imap port</b>. Up to 3 mailboxes a domain.
              </p>
              <a
                className="btn btn-text btn-sm"
                download="warmed-mailboxes-template.csv"
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`}
              >
                Download a template
              </a>
            </details>
          </>
        ) : null}

        {err ? (
          <p className="ik-note bad" role="alert">
            {err}
          </p>
        ) : null}

        {result ? <ImportReport r={result} /> : null}
      </div>
    </Modal>
  );
}

function ImportReport({ r }: { r: MailboxImport }) {
  const t = r.totals;
  return (
    <div className="imp-report">
      <p className="imp-sum" role="status">
        {r.done
          ? r.auth === "google"
            ? `Added ${plural(t.toAdd, "mailbox", "mailboxes")} on ${plural(r.domains.filter((d) => d.added?.length).length, "domain")}.${t.signedIn ? ` ${n0(t.signedIn)} already signed in with Google.` : ""}`
            : `Added ${plural(t.signedIn ?? 0, "mailbox", "mailboxes")} that signed in, on ${plural(r.domains.filter((d) => d.added?.length).length, "domain")}.`
          : `${plural(t.mailboxes, "mailbox", "mailboxes")} on ${plural(t.domains, "domain")}. ${t.toAdd ? `${n0(t.toAdd)} will be added${t.newDomains ? `, ${plural(t.newDomains, "new domain")}` : ""}.` : "None are new."}`}
        {t.skipped ? ` ${n0(t.skipped)} already in the pool.` : ""}
        {t.failed ? ` ${plural(t.failed, "domain")} can't be added.` : ""}
      </p>
      {r.done && r.auth === "google" && (t.signedIn ?? 0) < t.toAdd ? (
        <p className="imp-next">
          <b>One step left: connect each mailbox to Google.</b> Press{" "}
          <b>Connect with Google</b> next to a mailbox, sign in as that mailbox
          with its password and 2-step code, and allow Aperture. You come back
          to Domains; the same button is on every mailbox there, so do the rest
          from the list. Nothing sends from a mailbox until it is connected.
        </p>
      ) : null}
      {!r.done && r.columns ? (
        <p className="ik-note">
          Read from: email “{r.columns.address}”
          {r.auth === "password"
            ? `, password “${r.columns.appPassword ?? r.columns.password}”`
            : ""}
          {r.columns.firstName
            ? `, name “${r.columns.firstName}”`
            : r.columns.name
              ? `, name “${r.columns.name}”`
              : ", name from the address"}
          .
        </p>
      ) : null}
      <div className="tbl-scroll">
        <table className="tbl imp-tbl">
          <thead>
            <tr>
              <th>Mailbox</th>
              <th>Sender name</th>
              <th>{r.done ? "Result" : "What happens"}</th>
            </tr>
          </thead>
          <tbody>
            {r.domains.map((d) => (
              <DomainRows key={d.name} d={d} done={r.done} auth={r.auth} />
            ))}
          </tbody>
        </table>
      </div>
      {r.problems.length ? (
        <div className="imp-problems">
          <b>{plural(r.problems.length, "row")} skipped</b>
          <ul>
            {r.problems.map((p, i) => (
              <li key={i}>
                Row {p.line}
                {p.address ? ` (${p.address})` : ""}: {p.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function DomainRows({
  d,
  done,
  auth,
}: {
  d: MailboxImport["domains"][number];
  done: boolean;
  auth: MailboxImport["auth"];
}) {
  const added = new Map((d.added ?? []).map((m) => [m.address, m]));
  return (
    <>
      <tr className="imp-domain">
        <td colSpan={3}>
          <b>{d.name}</b>{" "}
          <span className="dm-tag">
            {d.exists ? "Already in the pool" : "New domain"}
          </span>
          {d.error ? <span className="imp-bad"> {d.error}</span> : null}
        </td>
      </tr>
      {d.add.map((m) => {
        const res = added.get(m.address);
        return (
          <tr key={m.address}>
            <td>{m.address}</td>
            <td>{m.name}</td>
            <td>
              {done ? (
                res?.ok ? (
                  <span className="imp-ok">Signed in</span>
                ) : res && auth === "google" ? (
                  <ConnectGoogle id={res.id} />
                ) : (
                  <span className="imp-bad">{res?.error ?? "Not added"}</span>
                )
              ) : (
                "Will be added"
              )}
            </td>
          </tr>
        );
      })}
      {d.skip.map((m) => (
        <tr key={m.address} className="imp-skip">
          <td>{m.address}</td>
          <td />
          <td>{m.message}</td>
        </tr>
      ))}
    </>
  );
}

/** An added Google mailbox waiting for its one-time Google sign-in. Not an error: the next step. */
function ConnectGoogle({ id }: { id?: string }) {
  const [connect, { isLoading }] = useAdminMailboxGoogleMutation();
  const [err, setErr] = useState("");
  return (
    <span className="imp-wait">
      <span>Added · waiting for Google sign-in</span>
      {id ? (
        <Button
          size="sm"
          loading={isLoading}
          onClick={() =>
            connect({ id, action: "connect" })
              .unwrap()
              .then((r) =>
                r.url
                  ? window.location.assign(r.url)
                  : setErr(
                      r.error ?? "Connect with Google is off on the server",
                    ),
              )
              .catch((e) => setErr(errorMessage(e)))
          }
        >
          Connect with Google
        </Button>
      ) : null}
      {err ? <span className="imp-bad">{err}</span> : null}
    </span>
  );
}
