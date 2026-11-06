import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ImportMailboxesModal } from "@/components/admin/ImportMailboxes";
import type { MailboxImport } from "@/lib/types";
import { json } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

const preview: MailboxImport = {
  columns: { address: "Email Address", appPassword: "App Password", firstName: "First Name" },
  platform: "google",
  auth: "password",
  domains: [
    { name: "bytepath.com", exists: false, add: [{ line: 2, address: "madison@bytepath.com", name: "Madison Reed" }], skip: [{ line: 3, address: "daniel@bytepath.com", message: "Already in the pool" }], error: null },
    { name: "four.io", exists: false, add: [], skip: [], error: "four.io would hold 4 mailboxes. A domain holds at most 3" },
  ],
  problems: [{ line: 9, address: null, message: "No email on this row" }],
  totals: { mailboxes: 6, toAdd: 1, domains: 2, newDomains: 1, skipped: 1, failed: 1 },
  done: false,
};

describe("Upload warmed mailboxes", () => {
  it("reads the file, shows what will happen without adding anything, then adds on one press", async () => {
    const { calls } = mockServer({
      "POST /admin/domains/import": (body) =>
        (body as { commit: boolean }).commit
          ? json({ data: { ...preview, done: true, totals: { ...preview.totals, signedIn: 1 }, domains: [{ ...preview.domains[0], added: [{ address: "madison@bytepath.com", ok: true }] }, preview.domains[1]] } })
          : json({ data: preview }),
    });
    renderWithStore(<ImportMailboxesModal onClose={() => undefined} />);
    expect((screen.getByRole("button", { name: "Check file" }) as HTMLButtonElement).disabled).toBe(true);
    const file = new File(["Email Address,App Password\nmadison@bytepath.com,abcd efgh ijkl mnop\n"], "mailboxes.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
    expect(await screen.findByText("mailboxes.csv")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "App password" }));
    fireEvent.click(screen.getByRole("button", { name: "Check file" }));

    expect(await screen.findByText("madison@bytepath.com")).toBeTruthy();
    expect(screen.getByText(/6 mailboxes on 2 domains\. 1 will be added/)).toBeTruthy();
    expect(screen.getByText(/at most 3/)).toBeTruthy();
    expect(screen.getByText(/Row 9: No email on this row/)).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ platform: "google", auth: "password", region: "global", locale: "en", commit: false });
    expect((calls[0].body as { csv: string }).csv).toContain("madison@bytepath.com");

    fireEvent.click(screen.getByRole("button", { name: "Add 1 mailbox" }));
    expect(await screen.findByText("Signed in")).toBeTruthy();
    expect(calls.filter((c) => (c.body as { commit: boolean }).commit)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("signs Google mailboxes in with Google by default, and says to press Connect with Google after", async () => {
    const added = { ...preview, auth: "google" as const, done: true, totals: { ...preview.totals, signedIn: 0 }, domains: [{ ...preview.domains[0], added: [{ id: "m1", address: "madison@bytepath.com", ok: false, error: "No Google connection" }] }] };
    const { calls } = mockServer({
      "POST /admin/domains/import": (body) => json({ data: (body as { commit: boolean }).commit ? added : { ...preview, auth: "google" } }),
      "POST /admin/mailboxes/m1/google/connect": () => json({ data: { error: "Connect with Google is off" } }),
    });
    renderWithStore(<ImportMailboxesModal onClose={() => undefined} />);
    expect(screen.getByText(/any password in it is ignored/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [new File(["email\nmadison@bytepath.com"], "boxes.csv")] } });
    await screen.findByText("boxes.csv");
    fireEvent.click(screen.getByRole("button", { name: "Check file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add 1 mailbox" }));
    expect(await screen.findByText("Added · waiting for Google sign-in")).toBeTruthy();
    expect(screen.getByText(/One step left: connect each mailbox to Google/)).toBeTruthy();
    expect(screen.queryByText("No Google connection")).toBeNull();
    expect(calls.map((c) => (c.body as { auth: string }).auth)).toEqual(["google", "google"]);
    fireEvent.click(screen.getByRole("button", { name: "Connect with Google" }));
    expect(await screen.findByText("Connect with Google is off")).toBeTruthy();
    expect(calls.at(-1)?.path).toBe("/admin/mailboxes/m1/google/connect");
  });

  it("refuses a file that isn't a CSV before sending it", async () => {
    const { calls } = mockServer({});
    renderWithStore(<ImportMailboxesModal onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [new File(["x"], "mailboxes.xlsx")] } });
    expect(await screen.findByText(/Choose a \.csv file/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Check file" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
