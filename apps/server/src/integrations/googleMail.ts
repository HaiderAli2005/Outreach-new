import { createHash, createSign } from "node:crypto";
import { env, googleMailClient, googleMailRedirectUri } from "../config/env.js";
import { decrypt, encrypt, randomToken, sha256 } from "../lib/crypto.js";
import { badRequest, notConfigured } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { secretStore } from "./secrets.js";

/**
 * Google Workspace mailboxes that sign in with OAuth 2.0 (SASL XOAUTH2 over SMTP and IMAP) instead of a password.
 * Google no longer accepts a plain password from outside programs, so a Google mailbox otherwise needs 2-step
 * verification and an app password made by hand, one mailbox at a time.
 *
 * Two ways to get the access token, both kept in the secret store under the mailbox's credential_ref:
 *
 *   {"kind":"google-workspace"}            Aperture's service account acts as the mailbox (domain-wide delegation).
 *                                          A Workspace admin allows the service account's client ID once, with the
 *                                          scope https://mail.google.com/, and every mailbox in that Workspace works.
 *   {"kind":"google-oauth","rt":"..."}     One mailbox, connected by signing in to it once ("Connect with Google").
 *                                          The refresh token is kept; access tokens are made from it.
 *
 * Access tokens last an hour and are cached here until five minutes before they expire. Nothing in this file is ever
 * logged with a secret in it.
 */

export const GOOGLE_MAIL_SCOPE = "https://mail.google.com/";
export const GOOGLE_SMTP = { host: "smtp.gmail.com", port: 465 } as const;
export const GOOGLE_IMAP = { host: "imap.gmail.com", port: 993 } as const;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** Where an operator-saved service account key lives in the secret store. */
export const SERVICE_ACCOUNT_REF = "google-mail:service-account";
const EARLY_MS = 5 * 60_000;

export type GoogleSecret = { kind: "google-workspace" } | { kind: "google-oauth"; rt: string };

export function parseGoogleSecret(raw: string): GoogleSecret | null {
  try {
    const j = JSON.parse(raw) as { kind?: string; rt?: string };
    if (j.kind === "google-workspace") return { kind: "google-workspace" };
    if (j.kind === "google-oauth" && typeof j.rt === "string" && j.rt) return { kind: "google-oauth", rt: j.rt };
  } catch {
    /* a password, not a Google secret */
  }
  return null;
}

// ─── service account (domain-wide delegation) ─────────────────────────────────────────────────────────────────

export interface ServiceAccount {
  clientEmail: string;
  clientId: string;
  privateKey: string;
  tokenUri: string;
}

/** Reads a service account JSON key, pasted raw or base64. Throws a plain message when it isn't one. */
export function parseServiceAccount(raw: string): ServiceAccount {
  let text = raw.trim();
  if (!text.startsWith("{")) {
    try {
      text = Buffer.from(text, "base64").toString("utf8").trim();
    } catch {
      /* falls through to the JSON error */
    }
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw badRequest("That isn't a service account key. Paste the whole JSON file Google gave you.");
  }
  if (j.type !== "service_account" || typeof j.client_email !== "string" || typeof j.private_key !== "string" || typeof j.client_id !== "string") {
    throw badRequest('That JSON is not a service account key (it needs "type": "service_account", client_email, client_id and private_key).');
  }
  if (!j.private_key.includes("PRIVATE KEY")) throw badRequest("The private_key in that file is not a key.");
  return { clientEmail: j.client_email, clientId: j.client_id, privateKey: j.private_key, tokenUri: typeof j.token_uri === "string" ? j.token_uri : TOKEN_URL };
}

let saCache: { value: ServiceAccount | null; at: number } | null = null;

/** The service account: the secret store copy (saved from Admin) wins over GOOGLE_MAIL_SERVICE_ACCOUNT. */
export async function serviceAccount(): Promise<ServiceAccount | null> {
  if (saCache && Date.now() - saCache.at < 60_000) return saCache.value;
  let value: ServiceAccount | null = null;
  const stored = await secretStore().get(SERVICE_ACCOUNT_REF);
  const raw = stored ?? env.GOOGLE_MAIL_SERVICE_ACCOUNT ?? null;
  if (raw) {
    try {
      value = parseServiceAccount(raw);
    } catch (e) {
      logger.error({ source: stored ? "secret store" : "GOOGLE_MAIL_SERVICE_ACCOUNT", err: (e as Error).message }, "google mail: the service account key can't be read");
    }
  }
  saCache = { value, at: Date.now() };
  return value;
}

