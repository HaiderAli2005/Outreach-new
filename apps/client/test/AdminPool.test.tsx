import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminPool from "@/app/admin/pool/page";
import { json } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10));
const view = {
  cachedAt: new Date().toISOString(),
  charts: {
    daily: days.map((day, i) => ({ day, sends: 400 + i * 10, bad: 4, badRate: 0.01, capacity: i < 20 ? null : 900, committed: i < 20 ? null : 500 })),
    ewma: [0, 0.5],
    domains: { REGISTERED: 0, AGING: 0, WARMING: 2, ACTIVE: 10, DEGRADED: 1, RETIRED: 0 },
    mailboxes: { CONNECTING: 0, ERROR: 0, WARMING: 6, ACTIVE: 30, REPLIES_ONLY: 3, RETIRED: 0 },
    burnImpact: { mailboxes: 3, domains: 1, capacityLost: 90, monthlyCostCents: 1025, monthlyCost: "$10.25", liveConversations: 7, sequencesRunning: 12, customersAffected: 4 },
  },
  health: { activeDomains: 10, activeMailboxes: 30, warmingDomains: 2, warmingMailboxes: 6, repliesOnlyMailboxes: 1, retiredThisMonth: 0 },
  burn: { degraded7: 1, degraded30: 2, ewmaWeeklyBurn: 0.5, burnRatePerMonth: "20.0%", predicted30: { total: 2, atRisk: 0, background: 2 }, weekly: [0, 1], dilution: 3, dilutionRegime: "weak" },
  shelf: {
    warmShelf: 2, runwayWeeks: 4, reorderNeeded: true, domainsToBuy: 5,
    reorderBecause: { burnReplacement: 3, spareShortfall: 13, demandShortfall: 0, driver: "spareShortfall" },
    targets: { spareDomainsMin: 15, spareMultiplier: 1, maxBuyPerBatch: 5, leadTimeWeeks: 9, agingDays: 30, warmupDays: 29 },
    pipeline: { aging: 0, "d1-7": 1, "d8-14": 1 },
    warming: [
      { id: "d1", domain: "fastlane.com", status: "WARMING", warmupDay: 20, daysRemaining: 9, activeOn: "2026-10-20T00:00:00Z", capToday: 60, mailboxes: 3, bounce7: 0.004, sends7: 250, held: false, behindDays: 0 },
      { id: "d2", domain: "slowbrook.co", status: "WARMING", warmupDay: 14, daysRemaining: 15, activeOn: "2026-10-26T00:00:00Z", capToday: 30, mailboxes: 3, bounce7: 0.031, sends7: 120, held: true, behindDays: 4 },
    ],
  },
  burned: [{ id: "b1", domain: "oldport.org", kind: "degraded", on: "2026-10-05T00:00:00Z", reason: "6.0% of its last 200 emails bounced", reasonKind: "bounces", bounceRate: 0.06, sends: 200, daysLasted: 41, forcedFromDay: null }],
  forced: [],
  capacity: { total: 900, committed: 500, internal: 0, sentToday: 320, headroom: "44.4%", roomFor500PerDay: 0, domainDailyCap: 90 },
  paused: [],
  authentication: { unverified: [] },
  cost: { monthlyRevenue: "$500.00" },
  economics: {
    windowDays: 30,
    paceDays: 7,
    price: 0.04,
    emails: 12500,
    lines: [
      { key: "infrastructure", label: "Infrastructure (mailboxes and domains)", month: 100, perEmail: 0.008 },
      { key: "ai", label: "AI (writing, fact checks, replies)", month: 25, perEmail: 0.002 },
      { key: "data", label: "Data (Apollo)", month: 50, perEmail: 0.004 },
      { key: "verification", label: "Verification (MillionVerifier)", month: 5, perEmail: 0.0004 },
      { key: "fees", label: "Card fees (Stripe)", month: 20, perEmail: 0.0016 },
    ],
    total: { month: 200, perEmail: 0.016 },
    margin: { perEmail: 0.024, perEmailPct: 60, revenueMonth: 500, month: 300, monthPct: 60 },
    ai: { byPurpose: [{ purpose: "reply", calls: 40, usd: 4, perCall: 0.1, avgInputTokens: 9000, avgOutputTokens: 500 }, { purpose: "personalize", calls: 3000, usd: 21, perCall: 0.007, avgInputTokens: 2500, avgOutputTokens: 900 }], unmeasuredCalls: 12 },
    usage: { peopleEnriched: 1000, searches: 50, emailsVerified: 8000, payments: 6 },
    perDomain: [
      { id: "w1", domain: "warmone.com", status: "WARMING", warmupDay: 3, mailboxes: 3, perDay: 5, monthlyInfra: 13.25, infraPerEmail: 0.0883, costPerEmail: 0.0963, marginPerEmail: -0.0563 },
      { id: "a1", domain: "liveone.com", status: "ACTIVE", warmupDay: 30, mailboxes: 3, perDay: 90, monthlyInfra: 13.25, infraPerEmail: 0.0049, costPerEmail: 0.0129, marginPerEmail: 0.0271 },
    ],
    pricesUpdatedAt: new Date().toISOString(),
  },
  atRisk: [],
  footprint: { registrar: [], nameserverSet: [], ipPool: [] },
  reorders: [],
  unmatched: { open: 0, daily: [] },
};

