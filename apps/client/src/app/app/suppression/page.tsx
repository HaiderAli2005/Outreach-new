"use client";

import { Select } from "@/components/ui/Select";
import { useState } from "react";
import { Button, Chip, Empty, ErrorState, Field, Pager, Seg, SkeletonRows, TextField, ViewHead, useDebounced } from "@/components/ui/primitives";
import { Confirm, Modal } from "@/components/ui/overlays";
import { useExport, useRole, useToast } from "@/store";
import { errorMessage, useAddBlockMutation, useBlocklistQuery, useImportBlocklistMutation, useRemoveBlockMutation, useRestoreContactMutation } from "@/store/api";
import { dateLong, n0, titleCase } from "@/lib/format";
import type { BlockEntry } from "@/lib/types";

const REASON_TONE: Record<string, "g" | "b" | "v" | "y" | "r"> = {
  UNSUBSCRIBED: "r",
  BOUNCED: "r",
  COMPLAINED: "r",
  CUSTOMER: "g",
  DEAL_CLOSED: "g",
  COMPETITOR: "y",
  MANUAL: "v",
  ALREADY_CONTACTED: "b",
  NO_RESPONSE: "v",
  REMOVED: "v",
};

function AddModal({ onClose }: { onClose: () => void }) {
  const [entryType, setType] = useState<"EMAIL" | "DOMAIN">("EMAIL");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("MANUAL");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [add, { isLoading }] = useAddBlockMutation();
  const toast = useToast();
  return (
    <Modal
      title="Block an address or company"
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={isLoading}
            disabled={value.trim().length < 3}
            onClick={() =>
              add({ value: value.trim(), entryType, reason, note: note.trim() || undefined })
                .unwrap()
                .then((r) => {
                  toast(r.message, "good");
                  onClose();
                })
                .catch((e) => setErr(errorMessage(e)))
            }
          >
            Add to suppress list
          </Button>
        </>
      }
    >
      <div className="stack">
        <Seg
          label="Entry type"
          value={entryType}
          onChange={setType}
          options={[
            { value: "EMAIL", label: "One email" },
            { value: "DOMAIN", label: "Whole company" },
          ]}
        />
        <TextField label={entryType === "EMAIL" ? "Email address" : "Company domain"} placeholder={entryType === "EMAIL" ? "name@company.com" : "company.com"} value={value} onChange={(e) => setValue(e.target.value)} error={err || null} />
        <Field label="Reason" htmlFor="bReason">
          <Select id="bReason" className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="MANUAL">Manual</option>
            <option value="COMPETITOR">Competitor</option>
            <option value="CUSTOMER">Existing customer</option>
          </Select>
        </Field>
        <TextField label="Note" hint="Optional, for your team" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [whole, setWhole] = useState(true);
  const [err, setErr] = useState("");
  const [result, setResult] = useState("");
  const [run, { isLoading }] = useImportBlocklistMutation();
  return (
    <Modal
      title="Add a list or a CSV"
      onClose={onClose}
      actions={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="text" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="upload"
              loading={isLoading}
              disabled={!text.trim()}
              onClick={() =>
                run({ text, blockWholeCompany: whole })
                  .unwrap()
                  .then((r) => setResult(r.message))
                  .catch((e) => setErr(errorMessage(e)))
              }
            >
              Import
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="ok-line g">
          <span>{result}</span>
        </div>
      ) : (
        <div className="stack">
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Paste one email or domain per line, or upload a CSV of contacts (for example your customer list). Free-mail domains are never blocked as a whole.
          </p>
          <Field label="Upload a file" htmlFor="blFile">
            <input
              id="blFile"
              type="file"
              className="input"
              accept=".csv,.txt,text/csv,text/plain"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 4_400_000) return setErr("That file is too large. Split it into smaller files.");
                setText(await f.text());
              }}
            />
          </Field>
          <Field label="Or paste" htmlFor="blText">
            <textarea id="blText" className="input" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={"ceo@rival.com\nrival.com"} />
          </Field>
          <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
            <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />
            Also block each contact&apos;s whole company
          </label>
          {err ? (
            <div className="banner bad" role="alert">
              {err}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

const ORIGINS = [
  ["", "Everything"],
  ["you", "Added by you"],
  ["automatic", "Added automatically"],
] as const;

export default function SuppressionPage() {
  const { canManage } = useRole();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const q = useDebounced(search, 350);
  const [entryType, setEntryType] = useState("");
  const [reason, setReason] = useState("");
  const [origin, setOrigin] = useState<"" | "you" | "automatic">("");
  const [page, setPage] = useState(1);
  const { data, isLoading, isFetching, isError, error, refetch } = useBlocklistQuery({ search: q || undefined, entryType: entryType || undefined, reason: reason || undefined, origin: origin || undefined, page, limit: 50 });
  const [remove, removeState] = useRemoveBlockMutation();
  const [restore, restoreState] = useRestoreContactMutation();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState<BlockEntry | null>(null);
  const { run, busy } = useExport();
  const byReason = data?.meta.byReason ?? {};

  return (
    <>
      <ViewHead
        kicker="Suppress list"
        title="Never email these."
        sub="Checked before every single send. Unsubscribes, bounces and angry replies are added automatically; add customers, competitors or anyone else yourself, one at a time, a whole company, a pasted list or a CSV."
        actions={
          <>
            <Button icon="download" loading={busy !== null} onClick={() => run("/blocklist/export", "blocklist.csv")}>
              Export
            </Button>
            <Button icon="upload" onClick={() => setImporting(true)}>
              Import
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
              Add
            </Button>
          </>
        }
      />
      {Object.keys(byReason).length ? (
        <div className="chips">
          {Object.entries(byReason)
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => (
              <button key={k} type="button" className="pill-btn" aria-pressed={reason === k} onClick={() => (setReason(reason === k ? "" : k), setPage(1))}>
                {titleCase(k)} · {n0(n)}
              </button>
            ))}
        </div>
      ) : null}
      <Seg
        label="Who added it"
        value={origin}
        onChange={(v) => (setOrigin(v), setPage(1))}
        options={ORIGINS.map(([v, l]) => ({ value: v, label: l, count: v && data?.meta.byOrigin ? data.meta.byOrigin[v] : null }))}
      />
      <div className="toolbar">
        <input className="input sm grow" placeholder="Search emails and domains" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} aria-label="Search blocklist" />
        <Select className="select" value={entryType} onChange={(e) => (setEntryType(e.target.value), setPage(1))} aria-label="Type">
          <option value="">Emails and companies</option>
          <option value="EMAIL">Emails</option>
          <option value="DOMAIN">Companies</option>
        </Select>
      </div>
      <div className="tbl-wrap glass" style={{ opacity: isFetching && !isLoading ? 0.7 : 1 }}>
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading || !data ? (
          <SkeletonRows rows={6} />
        ) : data.data.length ? (
          <>
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Email or domain</th>
                    <th>Type</th>
                    <th>Reason</th>
                    <th>Added by</th>
                    <th>Note</th>
                    <th>Added</th>
                    <th className="right" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((e) => (
                    <tr key={e.id}>
                      <td className="strong mono">{e.value}</td>
                      <td className="m">{e.entryType === "EMAIL" ? "Email" : "Company"}</td>
                      <td>
                        <Chip tone={REASON_TONE[e.reason] ?? "v"}>{titleCase(e.reason)}</Chip>
                      </td>
                      <td className="m">{e.origin === "automatic" ? "Automatic" : "You"}</td>
                      <td className="m">{e.note}</td>
                      <td className="m">{dateLong(e.createdAt)}</td>
                      <td className="right" style={{ whiteSpace: "nowrap" }}>
                        {e.contactId ? (
                          <Button
                            size="xs"
                            variant="text"
                            loading={restoreState.isLoading && restoreState.originalArgs === e.contactId}
                            onClick={() =>
                              restore(e.contactId!)
                                .unwrap()
                                .then((r) => toast(r.message, "good"))
                                .catch((er) => toast(errorMessage(er), "bad"))
                            }
                          >
                            Restore lead
                          </Button>
                        ) : null}
                        {canManage ? (
                          <Button size="xs" variant="text" onClick={() => setConfirm(e)}>
                            Remove
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} limit={50} total={data.meta.total ?? 0} onPage={setPage} />
          </>
        ) : (
          <Empty icon="ban" title={q || entryType || reason || origin ? "Nothing matches" : "Your suppress list is empty"}>
            {q || entryType || reason || origin ? "Try clearing a filter." : "Opt-outs and bounces are added automatically. You can also add competitors and customers."}
          </Empty>
        )}
      </div>
      {adding ? <AddModal onClose={() => setAdding(false)} /> : null}
      {importing ? <ImportModal onClose={() => setImporting(false)} /> : null}
      {confirm ? (
        <Confirm
          title={`Remove ${confirm.value}?`}
          danger
          confirmLabel="Remove"
          loading={removeState.isLoading}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            remove(confirm.id)
              .unwrap()
              .then(() => {
                toast(`${confirm.value} removed from the suppress list`, "good");
                setConfirm(null);
              })
              .catch((e) => toast(errorMessage(e), "bad"))
          }
          body={["UNSUBSCRIBED", "COMPLAINED", "BOUNCED"].includes(confirm.reason) ? "This entry records an opt-out or a bounce. Removing it means they can be emailed again, which can break unsubscribe rules." : "They can be contacted again by future campaigns."}
        />
      ) : null}
    </>
  );
}
