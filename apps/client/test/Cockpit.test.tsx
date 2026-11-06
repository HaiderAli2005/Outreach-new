import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
  period: days === 30 ? "30d" : "7d",
  campaign: null,
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
    "GET /dashboard/performance?period=7d": () => json({ data: p(7) }),
    "GET /dashboard/performance?period=30d": () => json({ data: p(30) }),
    "GET /dashboard/budget": () => json({ data: { budget: "20000", spentToday: "0", emailsPerDay: 500, sentToday: 0, peopleToday: 0, state: "running", nudge: null } }),
    "GET /billing/plans": () => json({ data: catalogue }),
  });
}

describe("Cockpit", () => {
  it("says hot leads are early days, not a big zero, once first emails are out with no replies yet", async () => {
    show(cockpit({ progress: { ...cockpit().progress, sentEver: true } }), (d) => perf(d, { totals: { ...zero, sent: 37, firstEmails: 37, pricePerEmail: "$0.04" } }));
    renderWithStore(<CockpitPage />);
    expect(await screen.findByText("None yet")).toBeInTheDocument();
    expect(screen.getByText(/Replies usually start 3 to 5 days/)).toBeInTheDocument();
  });

  it("shows the budget the customer chose as one line, and never writes it back by rendering", async () => {
    const { calls } = show(cockpit({ day: { plan: 500, chosen: 1250, mailboxLimit: 500, moreMailboxesOn: null, planned: 16, sent: 0, reason: "preparing", waitingApproval: 0, preparing: 900 } }));
    const { store } = renderWithStore(<CockpitPage />);
    store.dispatch(sessionReceived(session));
    expect(await screen.findByText("Daily budget: up to $20 a day")).toBeInTheDocument();
    // Today is emails against the daily amount, with the one reason it is lower.
    expect(screen.getByRole("img", { name: "Spent today: $0.00 of a $20 daily budget" })).toBeInTheDocument();
    expect(screen.getByText("of $20 today")).toBeInTheDocument();
    expect(screen.getByText("16 of 500 emails today")).toBeInTheDocument();
    expect(screen.getByText(/the rest are being found, checked and written now/)).toBeInTheDocument();
    // The honest ceiling when the mailboxes carry less than the amount chosen.
    expect(screen.getByText(/You chose 1,250 a day; your sending mailboxes carry 500 a day right now, more are being added/)).toBeInTheDocument();
    // The day's sends sit beside it, in the prospects' own time.
    expect(screen.getByText("Today's sends")).toBeInTheDocument();
    expect(screen.getByText(/to go/)).toBeInTheDocument();
    expect(screen.queryByText("Sent today")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    // The editor is only the control: the slider, what it buys and pause; the line and status box already say the rest.
    expect(await screen.findByText(/^\$20 a day · Up to 500 emails a day/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause sending" })).toBeInTheDocument();
    expect(screen.queryByText(/people reached/)).toBeNull();
    expect((screen.getByLabelText("Daily budget in dollars") as HTMLInputElement).value).toBe("20");
    await waitFor(() => expect(calls.filter((c) => c.path === "/settings" && c.method === "PATCH")).toHaveLength(0));
  });

  it("before the first email shows progress, states the free credit as a fact and shows no time zone nobody chose", async () => {
    show(cockpit());
    const { container } = renderWithStore(<CockpitPage />);
    expect(await screen.findByText("Finding people")).toBeInTheDocument();
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
    expect(await screen.findByText("Your first 20 people are ready to check")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review and approve" })).toHaveAttribute("href", "/app/approve");
    expect(screen.getByRole("progressbar", { name: "People ready" })).toHaveAttribute("aria-valuenow", "20");
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Nothing needs you|Sending/);
  });

  it("while finding, shows the real numbers and that the work is in progress", async () => {
    show(cockpit({ engine: { ...cockpit().engine, state: "preparing" }, needsYou: { ...cockpit().needsYou, firstBatch: { ready: 0, needed: 20, finding: true, found: 412, written: 6, problem: null } } }));
    renderWithStore(<CockpitPage />);
    expect(await screen.findByText("Getting your first 20 people ready")).toBeInTheDocument();
    // Between found and ready, the card says what is happening, once.
    expect(screen.getByText("412 found · checking emails and writing to them")).toBeInTheDocument();
    expect(screen.queryByText("412 found so far")).toBeNull();
    expect(screen.getByText(/free credit · nothing charged/)).toBeInTheDocument();
    expect(screen.getByText("Working on it")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review and approve" })).not.toBeInTheDocument();
  });

  it("with 1 of 20 written and the search still going, doesn't call it ready: it offers a look at what's there so far", async () => {
    show(cockpit({ engine: { ...cockpit().engine, state: "preparing" }, needsYou: { ...cockpit().needsYou, firstBatch: { ready: 1, needed: 20, finding: true, found: 53, written: 1, problem: null }, pendingWeeks: [{ batchId: "b1", weekStart: "2026-11-02", label: "Nov 2", sendable: 51, total: 62 }] } }));
    const { container } = renderWithStore(<CockpitPage />);
    expect(await screen.findByText("Getting your first 20 people ready")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "People ready" })).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByRole("link", { name: "See the 1 person ready so far" })).toHaveAttribute("href", "/app/approve");
    expect(screen.queryByRole("link", { name: "Review and approve" })).not.toBeInTheDocument();
    // One approval at a time: the weekly list waits until the first batch is approved.
    expect(container.textContent).not.toMatch(/Week of Nov 2|1 emails/);
  });

  it("with emails scheduled and next week's list waiting, leads with the sending and offers the review second", async () => {
    const next = new Date(Date.now() + 3_600_000).toISOString();
    show(cockpit({ engine: { ...cockpit().engine, state: "reviewing" }, outlook: { ...cockpit().outlook, next, inDay: 8, lastInDay: next, reason: null }, needsYou: { ...cockpit().needsYou, pendingWeeks: [{ batchId: "b1", weekStart: "2026-11-02", label: "Nov 2", sendable: 56, total: 62 }] } }));
    const { container } = renderWithStore(<CockpitPage />);
    expect(await screen.findByRole("heading", { name: "First emails scheduled" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review next week's 56 people" })).toHaveAttribute("href", "/app/leads?batch=b1");
    expect(container.textContent).not.toMatch(/Waiting for your review/);
  });

  it("shows who's up next, and leaves someone out before their first email after a confirm", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const { calls } = show(
      cockpit({
        progress: { ...cockpit().progress, sentEver: true },
        upNext: { total: 12, people: [{ id: "p1", name: "Nikki Krell", title: "Agency Owner", company: "Thirty Eight Lakes", at, tz: "America/Chicago" }] },
      }),
    );
    const r = renderWithStore(<CockpitPage />);
    r.store.dispatch(sessionReceived(session));
    expect(await screen.findByText("Nikki Krell")).toBeInTheDocument();
    expect(screen.getByText("Agency Owner at Thirty Eight Lakes")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All 12 lined up/ })).toHaveAttribute("href", "/app/leads?tab=today");
    fireEvent.click(await screen.findByRole("button", { name: "Leave out" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Leave out" }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.path === "/contacts/p1/leave-out")).toBe(true));
  });

  it("says when the next new people go and how many, in their own morning, when today's are already out", async () => {
    // Tomorrow 9:00 in London, wherever the test runs.
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86_400_000);
    const day = tomorrow.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    const at = new Date(`${day}T09:00:00Z`).toISOString();
    show(
      cockpit({
        progress: { ...cockpit().progress, sentEver: true },
        outlook: { ...cockpit().outlook, reason: "daily-cap", window: { ...cockpit().outlook.window, tz: "Europe/London" }, newPeople: { at, count: 13 } },
        upNext: { total: 13, people: [{ id: "p1", name: "Nikki Krell", title: "Agency Owner", company: "Thirty Eight Lakes", at: null, tz: null }] },
      }),
    );
    const r = renderWithStore(<CockpitPage />);
    r.store.dispatch(sessionReceived(session));
    expect(await screen.findByText(/^Tomorrow from \d/)).toBeInTheDocument();
    expect(screen.getByText(/13 new people · their time in London/)).toBeInTheDocument();
    expect(screen.getByText("tomorrow")).toBeInTheDocument();
  });

  it("says why the first search stopped and offers to search again", async () => {
    show(cockpit({ engine: { ...cockpit().engine, state: "preparing" }, needsYou: { ...cockpit().needsYou, firstBatch: { ready: 0, needed: 20, finding: false, found: 0, written: 0, problem: "No one matched your audiences." } } }));
    const r = renderWithStore(<CockpitPage />);
    r.store.dispatch(sessionReceived(session));
    expect(await screen.findByText("The search for your first people stopped")).toBeInTheDocument();
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
    // The tile counts up to its number and keeps the final value for screen readers, so it is in the page twice.
    expect((await screen.findAllByText("1,200")).length).toBe(3);
    expect(screen.getAllByText("98.3%")).toHaveLength(2);
    expect(screen.getAllByText("+20%")).toHaveLength(2);
    expect(screen.getByText(/\+0\.3 pts/)).toBeInTheDocument();
    expect(screen.getByText("+100%")).toBeInTheDocument();
    expect(screen.getAllByText("$48.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$6.00").length).toBe(2);
    expect(screen.getByText("Founders")).toBeInTheDocument();
    expect(screen.getByText("about 171 a day")).toBeInTheDocument();
    expect(screen.getAllByText("5.0%")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Period" }));
    await userEvent.click(screen.getByRole("option", { name: "30 days" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/dashboard/performance?period=30d")).toBe(true));
    expect(await screen.findByText(/last 30 days, compared/)).toBeInTheDocument();
  });

  it("shows when the next email really goes out, with the prospect's local time", async () => {
    const next = new Date(Date.now() + 2 * 3_600_000);
    const last = new Date(next.getTime() + 60_000);
    show(cockpit({ progress: { ...cockpit().progress, sentEver: true }, outlook: { ...cockpit().outlook, next: next.toISOString(), nextProspectTz: "America/New_York", inDay: 10, lastInDay: last.toISOString(), reason: null } }));
    renderWithStore(<CockpitPage />);
    expect(await screen.findByText(/^Next email (at |tomorrow ).*your time$/)).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/in New York\)/);
    expect(document.body.textContent).toMatch(/9 more (today|in the next 24 hours), the last at .* your time/);
  });

  it("says in plain words why nothing is scheduled", async () => {
    const opens = new Date(Date.now() + 10 * 3_600_000).toISOString();
    show(cockpit({ outlook: { ...cockpit().outlook, reason: "outside-window", window: { ...cockpit().outlook.window, open: false, opensAt: opens } } }));
    renderWithStore(<CockpitPage />);
    expect(await screen.findByText(/Sending is closed for your prospects in New York until/)).toBeInTheDocument();
  });
});