export async function saveServiceAccount(raw: string): Promise<ServiceAccount> {
  const sa = parseServiceAccount(raw);
  // Proves the key signs before it is kept: Google answers a bad signature with invalid_grant, not a 5xx.
  signJwt(sa, { iss: sa.clientEmail, scope: GOOGLE_MAIL_SCOPE, aud: sa.tokenUri, iat: 0, exp: 1 });
  await secretStore().put(SERVICE_ACCOUNT_REF, JSON.stringify({ type: "service_account", client_email: sa.clientEmail, client_id: sa.clientId, private_key: sa.privateKey, token_uri: sa.tokenUri }));
  saCache = null;
  tokens.clear();
  return sa;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** An RS256 JWT, signed with the service account's private key. */
export function signJwt(sa: ServiceAccount, claims: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(sa.privateKey);
  return `${head}.${body}.${b64url(signature)}`;
}

/** What the operator must do, in Google's admin console, so the service account may act as a Workspace's mailboxes. */
export function delegationSteps(clientId: string): string {
  return `In admin.google.com, open Security > Access and data control > API controls > Manage domain-wide delegation, press Add new, paste the client ID ${clientId} and the scope ${GOOGLE_MAIL_SCOPE}, then Authorize.`;
}

// ─── access tokens ──────────────────────────────────────────────────────────────────────────────────────────

const tokens = new Map<string, { token: string; until: number }>();

/** For tests. */
export function clearGoogleTokenCache(): void {
  tokens.clear();
  saCache = null;
}

interface TokenReply {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function postToken(url: string, body: Record<string, string>): Promise<{ ok: boolean; status: number; json: TokenReply }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const json = (await res.json().catch(() => ({}))) as TokenReply;
  return { ok: res.ok && !!json.access_token, status: res.status, json };
}

/** A token for one Workspace mailbox, made by the service account acting as it. */
export async function workspaceToken(address: string, now = Date.now()): Promise<string> {
  const key = `sa:${address.toLowerCase()}`;
  const hit = tokens.get(key);
  if (hit && hit.until > now) return hit.token;
  const sa = await serviceAccount();
  if (!sa) throw notConfigured("Google Workspace sign-in (no service account key yet: add it in Admin > Domains, or set GOOGLE_MAIL_SERVICE_ACCOUNT)");
  const iat = Math.floor(now / 1000);
  const assertion = signJwt(sa, { iss: sa.clientEmail, sub: address, scope: GOOGLE_MAIL_SCOPE, aud: sa.tokenUri, iat, exp: iat + 3600 });
  const r = await postToken(sa.tokenUri, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  if (!r.ok) throw new Error(explainWorkspaceRefusal(address, sa.clientId, r.json));
  const token = r.json.access_token!;
  tokens.set(key, { token, until: now + (r.json.expires_in ?? 3600) * 1000 - EARLY_MS });
  return token;
}

/** Google's refusal, turned into what the operator should do about it. */
export function explainWorkspaceRefusal(address: string, clientId: string, j: TokenReply): string {
  const why = `${j.error ?? "error"}${j.error_description ? `: ${j.error_description}` : ""}`;
  if (j.error === "unauthorized_client" || j.error === "access_denied") return `Google refused: the Workspace admin hasn't allowed Aperture for ${address.split("@")[1]} yet. ${delegationSteps(clientId)} (${why})`;
  if (j.error === "invalid_grant" && /invalid email|user id|not found/i.test(j.error_description ?? "")) return `Google refused: ${address} is not a mailbox in a Workspace that allowed Aperture. Check the address and that the domain's admin authorised the client ID. (${why})`;
  if (j.error === "invalid_grant") return `Google refused the service account (${why}). If the key was deleted in Google Cloud, upload a new one in Admin > Domains.`;
  return `Google sign-in failed (${why}).`;
}

/** A token for one mailbox connected with "Connect with Google", made from its refresh token. */
export async function refreshedToken(refreshToken: string, now = Date.now()): Promise<string> {
  const key = `rt:${sha256(refreshToken)}`;
  const hit = tokens.get(key);
  if (hit && hit.until > now) return hit.token;
  if (!googleMailClient.id || !googleMailClient.secret) throw notConfigured("Connect with Google (GOOGLE_MAIL_CLIENT_ID and GOOGLE_MAIL_CLIENT_SECRET, or the sign-in client)");
  const r = await postToken(TOKEN_URL, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: googleMailClient.id, client_secret: googleMailClient.secret });
  if (!r.ok) {
    const why = `${r.json.error ?? r.status}${r.json.error_description ? `: ${r.json.error_description}` : ""}`;
    throw new Error(
      r.json.error === "invalid_grant"
        ? `Google ended this mailbox's connection (${why}). Press Connect with Google on it again. A Google app still in "Testing" ends every connection after 7 days; publish it to stop that.`
        : `Google sign-in failed (${why}).`,
    );
  }
  const token = r.json.access_token!;
  tokens.set(key, { token, until: now + (r.json.expires_in ?? 3600) * 1000 - EARLY_MS });
  return token;
}

/** The access token behind a Google secret. */
export async function accessTokenFor(address: string, secret: GoogleSecret): Promise<string> {
  return secret.kind === "google-workspace" ? workspaceToken(address) : refreshedToken(secret.rt);
}

// ─── "Connect with Google" for one mailbox ───────────────────────────────────────────────────────────────────

export interface ConnectState {
  mailboxId: string;
  address: string;
  operatorId: string;
  verifier: string;
  exp: number;
}

/**
 * The URL that sends the operator to Google to sign in as the mailbox. The state is encrypted and authenticated with
 * ENCRYPTION_KEY, so the callback (which arrives without our access token) can trust what it carries, for 10 minutes.
 */
export function buildConnectUrl(s: Omit<ConnectState, "verifier" | "exp">, now = Date.now()): string {
  if (!googleMailClient.id || !googleMailClient.secret) throw notConfigured("Connect with Google (GOOGLE_MAIL_CLIENT_ID and GOOGLE_MAIL_CLIENT_SECRET, or the sign-in client)");
  const verifier = randomToken(48);
  const state: ConnectState = { ...s, verifier, exp: now + 10 * 60_000 };
  const params = new URLSearchParams({
    client_id: googleMailClient.id,
    redirect_uri: googleMailRedirectUri,
    response_type: "code",
    scope: `openid email ${GOOGLE_MAIL_SCOPE}`,
    access_type: "offline",
    // Without "consent" Google sends no refresh token the second time a mailbox is connected.
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: s.address,
    state: Buffer.from(encrypt(JSON.stringify(state))).toString("base64url"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

export function readConnectState(raw: string, now = Date.now()): ConnectState | null {
  try {
    const s = JSON.parse(decrypt(Buffer.from(raw, "base64url").toString("utf8"))) as ConnectState;
    return s.exp > now && s.mailboxId && s.address && s.verifier ? s : null;
  } catch {
    return null;
  }
}

/** Swaps the code for a refresh token and checks the person signed in as the mailbox, not some other account. */
export async function exchangeConnectCode(code: string, state: ConnectState): Promise<{ refreshToken: string; email: string }> {
  const r = await postToken(TOKEN_URL, {
    grant_type: "authorization_code",
    code,
    client_id: googleMailClient.id ?? "",
    client_secret: googleMailClient.secret ?? "",
    redirect_uri: googleMailRedirectUri,
    code_verifier: state.verifier,
  });
  if (!r.ok) throw new Error(`Google didn't accept the sign-in (${r.json.error ?? r.status}${r.json.error_description ? `: ${r.json.error_description}` : ""}).`);
  if (!r.json.refresh_token) throw new Error("Google sent no long-lived key. Remove Aperture from the mailbox's Google Account (Security > Third-party access), then connect again.");
  const claims = r.json.id_token ? (JSON.parse(Buffer.from(r.json.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string; aud?: string }) : {};
  if (claims.aud && claims.aud !== googleMailClient.id) throw new Error("Google's answer was for a different app.");
  const email = (claims.email ?? "").toLowerCase();
  if (email !== state.address.toLowerCase()) throw new Error(`You signed in as ${email || "another account"}, not ${state.address}. Sign in as the mailbox itself.`);
  return { refreshToken: r.json.refresh_token, email };
}
