import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Onboarding } from "@/components/onboarding/Onboarding";
import type { Session } from "@/lib/types";
import { catalogue, fundedCredits, json, onboardingState, session } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("card=1"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/onboarding",
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

const rankhouse: Session = { ...session, organizations: [{ id: "org1", name: "Rankhouse", role: "OWNER", primaryDomain: "rankhouse.ai" }], activeOrganizationId: "org1" };
const analysed = { ...onboardingState().onboarding!, domain: "rankhouse.ai", brand: "Rankhouse", analyzedAt: "2026-10-01T00:00:00Z" };

describe("Back from Stripe's card page", () => {
  it("moves on to the campaign start when the free credit is already in on the first load", async () => {
    window.scrollTo = vi.fn();
    mockServer({
      "POST /auth/refresh": () => json({ data: rankhouse }),
      // Stripe confirmed the card before the browser came back: funded from the very first fetch.
      "GET /onboarding": () => json({ data: onboardingState({ onboarding: analysed, funded: true, emailsPerDay: 250 }) }),
      "GET /billing/plans": () => json({ data: catalogue }),
      "GET /billing/config": () => json({ data: { enabled: true, publishableKey: "pk_test_x" } }),
      "GET /billing/credits": () => json({ data: fundedCredits }),
    });
    renderWithStore(<Onboarding />);
    expect(await screen.findByText("Starting your campaign", {}, { timeout: 8000 })).toBeInTheDocument();
  }, 15_000);
});
