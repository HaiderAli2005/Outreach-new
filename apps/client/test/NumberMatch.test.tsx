import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthCard } from "@/components/onboarding/AuthStep";
import { NumberMatch } from "@/components/auth/NumberMatch";
import { json, session } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

afterEach(() => vi.unstubAllGlobals());

const pending = { email: "alex@northwind.io", challengeId: "c".repeat(24), matchNumber: 42, codeSent: false };

describe("number match", () => {
  it("shows the number after sign up and signs in once the email is tapped", async () => {
    const { calls } = mockServer({
      "GET /auth/providers": () => json({ data: { google: false, passwordReset: true } }),
      "POST /auth/register": () => json({ data: { verificationRequired: true, verification: pending } }, 201),
      "POST /auth/challenge/status": (_b, n) => json({ data: { status: n < 2 ? "PENDING" : "APPROVED", purpose: "VERIFY", attemptsLeft: 3, expiresAt: null } }),
      "POST /auth/claim": () => json({ data: { claimed: true, session } }),
    });
    const onDone = vi.fn();
    const { store } = renderWithStore(<AuthCard mode="up" onMode={vi.fn()} domain="northwind.io" next="/onboarding" onDone={onDone} />);
    await userEvent.type(screen.getByLabelText("Work email"), "alex@northwind.io{Enter}");
    await userEvent.type(screen.getByLabelText("Full name"), "Alex Morgan");
    await userEvent.type(screen.getByLabelText("Password"), "correct-horse-1{Enter}");
    expect(await screen.findByLabelText("Your number is 42")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(session), { timeout: 8000 });
    expect(store.getState().auth.token).toBe("token-1");
    expect(calls.filter((c) => c.path === "/auth/claim")).toHaveLength(1);
  }, 12000);

  it("offers the code instead and hands a reset over to the new password form", async () => {
    const { calls } = mockServer({
      "POST /auth/challenge/status": () => json({ data: { status: "PENDING", purpose: "RESET", attemptsLeft: 3, expiresAt: null } }),
      "POST /auth/challenge/send-code": () => json({ data: { sent: true } }),
      "POST /auth/challenge/code": (b) =>
        (b as { code: string }).code === "123456"
          ? json({ data: { purpose: "RESET", token: "reset-token" } })
          : json({ error: { code: "CHALLENGE_FAILED", message: "That code isn't right. Check the latest email and try again.", details: { reason: "wrong_code", attemptsLeft: 2 } } }, 400),
    });
    const onResetToken = vi.fn();
    renderWithStore(<NumberMatch purpose="RESET" email="alex@northwind.io" verification={pending} onResetToken={onResetToken} />);
    await userEvent.click(screen.getByRole("button", { name: "Try another way" }));
    const field = await screen.findByLabelText("6-digit code");
    expect(screen.getByText("Code sent. Check your email.")).toBeInTheDocument();
    await userEvent.type(field, "000000{Enter}");
    expect(await screen.findByText(/That code isn't right/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("6-digit code"), "123456{Enter}");
    await waitFor(() => expect(onResetToken).toHaveBeenCalledWith("reset-token"));
    expect(calls.find((c) => c.path === "/auth/challenge/send-code")!.body).toEqual({ challengeId: pending.challengeId });
  });

  it("opens the code field straight away when the number way is locked", () => {
    mockServer({ "POST /auth/challenge/status": () => json({ data: { status: "PENDING", purpose: "VERIFY", attemptsLeft: 3, expiresAt: null } }) });
    renderWithStore(<NumberMatch purpose="VERIFY" email="alex@northwind.io" verification={{ ...pending, matchNumber: null, codeSent: true }} />);
    expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Your number is/)).not.toBeInTheDocument();
  });
});
