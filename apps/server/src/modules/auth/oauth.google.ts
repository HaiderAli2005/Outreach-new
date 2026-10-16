import { createHash } from "node:crypto";
import { env, features, googleRedirectUri } from "../../config/env.js";
import { extractDomain, isValidDomain } from "../../lib/normalize.js";
import { randomToken } from "../../lib/crypto.js";
import { badRequest, notConfigured, unauthorized } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface OAuthState {
  state: string;
  verifier: string;
  next: string;
  /** The website typed before signing up, so a new Google account starts its setup like an email sign-up. */
  domain: string | null;
}

export function safeDomain(raw: unknown): string | null {
  const d = typeof raw === "string" && raw ? extractDomain(raw) : null;
  return d && isValidDomain(d) ? d : null;
}

export function safeNext(next: unknown): string {
  const s = typeof next === "string" ? next : "";
  return s.startsWith("/") && !s.startsWith("//") ? s.slice(0, 300) : "/app";
}

export function buildGoogleAuthUrl(next: string, domain: string | null = null): { url: string; state: OAuthState } {
  if (!features.googleOAuth) throw notConfigured("Google sign-in");
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return { url: `${AUTH_URL}?${params}`, state: { state, verifier, next: safeNext(next), domain: safeDomain(domain) } };
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

function decodeIdToken(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1];
  if (!payload) throw unauthorized("Google sign-in failed");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

export async function exchangeGoogleCode(code: string, verifier: string): Promise<GoogleIdentity> {
  if (!features.googleOAuth) throw notConfigured("Google sign-in");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: googleRedirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    // Google says why (invalid_client: wrong secret, redirect_uri_mismatch, invalid_grant: code used or expired).
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    logger.warn({ status: res.status, error: body.error, description: body.error_description, redirectUri: googleRedirectUri }, "google sign-in: code exchange refused");
    throw unauthorized(body.error === "invalid_client" ? "Google sign-in isn't set up correctly (the client secret doesn't match the client ID)." : "Google sign-in failed");
  }
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw unauthorized("Google sign-in failed");
  const claims = decodeIdToken(data.id_token);
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(String(claims.iss))) {
    logger.warn({ aud: claims.aud, expected: env.GOOGLE_CLIENT_ID, iss: claims.iss }, "google sign-in: token was issued for a different client");
    throw unauthorized("Google sign-in failed");
  }
  if (claims.email_verified !== true || typeof claims.email !== "string") throw badRequest("Your Google email address is not verified");
  return { sub: String(claims.sub), email: claims.email, name: typeof claims.name === "string" ? claims.name : null };
}
