import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CockpitPage from "@/app/app/page";
import type { Cockpit, Performance } from "@/lib/types";
import { catalogue, json, session } from "./fixtures";
import { sessionReceived } from "@/store/authSlice";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

const cockpit = (over: Partial<Cockpit> = {}): Cockpit => ({
  engine: { on: true, state: "running", todaySent: 0, todayTarget: 500, dayKey: "2026-10-09", weekday: 5, window: "09:00–17:00", windowStart: "09:00", capacityLiveOn: null },
  budget: { emailsPerDay: 500, perDay: "$20", deciCents: "20000" },
  progress: { found: 412, verified: 180, written: 0, sentEver: false, results: { sent: 0, delivered: 0, bounceRate: "0.0%", replies: 0 } },
  milestones: { contacts: true, sent: false, replied: false },
  outlook: { next: null, nextProspectTz: null, inDay: 0, lastInDay: null, firstsToday: 0, cap: 100, window: { tz: "America/New_York", start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5], open: true, closesAt: null, opensAt: null }, reason: "nothing-ready" },
  needsYou: { firstBatch: null, awaitingApproval: 0, pendingWeeks: [], repliesWaiting: 0, urgentReplies: 0, latestReplies: [] },
  week: { sent: 0, replies: 0, found: 0, companies: 0 },
  lastWeek: { sent: 0, replies: 0, found: 0, companies: 0 },
  heartbeat: [],
  journey: { found: 412, written: 0, contacted: 0, replied: 0 },
  activity: [],
  markets: [],
  credits: { balance: "$10.00", emailsLeft: 250, runwayDays: 0, lasts: "about half a day", stage: "trial", warnings: { low: false, runway: false, empty: false } },
  ...over,
});

const zero = { sent: 0, firstEmails: 0, followUps: 0, delivered: 0, bounced: 0, replies: 0, hot: 0, spentDecicents: 0, spent: "$0.00" };
const perf = (days: 7 | 30 = 7, over: Partial<Performance> = {}): Performance => ({
  days,
  series: Array.from({ length: days }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, sent: 0, delivered: 0, bounced: 0, replies: 0, hot: 0, spentDecicents: 0 })),
  totals: { ...zero, pricePerEmail: "$0.04" },
  previous: zero,
  audiences: [],
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

function show(c: Cockpit, p: (days: 7 | 30) => Performance = (d) => perf(d)) {
  return mockServer({
    "GET /dashboard/cockpit": () => json({ data: c }),
    "GET /dashboard/performance?days=7": () => json({ data: p(7) }),
    "GET /dashboard/performance?days=30": () => json({ data: p(30) }),
    "GET /dashboard/budget": () => json({ data: { budget: "20000", spentToday: "0", emailsPerDay: 500, sentToday: 0, peopleToday: 0, state: "running", nudge: null } }),
    "GET /billing/plans": () => json({ data: catalogue }),
  });
}

