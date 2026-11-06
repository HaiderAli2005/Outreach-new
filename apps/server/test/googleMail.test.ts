import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConnectUrl,
  clearGoogleTokenCache,
  exchangeConnectCode,
  explainWorkspaceRefusal,
  parseGoogleSecret,
  parseServiceAccount,
  readConnectState,
  refreshedToken,
  saveServiceAccount,
  signJwt,
  workspaceToken,
} from "../src/integrations/googleMail.js";
import { credsFor } from "../src/domain/sending/transport/index.js";
import { imapAuth, smtpAuth } from "../src/domain/sending/transport/smtp.js";
import { secretStore } from "../src/integrations/secrets.js";

/**
 * Google Workspace sign-in without app passwords. Google is never called: fetch is replaced, and each test checks
 * what Aperture sends to Google and what it does with the answer.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = {
  type: "service_account",
  project_id: "aperture-mail",
  client_email: "aperture-mail@aperture-mail.iam.gserviceaccount.com",
  client_id: "112233445566778899000",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
};

type Call = { url: string; body: URLSearchParams };
let calls: Call[] = [];

function googleAnswers(...answers: Array<{ status?: number; json: Record<string, unknown> }>) {
  calls = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: URLSearchParams }) => {
      calls.push({ url: String(url), body: new URLSearchParams(String(init.body)) });
      const a = answers[Math.min(i++, answers.length - 1)];
      return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
const idToken = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

beforeEach(async () => {
  clearGoogleTokenCache();
  await secretStore().remove("google-mail:service-account");
});
afterEach(() => vi.unstubAllGlobals());

describe("the service account key", () => {
  it("reads the JSON file pasted whole or as base64, and refuses anything else in plain words", () => {
    expect(parseServiceAccount(JSON.stringify(KEY))).toMatchObject({ clientEmail: KEY.client_email, clientId: KEY.client_id });
    expect(parseServiceAccount(Buffer.from(JSON.stringify(KEY)).toString("base64")).clientId).toBe(KEY.client_id);
    expect(() => parseServiceAccount("not json")).toThrow(/whole JSON file/);
    expect(() => parseServiceAccount(JSON.stringify({ ...KEY, type: "authorized_user" }))).toThrow(/not a service account key/);
  });

  it("signs a JWT Google can verify with the account's public key", () => {
    const sa = parseServiceAccount(JSON.stringify(KEY));
    const jwt = signJwt(sa, { iss: sa.clientEmail, sub: "madison@decoderhubs.com", scope: "https://mail.google.com/", aud: sa.tokenUri, iat: 1, exp: 3601 });
    const [head, body, sig] = jwt.split(".");
    expect(decode(head)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(body)).toMatchObject({ sub: "madison@decoderhubs.com", scope: "https://mail.google.com/" });
    expect(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });
});

describe("a Workspace mailbox signing in through the service account", () => {
  it("asks Google for a token as the mailbox itself, and reuses it until shortly before it expires", async () => {
    await saveServiceAccount(JSON.stringify(KEY));
    googleAnswers({ json: { access_token: "ya29.first", expires_in: 3600 } }, { json: { access_token: "ya29.second", expires_in: 3600 } });
    const now = Date.now();
    expect(await workspaceToken("madison@decoderhubs.com", now)).toBe("ya29.first");
    expect(await workspaceToken("madison@decoderhubs.com", now + 30 * 60_000)).toBe("ya29.first");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(decode(calls[0].body.get("assertion")!.split(".")[1])).toMatchObject({ iss: KEY.client_email, sub: "madison@decoderhubs.com", scope: "https://mail.google.com/" });
    // 56 minutes later the cached token is within 5 minutes of its end, so a new one is made.
    expect(await workspaceToken("madison@decoderhubs.com", now + 56 * 60_000)).toBe("ya29.second");
  });

  it("says exactly what the Workspace admin must do when Aperture isn't allowed yet", async () => {
    await saveServiceAccount(JSON.stringify(KEY));
    googleAnswers({ status: 401, json: { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method" } });
    await expect(workspaceToken("madison@decoderhubs.com")).rejects.toThrow(/admin hasn't allowed Aperture for decoderhubs\.com.*112233445566778899000.*https:\/\/mail\.google\.com\//);
  });

  it("names a mailbox Google doesn't know", () => {
    expect(explainWorkspaceRefusal("nobody@decoderhubs.com", "1", { error: "invalid_grant", error_description: "Invalid email or User ID" })).toMatch(/nobody@decoderhubs\.com is not a mailbox/);
  });

  it("refuses with a clear reason when no service account key is set", async () => {
    await expect(workspaceToken("madison@decoderhubs.com")).rejects.toThrow(/no service account key yet/);
  });

  it("gives the transport an access token and no password", async () => {
    await saveServiceAccount(JSON.stringify(KEY));
    await secretStore().put("mailbox:test-google", JSON.stringify({ kind: "google-workspace" }));
    googleAnswers({ json: { access_token: "ya29.mail", expires_in: 3600 } });
    const c = await credsFor({ address: "madison@decoderhubs.com", smtpHost: "smtp.gmail.com", smtpPort: 465, imapHost: "imap.gmail.com", imapPort: 993, credentialRef: "mailbox:test-google" });
    expect(c).toMatchObject({ username: "madison@decoderhubs.com", password: "", accessToken: "ya29.mail", smtpPort: 465 });
    expect(smtpAuth(c)).toEqual({ type: "OAuth2", user: "madison@decoderhubs.com", accessToken: "ya29.mail" });
    expect(imapAuth(c)).toEqual({ user: "madison@decoderhubs.com", accessToken: "ya29.mail" });
  });

  it("leaves password mailboxes exactly as they were", async () => {
    await secretStore().put("mailbox:test-pass", JSON.stringify({ u: "lena@bytepath.co", p: "app-password" }));
    const c = await credsFor({ address: "lena@bytepath.co", smtpHost: "mail.bytepath.co", smtpPort: 587, imapHost: "mail.bytepath.co", imapPort: 993, credentialRef: "mailbox:test-pass" });
    expect(c.accessToken).toBeUndefined();
    expect(smtpAuth(c)).toEqual({ user: "lena@bytepath.co", pass: "app-password" });
    expect(parseGoogleSecret(JSON.stringify({ u: "x", p: "y" }))).toBeNull();
  });
});

describe("Connect with Google, one mailbox", () => {
  it("sends the operator to Google for offline mail access as that mailbox, with a state only we can read", () => {
    const url = new URL(buildConnectUrl({ mailboxId: "mbx1", address: "madison@decoderhubs.com", operatorId: "op1" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toContain("https://mail.google.com/");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("madison@decoderhubs.com");
    const state = readConnectState(url.searchParams.get("state")!);
    expect(state).toMatchObject({ mailboxId: "mbx1", address: "madison@decoderhubs.com", operatorId: "op1" });
    expect(readConnectState(`${url.searchParams.get("state")!.slice(0, -4)}AAAA`)).toBeNull();
    expect(readConnectState(url.searchParams.get("state")!, Date.now() + 11 * 60_000)).toBeNull();
  });

  it("keeps the refresh token only when the person signed in as the mailbox itself", async () => {
    const state = readConnectState(new URL(buildConnectUrl({ mailboxId: "mbx1", address: "madison@decoderhubs.com", operatorId: "op1" })).searchParams.get("state")!)!;
    googleAnswers({ json: { access_token: "a", refresh_token: "1//rt", id_token: idToken({ email: "madison@decoderhubs.com", aud: "test-client" }) } });
    await expect(exchangeConnectCode("code", state)).resolves.toEqual({ refreshToken: "1//rt", email: "madison@decoderhubs.com" });
    expect(calls[0].body.get("code_verifier")).toBe(state.verifier);
    googleAnswers({ json: { access_token: "a", refresh_token: "1//rt", id_token: idToken({ email: "boss@gmail.com", aud: "test-client" }) } });
    await expect(exchangeConnectCode("code", state)).rejects.toThrow(/signed in as boss@gmail\.com, not madison@decoderhubs\.com/);
  });

  it("turns a revoked or 7-day-expired connection into an instruction", async () => {
    googleAnswers({ status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });
    await expect(refreshedToken("1//old")).rejects.toThrow(/Press Connect with Google on it again/);
  });
});
