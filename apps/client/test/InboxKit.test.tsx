import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxKitSetup, OrderDomainsModal, WarmupBoard } from "@/components/admin/InboxKit";
import type { InboxKitPipeline, InboxKitPlan, InboxKitStatus, SupplierOrder } from "@/lib/types";
import { json } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

const plan: InboxKitPlan = {
  suggested: { domains: 2, mailboxes: 6 },
  maths: { committedPerDay: 100, perMailbox: 30, neededMailboxes: 4, spareShare: 0.2, spareMailboxes: 1, weeklyBurnDomains: 0, weeksToSend: 8, burnMailboxes: 0, sendingMailboxes: 1, onTheWayMailboxes: 0, orderedMailboxes: 0, haveMailboxes: 1, shortMailboxes: 4 },
  pool: { capacityPerDay: 30, committedPerDay: 100 },
  limits: { perBatch: 5, perDay: 10, placedToday: 0, perQuote: 50 },
  blockers: [],
};

const quoted = (over: Partial<SupplierOrder> = {}): SupplierOrder => ({
  id: "o1",
  status: "QUOTED",
  platform: "GOOGLE",
  region: "global",
  requested: 2,
  placed: 0,
  pending: 2,
  rejected: 0,
  estimate: { domains: 2, mailboxes: 6, domainsUsd: 24, mailboxMonthUsd: 18, warmupMonthUsd: 18, firstMonthUsd: 60, perMonthUsd: 38, perEmailUsd: 0.0096, unit: { mailboxMonthUsd: 3, warmupMonthUsd: 3, avgDomainUsd: 12 }, walletUsd: 1000, schedule: [{ day: "2026-10-23", domains: 2 }] },
  lastError: null,
  nextRunAt: null,
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  confirmedAt: null,
  createdAt: new Date().toISOString(),
  short: 0,
  items: [
    { id: "i1", domain: "bytepath.com", priceUsd: 12, status: "PENDING", message: null, mailboxes: [{ email: "madison@bytepath.com", name: "Madison Reed" }], placedAt: null },
    { id: "i2", domain: "lift-prism.org", priceUsd: 12, status: "PENDING", message: null, mailboxes: [{ email: "daniel@lift-prism.org", name: "Daniel Cole" }], placedAt: null },
  ],
  ...over,
});

describe("Order new domains", () => {
  it("suggests a number, checks names and price, and orders only after one confirmation", async () => {
    const { calls } = mockServer({
      "GET /admin/inboxkit/plan": () => json({ data: plan }),
      "POST /admin/inboxkit/quote": () => json({ data: quoted() }, 201),
      "POST /admin/inboxkit/orders/o1/confirm": () => json({ data: quoted({ status: "SCHEDULED", placed: 2, pending: 0 }) }),
    });
    renderWithStore(<OrderDomainsModal onClose={() => undefined} />);
    expect(await screen.findByText("2")).toBeTruthy();
    // Every step of the number is on screen.
    expect(screen.getByText(/100 emails a day ÷ 30 per mailbox/)).toBeTruthy();
    expect(screen.getByText(/none measured yet/)).toBeTruthy();
    expect(screen.getByText("4 → 2 domains")).toBeTruthy();
    const input = screen.getByLabelText("How many domains to order") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("2"));
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Check names and price" }));

    expect(await screen.findByText("bytepath.com")).toBeTruthy();
    expect(calls.find((c) => c.path === "/admin/inboxkit/quote")?.body).toEqual({ domains: 2, region: "global", locale: "en" });
    expect(screen.getByText("$60.00")).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Order 2 domains/ }));
    expect(await screen.findByText(/2 domains ordered at InboxKit now/)).toBeTruthy();
    expect(calls.filter((c) => c.path.endsWith("/confirm"))).toHaveLength(1);
  });

  it("won't check prices until InboxKit is set up, and says what is missing", async () => {
    mockServer({ "GET /admin/inboxkit/plan": () => json({ data: { ...plan, blockers: ["Paste your InboxKit API key (InboxKit, Settings > API)."] } }) });
    renderWithStore(<OrderDomainsModal onClose={() => undefined} />);
    expect(await screen.findByText(/Paste your InboxKit API key/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Check names and price" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("New domains board", () => {
  it("shows each domain's stage, how far its warmup is, and its mailboxes' health", async () => {
    const board: InboxKitPipeline = {
      counts: { setting_up: 1, dns: 0, warmup_booked: 0, warming: 1, held: 0, ladder: 0, live: 0, burned: 0 },
      orders: [],
      domains: [
        { id: "d1", name: "bytepath.com", stage: "warming", label: "Warming at InboxKit", day: 12, of: 28, readyOn: "2026-11-20T00:00:00Z", note: null, orderedAt: "2026-10-23T00:00:00Z", syncedAt: null, mailboxes: [{ id: "m1", address: "madison@bytepath.com", status: "CONNECTING", supplierStatus: "active", warmup: "active", health: "excellent", score: 91, inboxRate: 96, supplierDay: 12, capToday: 0, error: null }] },
        { id: "d2", name: "lift-prism.org", stage: "setting_up", label: "InboxKit is setting it up", day: null, of: null, readyOn: null, note: "InboxKit: registration in progress", orderedAt: "2026-10-23T00:00:00Z", syncedAt: null, mailboxes: [] },
      ],
    };
    mockServer({ "GET /admin/inboxkit/pipeline": () => json({ data: board }) });
    renderWithStore(<WarmupBoard />);
    expect(await screen.findByText("bytepath.com")).toBeTruthy();
    expect(screen.getByText(/Day 12 of 28/)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "bytepath.com progress" }).getAttribute("aria-valuenow")).toBe("43");
    expect(screen.getByText(/inbox 96%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Setting up/ }));
    await waitFor(() => expect(screen.queryByText("bytepath.com")).toBeNull());
    expect(screen.getByText("lift-prism.org")).toBeTruthy();
  });
});