describe("Cockpit", () => {
  it("shows the budget the customer chose as one line, and never writes it back by rendering", async () => {
    const { calls } = show(cockpit());
    const { store } = renderWithStore(<CockpitPage />);
    store.dispatch(sessionReceived(session));
    expect(await screen.findByText("Sending 500 a day · $20 a day")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(await screen.findByText("$20 a day")).toBeInTheDocument();
    expect((screen.getByLabelText("Daily budget in dollars") as HTMLInputElement).value).toBe("20");
    await waitFor(() => expect(calls.filter((c) => c.path === "/settings" && c.method === "PATCH")).toHaveLength(0));
  });

  it("before the first email shows progress, states the free credit as a fact and shows no time zone nobody chose", async () => {
    show(cockpit());
    const { container } = renderWithStore(<CockpitPage />);
    expect(await screen.findByText("Finding your first people")).toBeInTheDocument();
    expect(screen.getByText(/412 found · 180 verified/)).toBeInTheDocument();
    expect(screen.getByText(/free credit covers about 250 emails/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/running low|Europe\/London|UTC/);
    expect(screen.queryByRole("link", { name: "Top up" })).not.toBeInTheDocument();
  });

  it("never says sending is on schedule with no capacity", async () => {
    show(cockpit({ engine: { ...cockpit().engine, state: "capacity", capacityLiveOn: "12 November" } }));
    const { container } = renderWithStore(<CockpitPage />);
    expect((await screen.findAllByText(/goes live on 12 November/)).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/on schedule/);
  });

  it("while the first people wait for approval, says so and leads to the approval instead of saying all is well", async () => {
    show(cockpit({ engine: { ...cockpit().engine, state: "approval" }, progress: { ...cockpit().progress, written: 20 }, needsYou: { ...cockpit().needsYou, firstBatch: { ready: 20, needed: 20, finding: false, found: 412, written: 20, problem: null } } }));
    const { container } = renderWithStore(<CockpitPage />);
    expect(await screen.findByText("Waiting for your approval")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review and approve" })).toHaveAttribute("href", "/app/approve");
    expect(screen.getByText(/Your first 20 people and their emails are ready/)).toBeInTheDocument();
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Nothing needs you|Sending/);
  });

  it("while finding, shows the real numbers and that the work is in progress", async () => {
    show(cockpit({ engine: { ...cockpit().engine, state: "preparing" }, needsYou: { ...cockpit().needsYou, firstBatch: { ready: 0, needed: 20, finding: true, found: 412, written: 6, problem: null } } }));
    renderWithStore(<CockpitPage />);
    expect(await screen.findByText("Getting ready")).toBeInTheDocument();
    expect(screen.getByText(/412 found · 180 verified · 6 emails written/)).toBeInTheDocument();
    expect(screen.getByText("Working on it")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review and approve" })).not.toBeInTheDocument();
  });

  it("says why the first search stopped and offers to search again", async () => {
    show(cockpit({ engine: { ...cockpit().engine, state: "preparing" }, needsYou: { ...cockpit().needsYou, firstBatch: { ready: 0, needed: 20, finding: false, found: 0, written: 0, problem: "No one matched your audiences." } } }));
    const r = renderWithStore(<CockpitPage />);
    r.store.dispatch(sessionReceived(session));
    expect(await screen.findByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("No one matched your audiences.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Search again/ })).toBeInTheDocument();
  });

  it("shows what was sent, delivered, answered and spent, per campaign, for 7 or 30 days", async () => {
    const totals = { sent: 1200, firstEmails: 800, followUps: 400, delivered: 1180, bounced: 20, replies: 40, hot: 8, spentDecicents: 48_000, spent: "$48.00" };
    const { calls } = show(cockpit({ progress: { ...cockpit().progress, sentEver: true } }), (days) =>
      perf(days, {
        totals: { ...totals, pricePerEmail: "$0.04" },
        previous: { ...totals, sent: 1000, hot: 4, delivered: 980, spentDecicents: 40_000, spent: "$40.00" },
        audiences: [{ id: "g1", name: "Founders", state: "sending", found: 600, sent: 1200, perDay: 171, replies: 40, replyRate: 5, hot: 8, spent: "$48.00", costPerLead: "$6.00" }],
      }),
    );
    renderWithStore(<CockpitPage />);
    expect((await screen.findAllByText("1,200")).length).toBe(2);
    expect(screen.getByText("98.3%")).toBeInTheDocument();
    expect(screen.getAllByText("+20%")).toHaveLength(2);
    expect(screen.getByText(/\+0\.3 pts/)).toBeInTheDocument();
    expect(screen.getByText("+100%")).toBeInTheDocument();
    expect(screen.getAllByText("$48.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$6.00").length).toBe(2);
    expect(screen.getByText("Founders")).toBeInTheDocument();
    expect(screen.getByText("about 171 a day")).toBeInTheDocument();
    expect(screen.getAllByText("5.0%")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "30 days" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/dashboard/performance?days=30")).toBe(true));
    expect(await screen.findByText(/last 30 days, compared/)).toBeInTheDocument();
  });

  it("shows when the next email really goes out, with the prospect's local time", async () => {
    const next = new Date(Date.now() + 2 * 3_600_000);
    const last = new Date(next.getTime() + 60_000);
    show(cockpit({ progress: { ...cockpit().progress, sentEver: true }, outlook: { ...cockpit().outlook, next: next.toISOString(), nextProspectTz: "America/New_York", inDay: 10, lastInDay: last.toISOString(), reason: null } }));
    renderWithStore(<CockpitPage />);
    expect(await screen.findByText(/^Next email at /)).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/for them in New York/);
    expect(document.body.textContent).toMatch(/9 more (today|in the next 24 hours) between/);
  });

  it("says in plain words why nothing is scheduled", async () => {
    const opens = new Date(Date.now() + 10 * 3_600_000).toISOString();
    show(cockpit({ outlook: { ...cockpit().outlook, reason: "outside-window", window: { ...cockpit().outlook.window, open: false, opensAt: opens } } }));
    renderWithStore(<CockpitPage />);
    expect(await screen.findByText(/Sending is closed for your prospects in New York until/)).toBeInTheDocument();
  });
});
