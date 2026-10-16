import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStore } from "@/store";
import { api, errorCode, errorMessage } from "@/store/api";
import { sessionReceived, signedOut } from "@/store/authSlice";
import { json, session } from "./fixtures";
import { mockServer } from "./server";

afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise((r) => setTimeout(r, 0));
});

describe("auth slice", () => {
  it("stores the session and remembers the active workspace", () => {
    const store = makeStore();
    store.dispatch(sessionReceived(session));
    expect(store.getState().auth).toMatchObject({ status: "authed", token: "token-1", activeOrgId: "org1" });
    expect(window.localStorage.getItem("ap_org")).toBe("org1");
    store.dispatch(signedOut());
    expect(store.getState().auth).toMatchObject({ status: "anon", token: null, user: null, activeOrgId: null });
  });
});

describe("api base query", () => {
  it("sends the token and workspace headers", async () => {
    const { calls } = mockServer({ "GET /onboarding": () => json({ data: { onboarding: null } }) });
    const store = makeStore();
    store.dispatch(sessionReceived(session));
    await store.dispatch(api.endpoints.onboarding.initiate());
    expect(calls[0].headers.get("authorization")).toBe("Bearer token-1");
    expect(calls[0].headers.get("x-organization-id")).toBe("org1");
  });

  it("refreshes once on a 401 and retries with the new token", async () => {
    const { calls } = mockServer({
      "GET /onboarding": (_b, n) => (n === 1 ? json({ error: { code: "UNAUTHORIZED", message: "Expired" } }, 401) : json({ data: { onboarding: null } })),
      "POST /auth/refresh": () => json({ data: { ...session, accessToken: "token-2" } }),
    });
    const store = makeStore();
    store.dispatch(sessionReceived(session));
    const r = await store.dispatch(api.endpoints.onboarding.initiate());
    expect(r.data).toEqual({ onboarding: null });
    const refresh = calls.find((c) => c.path === "/auth/refresh")!;
    expect(refresh.headers.get("x-requested-with")).toBe("aperture");
    expect(refresh.body).toEqual({ organizationId: "org1" });
    expect(calls.at(-1)!.headers.get("authorization")).toBe("Bearer token-2");
    expect(store.getState().auth.token).toBe("token-2");
  });

  it("signs out when the refresh fails", async () => {
    mockServer({
      "GET /onboarding": () => json({ error: { code: "UNAUTHORIZED", message: "Expired" } }, 401),
      "POST /auth/refresh": () => json({ error: { code: "UNAUTHORIZED", message: "No session" } }, 401),
    });
    const store = makeStore();
    store.dispatch(sessionReceived(session));
    const r = await store.dispatch(api.endpoints.onboarding.initiate());
    expect(r.error).toBeTruthy();
    expect(store.getState().auth.status).toBe("anon");
  });

  it("reads server error messages and codes", () => {
    const err = { status: 409, data: { error: { code: "CONFLICT", message: "Already launched" } } };
    expect(errorMessage(err)).toBe("Already launched");
    expect(errorCode(err)).toBe("CONFLICT");
    expect(errorMessage({ status: "FETCH_ERROR" })).toMatch(/reach the server/);
    expect(errorMessage(null, "Fallback")).toBe("Fallback");
  });
});

describe("credits", () => {
  it("opens the one upgrade prompt on a refused spend, refreshes the balance, and keeps feature toasts quiet", async () => {
    const { calls } = mockServer({
      "POST /contacts/import": () => json({ error: { code: "INSUFFICIENT_CREDITS", message: "This file adds 3 new people and you have 2 credits left." } }, 402),
      "GET /billing/credits": () => json({ data: { balance: 2, apiBalance: 0, allowance: 100, apiAllowance: 0, usedThisPeriod: 98, periodStart: null, periodEnd: null, plan: { id: "growth", name: "Growth" }, pooledWith: null, recent: [] } }),
    });
    const store = makeStore();
    store.dispatch(sessionReceived(session));
    const sub = store.dispatch(api.endpoints.credits.initiate());
    await sub;
    const r = await store.dispatch(api.endpoints.importContacts.initiate({ text: "email\na@b.com" }));
    expect(store.getState().upgrade).toEqual({ open: true, message: "This file adds 3 new people and you have 2 credits left." });
    expect(errorCode((r as { error: unknown }).error)).toBe("INSUFFICIENT_CREDITS");
    expect(errorMessage((r as { error: unknown }).error)).toBe("");
    await new Promise((res) => setTimeout(res, 10));
    expect(calls.filter((c) => c.path === "/billing/credits")).toHaveLength(2);
    sub.unsubscribe();
  });
});
