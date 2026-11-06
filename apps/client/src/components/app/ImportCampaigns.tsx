"use client";

import { useRef, useState } from "react";
import { Button, Notice } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/store";
import { errorMessage, useImportCampaignsMutation } from "@/store/api";
import { campaignsFromCsv, saveText, templateCsv, type CsvCampaigns } from "@/lib/campaignCsv";
import type { CampaignImport } from "@/lib/types";

/**
 * Many campaigns from one CSV: choose the file, every row is checked on the server, and nothing is made until all
 * rows are fine and the customer confirms. Rows are read in the browser; the file itself is never uploaded.
 */
export function ImportCampaigns({ onClose, onDone }: { onClose: () => void; onDone: (made: { id: string; name: string }[]) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [run, state] = useImportCampaignsMutation();
  const [file, setFile] = useState<string | null>(null);
  const [parsed, setParsed] = useState<CsvCampaigns | null>(null);
  const [checked, setChecked] = useState<CampaignImport | null>(null);
  const [dragging, setDragging] = useState(false);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFile(f.name);
    setChecked(null);
    const p = campaignsFromCsv(await f.text());
    setParsed(p);
    if (p.problems.length || !p.rows.length) return;
    if (p.rows.length > 20) {
      setParsed({ ...p, problems: [`The file has ${p.rows.length} campaigns. You can import up to 20 at a time.`] });
      return;
    }
    run({ rows: p.rows, check: true })
      .unwrap()
      .then(setChecked)
      .catch((e) => toast(errorMessage(e), "bad"));
  };

  const create = () => {
    if (!parsed) return;
    run({ rows: parsed.rows, check: false })
      .unwrap()
      .then((r) => {
        if (!r.ok) {
          setChecked(r);
          return;
        }
        toast(`${r.created.length} ${r.created.length === 1 ? "campaign is" : "campaigns are"} on. Aperture starts finding people for them on its next search.`, "good");
        onDone(r.created);
      })
      .catch((e) => toast(errorMessage(e), "bad"));
  };

  const bad = checked?.rows.filter((r) => r.error).length ?? 0;
  const ready = !!checked?.ok;
  return (
    <Modal
      title="Import campaigns from a CSV"
      onClose={onClose}
      wide
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create} disabled={!ready} loading={state.isLoading && !!checked}>
            {ready ? `Create ${checked.rows.length} ${checked.rows.length === 1 ? "campaign" : "campaigns"}` : "Create campaigns"}
          </Button>
        </>
      }
    >
      <div className="icp">
        <p className="icp-lede">
          One row per campaign. Put several keywords, titles or locations in one cell with a semicolon between them. Nothing is created until every row
          checks out and you confirm.
        </p>
        <div
          className={`icp-drop${dragging ? " is-over" : ""}`}
          onDragOver={(e) => (e.preventDefault(), setDragging(true))}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void pick(e.dataTransfer.files?.[0]);
          }}
        >
          <input ref={input} type="file" accept=".csv,text/csv" aria-label="CSV file" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          <span className="icp-ic" aria-hidden="true">
            <Icon id="upload" />
          </span>
          <div className="icp-drop-t">
            <b>{file ?? "Drop your CSV here"}</b>
            <span>{file ? (state.isLoading && !checked ? "Checking every row…" : `${parsed?.rows.length ?? 0} rows read`) : "or choose a file from your computer"}</span>
          </div>
          <Button size="sm" onClick={() => input.current?.click()}>
            {file ? "Choose another" : "Choose file"}
          </Button>
        </div>
        <button type="button" className="btn-link icp-tpl" onClick={() => saveText("aperture-campaigns-template.csv", templateCsv())}>
          <Icon id="download" /> Download the template
        </button>

        {parsed?.problems.length ? (
          <Notice tone="bad" title="This file can't be read">
            {parsed.problems.join(" ")}
          </Notice>
        ) : null}
        {checked?.problem ? <Notice tone="bad">{checked.problem}</Notice> : null}

        {checked && parsed ? (
          <>
            <div className={`icp-sum${ready ? " is-ok" : ""}`}>
              <Icon id={ready ? "check" : "alert"} />
              {ready ? `All ${checked.rows.length} campaigns are ready.` : `${bad} of ${checked.rows.length} rows need a fix. Correct them in your sheet and choose the file again.`}
            </div>
            <div className="icp-tbl" role="table" aria-label="Campaigns in the file">
              <div className="icp-tr icp-th" role="row">
                <span role="columnheader">#</span>
                <span role="columnheader">Campaign</span>
                <span role="columnheader">Who</span>
                <span role="columnheader">Keywords</span>
                <span role="columnheader">Check</span>
              </div>
              {checked.rows.map((r, i) => {
                const row = parsed.rows[i];
                const note = parsed.notes[i] ?? [];
                return (
                  <div className={`icp-tr${r.error ? " is-bad" : ""}`} role="row" key={r.row}>
                    <span className="m" role="cell">
                      {r.row}
                    </span>
                    <span role="cell" dir="auto">
                      <b>{r.name || "No name"}</b>
                      <small>{row.regions.join(", ")}</small>
                    </span>
                    <span role="cell">{row.titles.length ? `${row.titles.length} ${row.titles.length === 1 ? "title" : "titles"}` : "Owners and founders"}</span>
                    <span role="cell">{row.keywords.length}</span>
                    <span role="cell" className="icp-st">
                      {r.error ? (
                        <em>{r.error}</em>
                      ) : (
                        <i>
                          <Icon id="check" /> Ready
                        </i>
                      )}
                      {note.length ? <small>{note.join(" · ")}</small> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
