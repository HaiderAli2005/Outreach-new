import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthCard } from "@/components/onboarding/AuthStep";
import { json, session } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

afterEach(() => vi.unstubAllGlobals());

const card = (mode: "up" | "in", onDone = vi.fn()) => <AuthCard mode={mode} onMode={vi.fn()} domain="northwind.io" next="/onboarding" onDone={onDone} />;

describe("AuthCard", () => {
  it("checks the email before asking for details", async () => {
    mockServer({ "GET /auth/providers": () => json({ data: { google: false } }) });
    renderWithStore(card("up"));
    await userEvent.type(screen.getByLabelText("Work email"), "alex@northwind{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("doesn't look right");
    expect(screen.queryByLabelText("Full name")).not.toBeInTheDocument();
  });

  it("creates an account with the domain and stores the session", async () => {
    const { calls } = mockServer({
      "GET /auth/providers": () => json({ data: { google: false } }),
      "POST /auth/register": () => json({ data: session }, 201),
    });
    const onDone = vi.fn();
    const { store } = renderWithStore(card("up", onDone));
    await userEvent.type(screen.getByLabelText("Work email"), "alex@northwind.io{Enter}");
    await userEvent.type(screen.getByLabelText("Full name"), "Alex Morgan");
    await userEvent.type(screen.getByLabelText("Password"), "short");
    expect(screen.getByText(/Too short/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at least 8 characters");
    await userEvent.type(screen.getByLabelText("Password"), "-and-longer-1!");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(session));
    expect(calls.find((c) => c.path === "/auth/register")!.body).toEqual({ name: "Alex Morgan", email: "alex@northwind.io", password: "short-and-longer-1!", domain: "northwind.io" });
    expect(store.getState().auth.token).toBe("token-1");
  });

  it("shows the server's error when sign in fails", async () => {
    mockServer({
      "GET /auth/providers": () => json({ data: { google: false } }),
      "POST /auth/login": () => json({ error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." } }, 401),
    });
    const onDone = vi.fn();
    renderWithStore(card("in", onDone));
    await userEvent.type(screen.getByLabelText("Work email"), "alex@northwind.io{Enter}");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password{Enter}");
    expect(await screen.findByText("Email or password is incorrect.")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("always offers Continue with Google, carrying the domain to the server", async () => {
    mockServer({ "GET /auth/providers": () => json({ data: { google: true } }) });
    renderWithStore(card("up"));
    const link = await screen.findByRole("link", { name: /continue with google/i });
    expect(link).toHaveAttribute("href", "/api/v1/auth/oauth/google/start?next=%2Fonboarding&domain=northwind.io");
  });

  it("explains on the page when Google isn't switched on yet instead of leaving the form", async () => {
    mockServer({ "GET /auth/providers": () => json({ data: { google: false } }) });
    renderWithStore(card("in"));
    const link = await screen.findByRole("link", { name: /continue with google/i });
    await waitFor(() => expect(link).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 20));
    await userEvent.click(link);
    expect(screen.getByRole("alert")).toHaveTextContent("Google sign-in isn't switched on yet");
  });
});