const status: InboxKitStatus = {
  key: { set: true, source: "store" },
  connected: true,
  error: null,
  wallet: 0,
  prices: { mailboxMonthUsd: 3, warmupMonthUsd: 3 },
  workspaces: [{ uid: "ws1", name: "Corporate Initiative" }],
  settings: { workspaceUid: null, workspaceName: null, contact: null, redirectUrl: null, platform: "GOOGLE", warmupDays: 28, keepWarmupAfterLive: true, maxDomainPriceUsd: 20 },
  webhook: { url: "https://api.example.com/api/v1/inboxkit/webhook", signature: "" },
  blockers: ["Choose the InboxKit workspace new domains go into."],
};

describe("InboxKit setup form", () => {
  it("says which field is wrong, under that field, before anything is sent", async () => {
    const { calls } = mockServer({ "GET /admin/inboxkit": () => json({ data: status }) });
    renderWithStore(<InboxKitSetup />);
    fireEvent.change(await screen.findByLabelText(/Each domain forwards to/), { target: { value: "http://ekhata.ai" } });
    fireEvent.change(screen.getByLabelText(/Phone, with country code/), { target: { value: "phone please" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/starting with https:\/\//)).toBeTruthy();
    expect(screen.getByText(/Digits with the country code/)).toBeTruthy();
    expect(screen.getByText("Fix the 2 fields marked in red.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("shows the server's reason under the field too, and the country is picked from a list", async () => {
    mockServer({
      "GET /admin/inboxkit": () => json({ data: status }),
      "PATCH /admin/inboxkit/settings": () => json({ error: { code: "VALIDATION_ERROR", message: "Some fields are invalid", details: [{ path: "contact.city", message: "Too long" }] } }, 400),
    });
    renderWithStore(<InboxKitSetup />);
    fireEvent.change(await screen.findByLabelText(/^City/), { target: { value: "Lahore" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Too long")).toBeTruthy();
    expect(screen.getByText("Some fields are invalid: City: Too long")).toBeTruthy();
    expect(screen.queryByLabelText(/Country \(2 letters\)/)).toBeNull();
  });
});

describe("InboxKit setup form, what is still needed", () => {
  it("marks every empty field that ordering needs, and never looks like nothing happened", async () => {
    mockServer({ "GET /admin/inboxkit": () => json({ data: { ...status, settings: { ...status.settings, redirectUrl: "https://ekhata.ai/en-pk", contact: { first_name: "Z", last_name: "I", email: "z@e.ai", phone: "+92 300 1234567", address_line1: "1 Main", city: "Lahore", country: "PK", postal_code: "54000" } } } }) });
    renderWithStore(<InboxKitSetup />);
    expect(await screen.findByText("Choose one. Needed before you can order")).toBeTruthy();
    // Only State is missing from the contact, and its section is open to show it.
    expect(screen.getAllByText("Needed before you can order")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/Nothing new to save yet/)).toBeTruthy();
  });
});

describe("Order new domains, setup not finished", () => {
  it("asks for only what is missing, saves it in the window, and then unlocks the price check", async () => {
    let ready = false;
    const contact = { first_name: "Z", last_name: "I", email: "z@e.ai", phone: "+92 300 1234567", address_line1: "1 Main", city: "Lahore", country: "PK", postal_code: "54000" };
    const { calls } = mockServer({
      "GET /admin/inboxkit/plan": () => json({ data: { ...plan, blockers: ready ? [] : ["Choose the InboxKit workspace new domains go into.", "Fill in the registrant contact (missing: state)."] } }),
      "GET /admin/inboxkit": () => json({ data: { ...status, settings: { ...status.settings, redirectUrl: "https://ekhata.ai", contact } } }),
      "PATCH /admin/inboxkit/settings": () => {
        ready = true;
        return json({ data: { ...status, blockers: [], settings: { ...status.settings, workspaceUid: "ws1", redirectUrl: "https://ekhata.ai", contact: { ...contact, state: "Punjab" } } } });
      },
    });
    renderWithStore(<OrderDomainsModal onClose={() => undefined} />);
    expect(await screen.findByText(/Finish the InboxKit setup here/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Check names and price" }) as HTMLButtonElement).disabled).toBe(true);
    // Only the two missing things are asked for.
    expect(screen.queryByLabelText("City")).toBeNull();
    fireEvent.change(screen.getByLabelText("State or province"), { target: { value: "Punjab" } });
    await userEvent.click(screen.getByRole("button", { name: "Workspace new domains go into" }));
    await userEvent.click(await screen.findByRole("option", { name: "Corporate Initiative" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Check names and price" }) as HTMLButtonElement).disabled).toBe(false));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ workspaceUid: "ws1", contact: { state: "Punjab" } });
  });
});
