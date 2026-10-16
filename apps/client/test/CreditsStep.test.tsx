import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreditsStep } from "@/components/onboarding/SetupSteps";
import type { CreditsPanel } from "@/lib/types";
import { catalogue, fundedCredits, json } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

const panel = { ...fundedCredits, balance: "$10.00", emailsLeft: 250, health: { status: "OK", label: "Good", bounceRate: "0.0%", delivered: 0, bounced: 0, replies: 0, pausedReason: null }, activity: [], hasCard: false, trialAvailable: false, minTopup: "$25.00" } as CreditsPanel;

function show(props: { funded: boolean; paying: boolean; onAddMore?: () => void }) {
  mockServer({
    "GET /billing/topup-options": () => json({ data: { dailyBudget: "20000", minTopup: "$25.00", options: [{ days: 7, label: "1 week", deciCents: "140000", amount: "$140.00", emails: 3500, people: 875, recommended: true }] } }),
    "GET /billing/config": () => json({ data: { enabled: false, publishableKey: null } }),
  });
  return renderWithStore(
    <CreditsStep
      draft={{ budget: "20000", budSet: true }}
      cat={catalogue}
      patch={vi.fn()}
      domain="northwind.io"
      credits={props.funded ? panel : undefined}
      funded={props.funded}
      paying={props.paying}
      onAddMore={props.onAddMore ?? vi.fn()}
      onCancelAdd={vi.fn()}
      orgId="org1"
      amount="140000"
      onAmount={vi.fn()}
      awaiting={false}
      register={vi.fn()}
      onPaid={vi.fn()}
      onBusy={vi.fn()}
      onTrial={vi.fn()}
      trialBusy={false}
    />,
  );
}

describe("CreditsStep", () => {
  it("once credit is in, shows no card form for the start button to ignore", async () => {
    const onAddMore = vi.fn();
    show({ funded: true, paying: false, onAddMore });
    expect(screen.getByRole("heading", { name: "Your credits are in" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Top-up amount" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Use free credit/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add more credit now" }));
    expect(onAddMore).toHaveBeenCalled();
  });

  it("before any credit, offers the top-ups, the card and the free credit", async () => {
    show({ funded: false, paying: true });
    expect(await screen.findByRole("radiogroup", { name: "Top-up amount" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use free credit" })).toBeInTheDocument();
  });
});
