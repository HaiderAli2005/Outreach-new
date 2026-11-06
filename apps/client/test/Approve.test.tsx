import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import ApprovePage from "@/app/app/approve/page";
import { sessionReceived } from "@/store/authSlice";
import type { LaunchView } from "@/lib/types";
import { json, session } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

afterEach(() => vi.unstubAllGlobals());

const view = (over: Partial<LaunchView> = {}): LaunchView => ({
  launchMode: "APPROVE_FIRST_BATCH",
  approved: false,
  approvedAt: null,
  needed: 20,
  ready: 2,
  preparing: 5,
  consent: null,
  consentText: "I confirm I am authorised to send business email on behalf of Northwind, and that these recipients are relevant business contacts for what we offer.",
  people: [
    {
      id: "c1",
      name: "Arindam Sen",
      email: "arindam@brandeigen.com",
      title: "Head of Insights",
      company: "BrandEigen",
      emailSource: "apollo",
      verified: "ok",
      emails: [
        { step: 1, day: 0, subject: "Research content volume", body: "Hi Arindam,\n\nI'm Madison from Northwind." },
        { step: 2, day: 3, subject: "Re: Research content volume", body: "A short follow-up." },
        { step: 3, day: 7, subject: "Re: Research content volume", body: "One more thought." },
        { step: 4, day: 14, subject: "Re: Research content volume", body: "I'll leave it here." },
      ],
    },
    { id: "c2", name: "Kim Lee", email: "kim@acme.com", title: null, company: "Acme", emailSource: "anymailfinder", verified: "ok", emails: [] },
  ],
  ...over,
});

function show() {
  const r = renderWithStore(<ApprovePage />);
  r.store.dispatch(sessionReceived(session));
  return r;
}

describe("approval before launch", () => {
  it("shows full addresses and where they came from, and needs the consent tick before approving", async () => {
    const { calls } = mockServer({
      "GET /launch": () => json({ data: view() }),
      "POST /launch/approve": () => json({ data: { approved: 1 } }),
    });
    show();
    expect(await screen.findByText("arindam@brandeigen.com")).toBeInTheDocument();
    expect(screen.getByText("kim@acme.com")).toBeInTheDocument();
    expect(screen.getByText(/via anymailfinder/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\*\*\*/);
    const go = screen.getByRole("button", { name: /Approve and start sending/ });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getAllByLabelText("Leave out")[1]);
    fireEvent.click(screen.getByText(/I confirm I am authorised/));
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(calls.find((c) => c.path === "/launch/approve")?.body).toEqual({ consent: true, excludeIds: ["c2"], shownIds: ["c1", "c2"], autoContinue: true }));
  });

  it("shows the whole audience being approved: its size, the audiences in it, and where and how big", async () => {
    mockServer({
      "GET /launch": () =>
        json({
          data: {
            ...view(),
            audience: { people: 25223, reachable: 18400, audiences: [{ name: "Agency owners", people: 15000 }, { name: "Publishers", people: 10223 }], countries: [["United States", 60], ["United Kingdom", 25]], sizes: [["1–10 staff", 70]], sampleSize: 100, checkedAt: null },
          },
        }),
    });
    show();
    expect(await screen.findByText("25,223")).toBeInTheDocument();
    expect(screen.getByText(/about 18,400 with an email we can find/)).toBeInTheDocument();
    expect(screen.getByText("Agency owners")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText(/keeps working through this audience/)).toBeInTheDocument();
  });

  it("asks once what happens after the first batch: keep emailing new people automatically (on), or review weekly", async () => {
    const { calls } = mockServer({
      "GET /launch": () => json({ data: view() }),
      "POST /launch/approve": () => json({ data: { approved: 2, continued: 0 } }),
    });
    show();
    const keep = await screen.findByRole("switch", { name: "Keep emailing new people automatically" });
    expect(keep).toHaveAttribute("aria-checked", "true");
    fireEvent.click(keep);
    expect(screen.getByText(/wait in a weekly list for you to review/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/I confirm I am authorised/));
    fireEvent.click(screen.getByRole("button", { name: /Approve and start sending/ }));
    await waitFor(() => expect((calls.find((c) => c.path === "/launch/approve")?.body as { autoContinue: boolean }).autoContinue).toBe(false));
  });

  it("shows every email in the sequence as it will read, with the sender's name filled in", async () => {
    mockServer({ "GET /launch": () => json({ data: view() }) });
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Arindam Sen/ }));
    expect(screen.getByText(/I'm Madison from Northwind/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("{{");
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    fireEvent.click(screen.getByRole("tab", { name: /Follow-up 3/ }));
    expect(screen.getByText("I'll leave it here.")).toBeInTheDocument();
  });

  it("after the first batch, people found later still wait for a person, one by one", async () => {
    const { calls } = mockServer({
      "GET /launch": () => json({ data: view({ approved: true, approvedAt: new Date().toISOString(), consent: { at: new Date().toISOString(), text: "x" } }) }),
      "POST /launch/approve-people": () => json({ data: { approved: 2 } }),
    });
    show();
    expect(await screen.findByText("Your first batch is approved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Approve these people/ }));
    await waitFor(() => expect(calls.find((c) => c.path === "/launch/approve-people")?.body).toEqual({ ids: ["c1", "c2"], consent: false }));
    expect(document.body.textContent).not.toMatch(/countdown|will launch in|starts automatically/i);
  });

  it("offers nothing to approve when nobody is waiting", async () => {
    mockServer({ "GET /launch": () => json({ data: view({ approved: true, approvedAt: new Date().toISOString(), consent: { at: new Date().toISOString(), text: "x" }, people: [], ready: 0 }) }) });
    show();
    expect(await screen.findByText(/Nobody is waiting for approval/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });
});
