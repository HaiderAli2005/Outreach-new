import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LeadsPage from "@/app/app/leads/page";
import { sessionReceived } from "@/store/authSlice";
import type { Batch } from "@/lib/types";
import { json, session } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

vi.mock("next/navigation", () => ({ usePathname: () => "/app/leads", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

afterEach(() => vi.unstubAllGlobals());

const stats = { total: 2, excluded: 0, sendable: 2, belowFloor: 0, tierA: 2, tierB: 0, avgFit: 60, pushed: 0, byCampaign: [] };
const batch = (status: Batch["status"]): Batch => ({
  id: "b1",
  weekStart: "2026-10-19",
  label: "Oct 19",
  status,
  targetClean: 50,
  sourcedClean: 2,
  excludedCount: 0,
  approvedCount: null,
  approvedAt: null,
  stats,
});

function show(status: Batch["status"]) {
  const server = mockServer({
    "GET /batches": () => json({ data: [batch(status)] }),
    "GET /contacts": () => json({ data: [], meta: { total: 0, page: 1, limit: 100 } }),
    "POST /batches/b1/approve": () => json({ data: { ok: true, approved: 2, excluded: 0, perDay: 2 } }),
  });
  const r = renderWithStore(<LeadsPage />);
  r.store.dispatch(sessionReceived(session));
  return server;
}

describe("Week review", () => {
  it("can approve a week that is still being filled", async () => {
    const { calls } = show("SOURCING");
    await userEvent.click(await screen.findByRole("button", { name: /Approve week/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/batches/b1/approve")).toBe(true));
  });

  it("can approve a week in review", async () => {
    show("REVIEW");
    expect(await screen.findByRole("button", { name: /Approve week/ })).toBeInTheDocument();
  });

  it("has nothing to approve once a week is approved", async () => {
    show("APPROVED");
    expect(await screen.findByText(/Week of Oct 19/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve week/ })).not.toBeInTheDocument();
  });
});
