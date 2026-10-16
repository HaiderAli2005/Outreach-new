import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { Onboarding } from "@/components/onboarding/Onboarding";
import type { Session } from "@/lib/types";
import { catalogue, json, onboardingState, session } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

let query = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/onboarding",
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

const rankhouse: Session = { ...session, organizations: [{ id: "org1", name: "Rankhouse", role: "OWNER", primaryDomain: "rankhouse.ai" }], activeOrganizationId: "org1" };
const both: Session = { ...rankhouse, organizations: [...rankhouse.organizations, { id: "org2", name: "Videofunker", role: "OWNER", primaryDomain: "videofunker.ai" }], activeOrganizationId: "org2" };
const launched = onboardingState({ onboarding: { ...onboardingState().onboarding!, domain: "rankhouse.ai", brand: "Rankhouse", analyzedAt: "2026-10-01T00:00:00Z", launchedAt: "2026-10-02T00:00:00Z" }, funded: true });
const fresh = onboardingState({ onboarding: { ...onboardingState().onboarding!, domain: "videofunker.ai", brand: "Videofunker" } });

function server(sessions: Session[]) {
  let active = sessions[0];
  return mockServer({
    "POST /auth/refresh": (body) => {
      const id = (body as { organizationId?: string } | undefined)?.organizationId;
      active = sessions.find((s) => s.activeOrganizationId === id) ?? active;
      return json({ data: active });
    },
    "GET /onboarding": () => json({ data: active.activeOrganizationId === "org1" ? launched : fresh }),
    "POST /organizations": () => json({ data: { id: "org2", name: "Videofunker", primaryDomain: "videofunker.ai", status: "ACTIVE", createdAt: "2026-10-09T00:00:00Z" } }),
    "GET /billing/plans": () => json({ data: catalogue }),
  });
}

describe("A new domain while a campaign is running", () => {
  it("creates its own workspace and leaves the running one alone", async () => {
    query = "domain=videofunker.ai";
    const { calls } = server([rankhouse, both]);
    renderWithStore(<Onboarding />);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/organizations")).toBe(true));
    expect(calls.find((c) => c.path === "/organizations")?.body).toEqual({ domain: "videofunker.ai" });
    await waitFor(() => expect(calls.filter((c) => c.path === "/auth/refresh").at(-1)?.body).toEqual({ organizationId: "org2" }));
    expect(calls.some((c) => c.path === "/onboarding/start")).toBe(false);
  });

  it("switches to the workspace you already have for that domain instead of making another", async () => {
    query = "domain=videofunker.ai";
    const { calls } = server([{ ...both, activeOrganizationId: "org1" }, both]);
    renderWithStore(<Onboarding />);
    await waitFor(() => expect(calls.filter((c) => c.path === "/auth/refresh").at(-1)?.body).toEqual({ organizationId: "org2" }));
    expect(calls.some((c) => c.path === "/organizations")).toBe(false);
    expect(calls.some((c) => c.path === "/onboarding/start")).toBe(false);
  });
});
