import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { campaignsFromCsv, parseCsv, templateCsv } from "@/lib/campaignCsv";
import { ImportCampaigns } from "@/components/app/ImportCampaigns";
import { sessionReceived } from "@/store/authSlice";
import { json, session } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

describe("Campaign CSV", () => {
  it("reads quoted cells, semicolon lists, sizes and both kinds of campaign", () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3\n')).toEqual([["a", "b, c", 'd "e"'], ["1", "2", "3"]]);
    const csv = [
      "Campaign name,People,Job titles,Exact titles,Keywords,Locations,Company size",
      'Law · owners,owners,,,"law firm; lawyers, legal",Saudi Arabia,1-10; 11-20; 21-50; 101-200',
      "Law · managers,titles,head of business development; marketing manager,no,law firm,Saudi Arabia; UAE,huge",
    ].join("\n");
    const { rows, problems, notes } = campaignsFromCsv(csv);
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ name: "Law · owners", titles: [], seniorities: ["owner", "founder", "c_suite", "partner"], keywords: ["law firm", "lawyers, legal"], sizes: ["1,10", "11,50", "51,200"], includeSimilarTitles: false });
    expect(rows[1]).toMatchObject({ titles: ["head of business development", "marketing manager"], includeSimilarTitles: true, regions: ["Saudi Arabia", "UAE"], seniorities: ["vp", "head", "director", "manager", "senior"], sizes: [] });
    expect(notes[1]).toEqual(["Company size not recognised: huge"]);
    expect(campaignsFromCsv("name,locations\nX,KSA").problems[0]).toMatch(/keywords/);
    const tpl = campaignsFromCsv(templateCsv());
    expect(tpl.rows).toHaveLength(3);
    expect(tpl.rows[2]).toMatchObject({ source: "both", namedOnly: false, mapsCities: ["Riyadh", "Jeddah", "Dammam"] });
    const maps = campaignsFromCsv("name,keywords,locations,source,named_only,maps_cities\nShops,oud,Saudi Arabia,Google Maps,yes,Riyadh\nX,oud,KSA,fax,,").rows;
    expect(maps[0]).toMatchObject({ source: "maps", namedOnly: true, mapsCities: ["Riyadh"] });
    expect(campaignsFromCsv("name,keywords,locations,source\nX,oud,KSA,fax").notes[0][0]).toMatch(/Source not recognised/);
  });

  it("checks every row, shows what to fix, and creates them only when all are ready", async () => {
    let fixed = false;
    const { calls } = mockServer({
      "POST /setup/targeting/audiences/import": (b: unknown) => {
        const body = b as { check: boolean; rows: unknown[] };
        if (!fixed) return json({ data: { ok: false, created: [], problem: null, rows: [{ row: 1, name: "A", error: null }, { row: 2, name: "B", error: "Add at least one location." }] } });
        return json({ data: { ok: true, created: body.check ? [] : [{ id: "c1", name: "A" }, { id: "c2", name: "B" }], problem: null, rows: [{ row: 1, name: "A", error: null }, { row: 2, name: "B", error: null }] } });
      },
    });
    const done = vi.fn();
    const { store } = renderWithStore(<ImportCampaigns onClose={() => undefined} onDone={done} />);
    store.dispatch(sessionReceived(session));
    const file = (text: string) => new File([text], "plan.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText("CSV file"), file("name,keywords,locations\nA,audit,Saudi Arabia\nB,audit,\n"));
    expect(await screen.findByText("Add at least one location.")).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 rows need a fix/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create campaigns" })).toBeDisabled();
    fixed = true;
    await userEvent.upload(screen.getByLabelText("CSV file"), file("name,keywords,locations\nA,audit,Saudi Arabia\nB,audit,Saudi Arabia\n"));
    await userEvent.click(await screen.findByRole("button", { name: "Create 2 campaigns" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith([{ id: "c1", name: "A" }, { id: "c2", name: "B" }]));
    expect(calls.filter((c) => c.path === "/setup/targeting/audiences/import").map((c) => (c.body as { check: boolean }).check)).toEqual([true, true, false]);
  });
});
