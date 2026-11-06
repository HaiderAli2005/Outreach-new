import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, createTenant, resetDb, type TestTenant } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setTxtResolver } from "../src/domain/pool/auth.js";
import { secretStore } from "../src/integrations/secrets.js";
import { buildConnectUrl, clearGoogleTokenCache } from "../src/integrations/googleMail.js";

/** Admin > Domains with Google Workspace mailboxes that sign in with OAuth: no password, no app password. */

const DKIM = `v=DKIM1; k=rsa; p=${generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }).toString("base64")}`;
const KEY = JSON.stringify({
  type: "service_account",
  client_email: "aperture-mail@aperture-mail.iam.gserviceaccount.com",
  client_id: "112233445566778899000",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
});

function dnsFor(name: string) {
  setTxtResolver(async (q) => (q === name ? [["v=spf1 include:_spf.google.com ~all"]] : q === `_dmarc.${name}` ? [["v=DMARC1; p=none"]] : q === `google._domainkey.${name}` ? [[DKIM]] : []));
}

/** What Google's token endpoint answers, in order. */
function google(...answers: Array<{ status?: number; json: Record<string, unknown> }>) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const a = answers[Math.min(i++, answers.length - 1)];
      return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
}

async function admin(): Promise<TestTenant> {
  const a = await createTenant();
  await prisma.user.update({ where: { id: a.userId }, data: { isPlatformAdmin: true } });
  return a;
}

const gbox = (address: string, firstName: string) => ({ address, firstName, lastName: "Reed", auth: "google" });

