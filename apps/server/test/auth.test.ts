import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, features, googleRedirectUri } from "../src/config/env.js";
import { api, createTenant, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

function refreshCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = (res.headers["set-cookie"] as string[] | undefined) ?? [];
  const c = cookies.find((x) => x.startsWith("ap_refresh="));
  if (!c) throw new Error("no refresh cookie");
  return c.split(";")[0];
}

describe("authentication", () => {
  beforeEach(resetDb);

  it("registers a user with an organization, owner membership and onboarding", async () => {
    const res = await api().post("/api/v1/auth/register").send({ name: "Alex Morgan", email: "Alex@Example.com", password: "supersecret1", domain: "https://www.northwind.io/" });
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.email).toBe("alex@example.com");
    expect(res.body.data.organizations[0].role).toBe("OWNER");
    const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("ap_refresh="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "alex@example.com" } });
    expect(user.passwordHash).not.toContain("supersecret1");
    const onboarding = await prisma.onboarding.findFirstOrThrow();
    expect(onboarding.domain).toBe("northwind.io");
    expect(onboarding.brand).toBe("Northwind");
  });

  it("rejects duplicate registration and weak input", async () => {
    await api().post("/api/v1/auth/register").send({ name: "A", email: "a@example.com", password: "supersecret1" }).expect(201);
    const dup = await api().post("/api/v1/auth/register").send({ name: "A", email: "A@example.com", password: "supersecret1" });
    expect(dup.status).toBe(409);
    const weak = await api().post("/api/v1/auth/register").send({ name: "A", email: "not-an-email", password: "short" });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("VALIDATION_ERROR");
    expect(weak.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["email", "password"]));
  });

  it("logs in with valid credentials and rejects invalid ones with the same message", async () => {
    const t = await createTenant({ email: "owner@example.com" });
    const ok = await api().post("/api/v1/auth/login").send({ email: "OWNER@example.com", password: "correct-horse-1" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.activeOrganizationId).toBe(t.orgId);
    const wrong = await api().post("/api/v1/auth/login").send({ email: "owner@example.com", password: "wrong-password" });
    const unknown = await api().post("/api/v1/auth/login").send({ email: "nobody@example.com", password: "wrong-password" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it("throttles repeated failed logins", async () => {
    await createTenant({ email: "target@example.com" });
    for (let i = 0; i < 8; i++) await api().post("/api/v1/auth/login").send({ email: "target@example.com", password: "nope-nope" });
    const blocked = await api().post("/api/v1/auth/login").send({ email: "target@example.com", password: "correct-horse-1" });
    expect(blocked.status).toBe(429);
  });

  it("protects routes and rejects bad tokens", async () => {
    await api().get("/api/v1/auth/me").expect(401);
    await api().get("/api/v1/dashboard/cockpit").expect(401);
    await api().get("/api/v1/dashboard/cockpit").set("Authorization", "Bearer garbage").expect(401);
    const t = await createTenant();
    const me = await api().get("/api/v1/auth/me").set(t.auth);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(t.email);
  });

  it("rejects disabled users even with a valid token", async () => {
    const t = await createTenant();
    await prisma.user.update({ where: { id: t.userId }, data: { status: "DISABLED" } });
    await api().get("/api/v1/auth/me").set(t.auth).expect(401);
  });

  it("rotates refresh tokens and revokes the family on reuse", async () => {
    await createTenant({ email: "rot@example.com" });
    const login = await api().post("/api/v1/auth/login").send({ email: "rot@example.com", password: "correct-horse-1" });
    const first = refreshCookie(login);
    await api().post("/api/v1/auth/refresh").set("Cookie", first).expect(400);
    const r1 = await api().post("/api/v1/auth/refresh").set("Cookie", first).set("X-Requested-With", "aperture");
    expect(r1.status).toBe(200);
    const second = refreshCookie(r1);
    expect(second).not.toBe(first);
    const reuse = await api().post("/api/v1/auth/refresh").set("Cookie", first).set("X-Requested-With", "aperture");
    expect(reuse.status).toBe(401);
    const afterTheft = await api().post("/api/v1/auth/refresh").set("Cookie", second).set("X-Requested-With", "aperture");
    expect(afterTheft.status).toBe(401);
  });

  it("logs out by revoking the refresh token", async () => {
    await createTenant({ email: "out@example.com" });
    const login = await api().post("/api/v1/auth/login").send({ email: "out@example.com", password: "correct-horse-1" });
    const cookie = refreshCookie(login);
    await api().post("/api/v1/auth/logout").set("Cookie", cookie).expect(200);
    await api().post("/api/v1/auth/refresh").set("Cookie", cookie).set("X-Requested-With", "aperture").expect(401);
  });

  it("reports Google sign-in as unavailable when not configured and sends the browser back to sign-in", async () => {
    const res = await api().get("/api/v1/auth/providers");
    expect(res.body.data.google).toBe(false);
    const start = await api().get("/api/v1/auth/oauth/google/start").expect(302);
    expect(start.headers.location).toMatch(/\/signin\?error=Google%20sign-in%20isn't%20switched%20on/);
  });

  describe("Continue with Google", () => {
    const saved = { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, on: features.googleOAuth };
    beforeEach(() => {
      env.GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com";
      env.GOOGLE_CLIENT_SECRET = "secret";
      features.googleOAuth = true;
    });
    afterEach(() => {
      env.GOOGLE_CLIENT_ID = saved.id;
      env.GOOGLE_CLIENT_SECRET = saved.secret;
      features.googleOAuth = saved.on;
      vi.unstubAllGlobals();
    });

    it("sends people back to the web app's own address unless told otherwise", () => {
      expect(googleRedirectUri).toBe(env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/v1/auth/oauth/google/callback");
    });

    async function signInWithGoogle(claims: Record<string, unknown>, query: string) {
      const start = await api().get(`/api/v1/auth/oauth/google/start?${query}`).expect(302);
      const google = new URL(start.headers.location);
      expect(google.origin).toBe("https://accounts.google.com");
      expect(google.searchParams.get("redirect_uri")).toBe(googleRedirectUri);
      const cookie = (start.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("ap_oauth="))!.split(";")[0];
      const idToken = ["x", Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, email_verified: true, ...claims })).toString("base64url"), "sig"].join(".");
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200, headers: { "content-type": "application/json" } }));
      return api().get(`/api/v1/auth/oauth/google/callback?code=abc&state=${google.searchParams.get("state")}`).set("Cookie", cookie).expect(302);
    }

    it("signs up from the home page domain with the same setup as an email sign-up", async () => {
      const done = await signInWithGoogle({ sub: "g-1", email: "Ali@gmail.com", name: "Ali Khan" }, `next=${encodeURIComponent("/onboarding?domain=northwind.io")}&domain=northwind.io`);
      expect(done.headers.location).toBe(`http://localhost:3000/auth/callback?next=${encodeURIComponent("/onboarding?domain=northwind.io")}`);
      expect(refreshCookie(done)).toMatch(/^ap_refresh=/);
      const user = await prisma.user.findUniqueOrThrow({ where: { email: "ali@gmail.com" }, include: { memberships: { include: { organization: { include: { onboarding: true } } } } } });
      expect(user.emailVerifiedAt).not.toBeNull();
      const org = user.memberships[0].organization;
      expect(org).toMatchObject({ name: "Northwind", primaryDomain: "northwind.io" });
      expect(org.onboarding?.domain).toBe("northwind.io");
      expect(await prisma.oAuthAccount.count({ where: { userId: user.id, provider: "google" } })).toBe(1);
    });

    it("never uses a free mailbox domain as the company, and signs an existing user back in", async () => {
      await signInWithGoogle({ sub: "g-2", email: "sara@gmail.com", name: "Sara" }, "next=%2Fapp");
      const org = (await prisma.membership.findFirstOrThrow({ where: { user: { email: "sara@gmail.com" } }, include: { organization: true } })).organization;
      expect(org).toMatchObject({ name: "Sara's workspace", primaryDomain: null });
      const again = await signInWithGoogle({ sub: "g-2", email: "sara@gmail.com", name: "Sara" }, "next=%2Fapp");
      expect(again.headers.location).toBe("http://localhost:3000/auth/callback?next=%2Fapp");
      expect(await prisma.user.count({ where: { email: "sara@gmail.com" } })).toBe(1);
      expect(await prisma.organization.count()).toBe(1);
    });
  });
});

describe("authorization", () => {
  beforeEach(resetDb);

  it("lets members read but not change configuration", async () => {
    const owner = await createTenant();
    const { addMember } = await import("./helpers.js");
    const member = await addMember(owner, "MEMBER");
    await api().get("/api/v1/settings").set(member.auth).expect(200);
    const patch = await api().patch("/api/v1/settings").set(member.auth).send({ autopilotEnabled: false });
    expect(patch.status).toBe(403);
    await api().post("/api/v1/engine/stop").set(member.auth).expect(403);
    await api().patch("/api/v1/settings").set(owner.auth).send({ autopilotEnabled: false }).expect(200);
  });

  it("keeps platform admin routes for platform admins only", async () => {
    const t = await createTenant();
    await api().get("/api/v1/admin/overview").set(t.auth).expect(403);
    await prisma.user.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    await api().get("/api/v1/admin/overview").set(t.auth).expect(200);
  });

  it("requires at least one owner", async () => {
    const owner = await createTenant();
    const m = await prisma.membership.findFirstOrThrow({ where: { organizationId: owner.orgId } });
    const res = await api().patch(`/api/v1/organizations/current/members/${m.id}`).set(owner.auth).send({ role: "ADMIN" });
    expect(res.status).toBe(422);
  });
});
