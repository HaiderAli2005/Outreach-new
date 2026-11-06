import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LaunchStep } from "@/components/onboarding/LaunchStep";
import type { FirstRun, OnboardingState } from "@/lib/types";
import { fundedCredits, json, onboardingState } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

afterEach(() => vi.unstubAllGlobals());

const draft = { emails: 500, set: true };

function show(state: OnboardingState) {
  return renderWithStore(<LaunchStep state={state} draft={draft} market={undefined} />);
}

describe("LaunchStep", () => {
  it("waits for credits and does not launch", async () => {
    const { fetchMock } = mockServer({});
    show(onboardingState());
    expect(screen.getByRole("heading", { name: "Add your card to start" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("launches once when funded and reports what is still missing", async () => {
    const { calls } = mockServer({
      "POST /onboarding/launch": () => json({ data: { campaignId: "c1", missing: ["AI personalization is not configured on this server"], state: onboardingState() } }),
    });
    const state = onboardingState({ funded: true, credits: fundedCredits });
    const { rerender } = show(state);
    expect(await screen.findByText("AI personalization is not configured on this server")).toBeInTheDocument();
    // Launched is not live: nothing can go out until the first people are found.
    expect(screen.getByRole("heading", { name: "Finding your first people" })).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    rerender(<LaunchStep state={state} draft={draft} market={undefined} />);
    await waitFor(() => expect(calls.filter((c) => c.path === "/onboarding/launch")).toHaveLength(1));
  });

  it("never shows the customer domains, inboxes or warmup", () => {
    mockServer({});
    const state = onboardingState({ funded: true, credits: fundedCredits, onboarding: { ...onboardingState().onboarding!, launchedAt: new Date().toISOString() } });
    const { container } = show(state);
    expect(screen.getByRole("heading", { name: "Finding your first people" })).toBeInTheDocument();
    expect(screen.getByText("$25.00")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/inbox|domain|warmup|warming|DNS/i);
  });

  const run = (over: Partial<FirstRun>): FirstRun => ({ state: "running", reason: null, message: null, startedAt: new Date().toISOString(), finishedAt: null, found: 0, verified: 0, written: 0, needsApproval: true, approved: false, approveCount: 20, consent: false, windowStart: "09:00", ...over });
  const live = (firstRun: FirstRun) => onboardingState({ funded: true, credits: fundedCredits, onboarding: { ...onboardingState().onboarding!, launchedAt: new Date().toISOString() }, firstRun, verifying: true });

  it("while preparing, says how long it takes and that it is followed on the dashboard, with no step list", async () => {
    const state = live(run({ found: 12, verified: 5 }));
    mockServer({ "GET /onboarding": () => json({ data: state }) });
    show(state);
    expect(await screen.findByRole("heading", { name: "Finding your first people" })).toBeInTheDocument();
    expect(screen.getByText(/You can follow it on your dashboard/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/What happens next|Working on it|nothing here needs you/);
  });

  it("says why the search stopped and starts it again on request", async () => {
    const state = live(run({ state: "failed", reason: "apollo-not-configured", finishedAt: new Date().toISOString() }));
    const { calls } = mockServer({ "GET /onboarding": () => json({ data: state }), "POST /onboarding/first-run": () => json({ data: state }) });
    show(state);
    expect(await screen.findByText(/the Apollo key is missing/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "We couldn't find your first people" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/onboarding/first-run")).toBe(true));
  });

  it("asks for the first approval once emails are written, and links to it", async () => {
    const state = live(run({ state: "done", found: 40, verified: 31, written: 20, finishedAt: new Date().toISOString() }));
    mockServer({ "GET /onboarding": () => json({ data: state }) });
    show(state);
    expect(await screen.findByRole("heading", { name: "Your first 20 people are ready" })).toBeInTheDocument();
    for (const a of screen.getAllByRole("link", { name: "Review and approve" })) expect(a).toHaveAttribute("href", "/app/approve");
  });

  it("starts the search for a campaign launched before it existed", async () => {
    const state = live(run({ state: "idle", startedAt: null }));
    const { calls } = mockServer({ "GET /onboarding": () => json({ data: state }), "POST /onboarding/first-run": () => json({ data: state }) });
    show(state);
    await waitFor(() => expect(calls.filter((c) => c.path === "/onboarding/first-run")).toHaveLength(1));
  });

  it("says live only once emails can really go out", async () => {
    const state = live(run({ state: "done", found: 40, verified: 31, written: 20, approved: true, needsApproval: false, finishedAt: new Date().toISOString() }));
    mockServer({ "GET /onboarding": () => json({ data: state }) });
    show(state);
    expect(await screen.findByRole("heading", { name: "Your campaign is live" })).toBeInTheDocument();
    expect(screen.getByText(/First emails go out from 09:00/)).toBeInTheDocument();
  });

  const cockpitWith = (on: boolean, milestones: { contacts: boolean; sent: boolean; replied: boolean }) => ({ engine: { on, state: on ? "running" : "paused" }, milestones });

  it("once emails are out, says so from what really happened and points to the dashboard", async () => {
    const state = live(run({ state: "done", found: 40, verified: 31, written: 20, approved: true, needsApproval: false, finishedAt: new Date().toISOString() }));
    mockServer({ "GET /onboarding": () => json({ data: state }), "GET /dashboard/cockpit": () => json({ data: cockpitWith(true, { contacts: true, sent: true, replied: true }) }) });
    show(state);
    expect(await screen.findByRole("heading", { name: "Your first emails are out" })).toBeInTheDocument();
    expect(screen.getByText(/Your dashboard shows when each next email goes out, and every reply/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/What happens next|Working on it/);
  });

  it("says plainly when Autopilot is off, with the way to turn it on, instead of nothing needs you", async () => {
    const state = live(run({ state: "done", found: 40, verified: 31, written: 20, approved: true, needsApproval: false, finishedAt: new Date().toISOString() }));
    mockServer({ "GET /onboarding": () => json({ data: state }), "GET /dashboard/cockpit": () => json({ data: cockpitWith(false, { contacts: true, sent: false, replied: false }) }) });
    show(state);
    expect((await screen.findAllByText("Sending is switched off")).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Turn it on in Settings" })[0]).toHaveAttribute("href", "/app/settings?tab=autopilot");
  });

  it("never says addresses are checked when no checker is set up", async () => {
    const state = { ...live(run({ found: 0 })), verifying: false };
    mockServer({ "GET /onboarding": () => json({ data: state }) });
    show(state);
    expect(await screen.findByRole("heading", { name: "Finding your first people" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/checking every address|checked email|check every address/);
  });
});