const server = () =>
  mockServer({
    "GET /admin/pool": () => json({ data: view }),
    "GET /admin/pool?fresh=1": () => json({ data: view }),
    "GET /admin/pool/settings": () => json({ data: { spareDomainsMin: 15, spareMultiplier: 1, maxBuyPerBatch: 5, maxBuyPerDay: 10, autoBuyEnabled: false, updatedAt: new Date().toISOString() } }),
    "POST /admin/pool/domains/d2/activate-now": () => json({ data: { domain: "slowbrook.co", fromDay: 14, bounce7: 0.031 } }),
    "GET /admin/costs": () => json({ data: { aiPrices: { "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 }, default: { input: 2, cachedInput: 0.5, output: 8 } }, apolloPerEnrichUsd: 0.03, apolloPerSearchUsd: 0, verifyPerEmailUsd: 0.0006, paymentFeePercent: 2.9, paymentFeeFixedUsd: 0.3, mailboxMonthUsd: 4, repliesOnlyMailboxMonthUsd: 3, domainYearUsd: 15 } }),
    "PATCH /admin/costs": (body) => json({ data: body }),
  });

describe("Admin pool", () => {
  it("opens on graphs that answer capacity, burn and restock in plain words", async () => {
    server();
    renderWithStore(<AdminPool />);
    expect(await screen.findByText(/Enough\. 400 emails a day are free/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Charts" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/3 mailboxes on 1 domain burned\. They still carry 7 live conversations for 4 customers and cost \$10\.25 a month/)).toBeInTheDocument();
    expect(screen.getByText("Buy 5 domains today.")).toBeInTheDocument();
    expect(screen.getByText("of 15 minimum")).toBeInTheDocument();
    expect(screen.getByText("Below the minimum: 2 of 15 spares")).toBeInTheDocument();
    expect(screen.getByText("+13")).toBeInTheDocument();
    expect(screen.getByText("Spares last 4.0 weeks, a new one takes 9")).toBeInTheDocument();
    expect(screen.getByText("Customers fit in today's capacity")).toBeInTheDocument();
    expect(screen.getByText(/The biggest need is 13\. We buy 5 at a time, so the rest comes in the next batch/)).toBeInTheDocument();
    expect(screen.getByText("warmup day 20 of 29")).toBeInTheDocument();
    expect(screen.getByText("held 4 days")).toBeInTheDocument();
    expect(screen.getByText("in 9 days")).toBeInTheDocument();
    expect(screen.getByText("replies only")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Sent, Capacity, Asked for/ })).toBeInTheDocument();
    // What an operator acts on is on the default view too: switching how numbers are drawn never hides a control.
    expect(screen.getAllByRole("columnheader", { name: "Burned on" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Activate now" })).toHaveLength(2);
    // The switch that bought nothing is gone, and the page says plainly that nothing is bought automatically.
    expect(await screen.findByText(/Nothing is bought automatically/)).toBeInTheDocument();
    expect(screen.queryByText("Automatic buying")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Most domains bought a day")).not.toBeInTheDocument();
  });

  it("recalculates on request, and claims no runway while nothing burns", async () => {
    const { calls } = server();
    view.shelf.runwayWeeks = null as unknown as number;
    view.burn.ewmaWeeklyBurn = 0;
    try {
      renderWithStore(<AdminPool />);
      expect(await screen.findByText("No domain has burned yet, so none to replace")).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/last \d+(\.\d)?\+? weeks/);
      await userEvent.click(screen.getByRole("button", { name: "Recalculate" }));
      await waitFor(() => expect(calls.some((c) => c.path === "/admin/pool?fresh=1")).toBe(true));
    } finally {
      view.shelf.runwayWeeks = 4;
      view.burn.ewmaWeeklyBurn = 0.5;
    }
  });

  it("shows why a domain burned, the warming shelf with held domains flagged, and what drives the reorder", async () => {
    const { calls } = server();
    renderWithStore(<AdminPool />);
    await userEvent.click(await screen.findByRole("button", { name: "Numbers" }));
    expect(await screen.findByText("6.0% of its last 200 emails bounced")).toBeInTheDocument();
    for (const h of ["Domain", "Burned on", "Why", "Bad rate", "Days it lasted"]) expect(screen.getAllByRole("columnheader", { name: h }).length).toBeGreaterThan(0);
    expect(screen.getByText(/day 20 of 29, active around 20 October/)).toBeInTheDocument();
    expect(screen.getByText("held 4 days, look at it")).toBeInTheDocument();
    expect(screen.getByText("spare domains are below the minimum")).toBeInTheDocument();

    const row = screen.getByText("slowbrook.co").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Activate now" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("warmup day 14 of 29");
    expect(dialog).toHaveTextContent("3.1%");
    expect(dialog).toHaveTextContent("raises the risk of burning it");
    const promote = within(dialog).getByRole("button", { name: "Promote now" });
    expect(promote).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox"), "Big customer starts Monday");
    await userEvent.click(promote);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ reason: "Big customer starts Monday" }));
  });

  it("shows the real cost of an email, per email, per month and per domain, and lets prices be changed", async () => {
    const { calls } = server();
    renderWithStore(<AdminPool />);
    expect(await screen.findByText(/Each email costs us \$0\.0160 and is charged \$0\.0400: 60% gross margin/)).toBeInTheDocument();
    expect(screen.getByText("Card fees (Stripe)")).toBeInTheDocument();
    expect(screen.getByText("Reading a reply and drafting the answer")).toBeInTheDocument();
    expect(screen.getByText(/12 counted AI calls have no token record/)).toBeInTheDocument();
    expect(screen.getByText("warming, day 3")).toBeInTheDocument();
    expect(screen.getByText("-$0.0563")).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/1 domain costs more per email than we charge/);
    // Mailbox and domain prices are editable like every other unit price.
    expect(await screen.findByLabelText("Mailbox, per month ($)")).toHaveValue(4);
    expect(screen.getByLabelText("Domain, per year ($)")).toHaveValue(15);
    const fee = await screen.findByLabelText(/MillionVerifier, per address/);
    await userEvent.clear(fee);
    await userEvent.type(fee, "0.001");
    await userEvent.click(screen.getByRole("button", { name: "Save prices" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && c.path === "/admin/costs")?.body).toMatchObject({ verifyPerEmailUsd: 0.001 }));
  });
});
