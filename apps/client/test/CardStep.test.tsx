import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CardStep } from "@/components/onboarding/SetupSteps";
import type { CreditsPanel } from "@/lib/types";
import { catalogue, fundedCredits, json } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

const panel = { ...fundedCredits, balance: "$10.00", emailsLeft: 250, health: { status: "OK", label: "Good", bounceRate: "0.0%", delivered: 0, bounced: 0, replies: 0, pausedReason: null }, activity: [], hasCard: true, card: { brand: "Visa", last4: "4242" }, trialAvailable: false, minTopup: "$25.00" } as CreditsPanel;

function show(funded: boolean, onSkip = vi.fn(), register = vi.fn()) {
  const server = mockServer({
    "GET /billing/config": () => json({ data: { enabled: true, publishableKey: "pk_test_x" } }),
    "POST /billing/setup-intents": () => json({ data: { setupIntentId: "seti_1", clientSecret: "seti_1_secret", paymentMethodId: null } }),
    "POST /billing/card-checkout": () => json({ data: { url: "https://checkout.stripe.com/c/pay/cs_test_1" } }),
    "GET /billing/credits": () => json({ data: panel }),
    "GET /billing/topup-options": () => json({ data: { dailyBudget: "20000", emailsPerDay: 500, lead: "500 emails a day costs $20 a day. How long do you want to run?", balance: "$10.00", balanceLasts: null, minTopup: "$25.00", options: [{ label: "1 week", days: 5, amount: "$100", deciCents: "100000", emails: 2500, recommended: true }] } }),
    "POST /billing/topups": () => json({ data: { paymentIntentId: "pi_1", clientSecret: "pi_1_secret", amount: "$100.00", status: "succeeded" } }),
  });
  renderWithStore(
    <CardStep
      draft={{ emails: 500, set: true }}
      cat={catalogue}
      patch={vi.fn()}
      domain="northwind.io"
      credits={funded ? panel : undefined}
      funded={funded}
      orgId="org1"
      awaiting={false}
      cancelled={false}
      register={register}
      onBusy={vi.fn()}
      onSkip={onSkip}
      skipBusy={false}
    />,
  );
  return server;
}

describe("CardStep", () => {
  it("sends the card to Stripe's own page, says nothing is charged, and creates no payment", async () => {
    const onSkip = vi.fn();
    const register = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, origin: "http://localhost", assign });
    const { calls } = show(false, onSkip, register);
    expect(screen.getByRole("heading", { name: "Add your card" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is charged today/)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Top-up amount" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Use free credit/)).not.toBeInTheDocument();
    expect(await screen.findByText("Secure checkout with Stripe")).toBeInTheDocument();
    expect(screen.getByText(/Aperture never sees the number/)).toBeInTheDocument();
    // No card form inside the app: the card is typed on Stripe's page.
    expect(calls.some((c) => c.path === "/billing/setup-intents")).toBe(false);
    // The step's main button runs the registered handle, which opens Stripe's page.
    const handle = register.mock.calls.map((c) => c[0]).filter(Boolean).at(-1);
    await handle();
    expect(calls.find((c) => c.path === "/billing/card-checkout")?.body).toEqual({ returnPath: "/onboarding?card=1", cancelPath: "/onboarding?card=cancelled" });
    expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(calls.some((c) => c.path === "/billing/topups")).toBe(false);
    vi.unstubAllGlobals();
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("once the card is added, shows the card and balance, and adds credit in one click on the saved card", async () => {
    const { calls } = show(true);
    expect(screen.getByRole("heading", { name: "Your billing is ready" })).toBeInTheDocument();
    expect(await screen.findByText("Visa 4242")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing has been charged/)).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("radio", { name: /1 week/ }));
    expect(screen.getByText(/Charged once to your Visa ending 4242/)).toBeInTheDocument();
    expect(screen.queryByText(/Card details/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pay $100" }));
    expect(await screen.findByText(/Waiting for Stripe to confirm it/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/billing/topups")?.body).toEqual({ amount: "100000", savedCard: true });
  });
});