describe("admin: Google Workspace mailboxes without passwords", () => {
  beforeEach(async () => {
    await resetDb();
    clearGoogleTokenCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the client ID a Workspace admin must allow, once the service account key is saved, and never the key", async () => {
    const a = await admin();
    const before = await api().get("/api/v1/admin/google-mail").set(a.auth).expect(200);
    expect(before.body.data.workspace).toEqual({ configured: false });
    const saved = await api().put("/api/v1/admin/google-mail/service-account").set(a.auth).send({ key: KEY }).expect(200);
    expect(saved.body.data.workspace).toMatchObject({ configured: true, clientId: "112233445566778899000" });
    expect(saved.body.data.workspace.steps).toContain("https://mail.google.com/");
    expect(JSON.stringify(saved.body)).not.toContain("PRIVATE KEY");
    await api().put("/api/v1/admin/google-mail/service-account").set(a.auth).send({ key: JSON.stringify({ type: "user" }).padEnd(60, " ") }).expect(400);
  });

  it("adds a warmed Google domain with no password: Gmail's servers, OAuth sign-in, live at 30 a day", async () => {
    const a = await admin();
    await secretStore().put("google-mail:service-account", KEY);
    dnsFor("decoderhubs.com");
    google({ json: { access_token: "ya29.token", expires_in: 3600 } });
    const res = await api()
      .post("/api/v1/admin/domains")
      .set(a.auth)
      .send({ name: "decoderhubs.com", warmed: true, mailboxes: [gbox("madison@decoderhubs.com", "Madison"), gbox("daniel@decoderhubs.com", "Daniel")] })
      .expect(201);
    expect(res.body.data.mailboxes.every((m: { ok: boolean }) => m.ok)).toBe(true);
    const boxes = await prisma.mailbox.findMany({ where: { address: { endsWith: "@decoderhubs.com" } }, orderBy: { address: "asc" } });
    expect(boxes.map((m) => [m.provider, m.smtpHost, m.smtpPort, m.imapHost, m.status, m.sendCapToday])).toEqual([
      ["google-workspace", "smtp.gmail.com", 465, "imap.gmail.com", "ACTIVE", 30],
      ["google-workspace", "smtp.gmail.com", 465, "imap.gmail.com", "ACTIVE", 30],
    ]);
    expect(JSON.parse((await secretStore().get(boxes[0].credentialRef!))!)).toEqual({ kind: "google-workspace" });
    const list = await api().get("/api/v1/admin/domains").set(a.auth).expect(200);
    expect(list.body.data[0].mailboxes[0]).toMatchObject({ auth: "google-workspace" });
  });

  it("holds a Google mailbox back with the exact admin-console steps when the Workspace hasn't allowed Aperture", async () => {
    const a = await admin();
    await secretStore().put("google-mail:service-account", KEY);
    dnsFor("bytepath.co");
    google({ status: 401, json: { error: "unauthorized_client", error_description: "Client is unauthorized" } });
    const res = await api()
      .post("/api/v1/admin/domains")
      .set(a.auth)
      .send({ name: "bytepath.co", warmed: true, mailboxes: [gbox("lena@bytepath.co", "Lena")] })
      .expect(201);
    expect(res.body.data.mailboxes[0].ok).toBe(false);
    const m = await prisma.mailbox.findFirstOrThrow({ where: { address: "lena@bytepath.co" } });
    expect(m.status).toBe("ERROR");
    expect(m.lastError).toContain("112233445566778899000");
    // The admin allows it; pressing Test sign-in again lets the mailbox in.
    google({ json: { access_token: "ya29.ok", expires_in: 3600 } });
    clearGoogleTokenCache();
    const t = await api().post(`/api/v1/admin/mailboxes/${m.id}/test`).set(a.auth).send({}).expect(200);
    expect(t.body.data.ok).toBe(true);
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("ACTIVE");
  });

  it("still requires a password and servers for a password mailbox", async () => {
    const a = await admin();
    await api()
      .post("/api/v1/admin/domains")
      .set(a.auth)
      .send({ name: "wave-meet.com", warmed: true, mailboxes: [{ address: "hamza@wave-meet.com", firstName: "Hamza" }] })
      .expect(400);
  });

  it("connects one mailbox with Google: the callback keeps the refresh token and signs it in", async () => {
    const a = await admin();
    dnsFor("compliancedrift.org");
    google({ status: 401, json: { error: "unauthorized_client" } });
    await api()
      .post("/api/v1/admin/domains")
      .set(a.auth)
      .send({ name: "compliancedrift.org", warmed: true, mailboxes: [gbox("ethan@compliancedrift.org", "Ethan")] })
      .expect(201);
    const m = await prisma.mailbox.findFirstOrThrow({ where: { address: "ethan@compliancedrift.org" } });
    const start = await api().post(`/api/v1/admin/mailboxes/${m.id}/google/connect`).set(a.auth).send({}).expect(200);
    const state = new URL(start.body.data.url).searchParams.get("state")!;
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "ethan@compliancedrift.org", aud: "test-client" })).toString("base64url")}.y`;
    google({ json: { access_token: "a", refresh_token: "1//refresh", id_token: idToken } }, { json: { access_token: "ya29.fresh", expires_in: 3600 } });
    const cb = await api().get(`/api/v1/google-mail/callback?code=abc&state=${encodeURIComponent(state)}`).expect(302);
    expect(cb.headers.location).toContain("google=connected");
    const after = await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.provider).toBe("google-oauth");
    expect(after.status).toBe("ACTIVE");
    expect(JSON.parse((await secretStore().get(after.credentialRef!))!)).toEqual({ kind: "google-oauth", rt: "1//refresh" });
  });

  it("the Rankhouse case: CSV upload with Google sign-in, then Connect with Google; the wrong account is refused", async () => {
    const a = await admin();
    dnsFor("getrankhouse.com");
    google({ status: 401, json: { error: "unauthorized_client" } });
    const csv = "Sr no,First Name,Last Name,Email Address,Password\n1,Karim,Mansour,karim@getrankhouse.com,Account-Pass\n";
    await api().post("/api/v1/admin/domains/import").set(a.auth).send({ csv, auth: "google", commit: true }).expect(200);
    const m = await prisma.mailbox.findFirstOrThrow({ where: { address: "karim@getrankhouse.com" } });
    expect([m.status, m.provider]).toEqual(["ERROR", "google-workspace"]);

    const start = await api().post(`/api/v1/admin/mailboxes/${m.id}/google/connect`).set(a.auth).send({}).expect(200);
    const url = new URL(start.body.data.url);
    expect(url.searchParams.get("login_hint")).toBe("karim@getrankhouse.com");
    expect(url.searchParams.get("scope")).toContain("https://mail.google.com/");
    const state = url.searchParams.get("state")!;
    const idFor = (email: string) => `x.${Buffer.from(JSON.stringify({ email, aud: "test-client" })).toString("base64url")}.y`;

    // Signed in to Google as another account in that browser: refused, nothing kept.
    google({ json: { access_token: "a", refresh_token: "1//other", id_token: idFor("zainab@ekhata.ai") } });
    const wrong = await api().get(`/api/v1/google-mail/callback?code=abc&state=${encodeURIComponent(state)}`).expect(302);
    expect(new URL(wrong.headers.location).searchParams.get("message")).toBe("You signed in as zainab@ekhata.ai, not karim@getrankhouse.com. Sign in as the mailbox itself.");
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("ERROR");

    // Signed in as karim (password + 2-step code at Google): connected and sending at 30 a day.
    google({ json: { access_token: "a", refresh_token: "1//karim", id_token: idFor("karim@getrankhouse.com") } }, { json: { access_token: "ya29.k", expires_in: 3600 } });
    const ok = await api().get(`/api/v1/google-mail/callback?code=abc&state=${encodeURIComponent(state)}`).expect(302);
    expect(ok.headers.location).toContain("google=connected");
    const after = await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } });
    expect([after.status, after.provider, after.sendCapToday]).toEqual(["ACTIVE", "google-oauth", 30]);
    expect(JSON.stringify(await secretStore().get(after.credentialRef!))).not.toContain("Account-Pass");
  });

  it("refuses a callback whose state it didn't make", async () => {
    const forged = await api().get("/api/v1/google-mail/callback?code=abc&state=bm90LW91cnM").expect(302);
    expect(forged.headers.location).toContain("google=error");
    const url = buildConnectUrl({ mailboxId: "missing", address: "x@y.com", operatorId: "op" });
    const cancelled = await api().get(`/api/v1/google-mail/callback?error=access_denied&state=${encodeURIComponent(new URL(url).searchParams.get("state")!)}`).expect(302);
    expect(decodeURIComponent(cancelled.headers.location)).toContain("cancelled");
  });
});
