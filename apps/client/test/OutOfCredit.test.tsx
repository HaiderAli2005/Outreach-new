import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutOfCredit } from "@/components/billing/OutOfCredit";
import { sessionReceived } from "@/store/authSlice";
import type { NavCounts } from "@/lib/types";
import { json, session } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

const counts = (stage: NavCounts["balanceStage"], balance = "$0.00") => ({ balanceStage: stage, balance, emailsLeft: 0 }) as NavCounts;
const options = {
  dailyBudget: "4000",
  emailsPerDay: 100,
  lead: "100 emails a day costs $4 a day. How long do you want to run?",
  balance: "$0.00",
  balanceLasts: null,
  minTopup: "$25.00",
  options: [
    { days: 6, label: "6 days", deciCents: "25000", amount: "$25", emails: 625, people: 156, recommended: true },
    { days: 22, label: "1 month", deciCents: "90000", amount: "$90", emails: 2250, people: 562, recommended: false },
  ],
};

function show(stage: NavCounts["balanceStage"], path = "/app") {
  mockServer({ "GET /billing/topup-options": () => json({ data: options }) });
  const r = renderWithStore(<OutOfCredit counts={counts(stage)} orgId="org1" path={path} />);
  r.store.dispatch(sessionReceived(session));
  return r;
}

describe("Out of credit", () => {
  beforeEach(() => localStorage.clear());

  it("says what stopped, what is kept, and opens the payment for the chosen top-up", async () => {
    show("empty");
    expect(await screen.findByText("You're out of credit")).toBeInTheDocument();
    expect(screen.getByText("Replies paused")).toBeInTheDocument();
    expect(screen.getByText("Nothing is lost")).toBeInTheDocument();
    // The recommended top-up is chosen first; picking another one changes the button and its link.
    expect(await screen.findByRole("link", { name: "Add $25 and resume" })).toHaveAttribute("href", "/app/billing/credits?amount=25000");
    await userEvent.click(screen.getByRole("radio", { name: /\$90/ }));
    expect(screen.getByRole("link", { name: "Add $90 and resume" })).toHaveAttribute("href", "/app/billing/credits?amount=90000");
  });

  it("keeps replies running under the reserve, and stays closed for the day once dismissed", async () => {
    const first = show("reserve");
    expect(await screen.findByText("You're down to $0.00")).toBeInTheDocument();
    expect(screen.getByText("Replies still running")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText("You're down to $0.00")).not.toBeInTheDocument();
    first.unmount();
    show("reserve");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("You're down to $0.00")).not.toBeInTheDocument();
  });

  it("never shows while there is credit, or on the Credits page", async () => {
    show("ok");
    show("empty", "/app/billing/credits");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("You're out of credit")).not.toBeInTheDocument();
  });
});
