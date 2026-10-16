import { logger } from "../../lib/logger.js";
import type { Request, Response, CookieOptions } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env, features, isProd, webOrigins } from "../../config/env.js";
import { ok, created, currentUser } from "../../lib/http.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { parseBody } from "../../middleware/validate.js";
import * as service from "./auth.service.js";
import * as verification from "./verification.service.js";
import { challengeStatus as challengeStatusOf } from "./emailChallenge.js";
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH, REFRESH_TTL_DAYS } from "./tokens.js";
import { buildGoogleAuthUrl, exchangeGoogleCode, type OAuthState } from "./oauth.google.js";

const OAUTH_COOKIE = "ap_oauth";

const refreshCookieOpts = (): CookieOptions => ({
  httpOnly: true,
  secure: isProd,
  sameSite: "strict",
  path: REFRESH_COOKIE_PATH,
  maxAge: REFRESH_TTL_DAYS * 86_400_000,
});

function meta(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}

function sendSession(res: Response, result: { session: service.SessionPayload; refreshToken: string }, status = 200) {
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOpts());
  return status === 201 ? created(res, result.session) : ok(res, result.session);
}

const password = z.string().min(8, "Use at least 8 characters").max(128);

const registerSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120),
  email: z.email("Enter a valid email").max(254),
  password,
  organizationName: z.string().trim().max(120).optional(),
  domain: z.string().trim().max(253).optional(),
});

const loginSchema = z.object({ email: z.email("Enter a valid email"), password: z.string().min(1).max(128) });

const claimCookieOpts = (): CookieOptions => ({
  httpOnly: true,
  secure: isProd,
  sameSite: "strict",
  path: REFRESH_COOKIE_PATH,
  maxAge: verification.CLAIM_TTL_SECONDS * 1000,
});

function sendOutcome(res: Response, outcome: service.AuthOutcome, status = 200) {
  if (outcome.kind === "session") return sendSession(res, outcome, status);
  res.cookie(verification.CLAIM_COOKIE, verification.signClaim(outcome.userId), claimCookieOpts());
  const body = { verificationRequired: true, verification: outcome.verification };
  return status === 201 ? created(res, body) : ok(res, body);
}

export async function register(req: Request, res: Response) {
  const body = parseBody(req, registerSchema);
  return sendOutcome(res, await service.register(body, meta(req)), 201);
}

export async function login(req: Request, res: Response) {
  const body = parseBody(req, loginSchema);
  return sendOutcome(res, await service.login(body.email, body.password, meta(req)));
}

const challengeIdSchema = z.object({ challengeId: z.string().min(1).max(64) });
const tokenSchema = z.object({ token: z.string().min(1).max(100), n: z.union([z.string().max(4), z.number()]).optional() });

export async function challengeStatus(req: Request, res: Response) {
  const { challengeId } = parseBody(req, challengeIdSchema);
  return ok(res, await challengeStatusOf(challengeId));
}

export async function challengeCode(req: Request, res: Response) {
  const body = parseBody(req, challengeIdSchema.extend({ code: z.string().min(1).max(12) }));
  const result = await verification.answerCode(body.challengeId, body.code, meta(req));
  if (result.purpose === "RESET") return ok(res, result);
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOpts());
  res.clearCookie(verification.CLAIM_COOKIE, { path: REFRESH_COOKIE_PATH });
  return ok(res, { purpose: "VERIFY", session: result.session });
}

export async function challengeSendCode(req: Request, res: Response) {
  const { challengeId } = parseBody(req, challengeIdSchema);
  return ok(res, await verification.sendCode(challengeId));
}

export async function verifyEmail(req: Request, res: Response) {
  const body = parseBody(req, tokenSchema);
  const result = await verification.verifyFromEmail(body.token, body.n, meta(req));
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOpts());
  return ok(res, result.session);
}

export async function resendVerification(req: Request, res: Response) {
  return ok(res, await verification.resendVerification(req.cookies?.[verification.CLAIM_COOKIE]));
}

export async function claim(req: Request, res: Response) {
  const result = await verification.claimSession(req.cookies?.[verification.CLAIM_COOKIE], meta(req));
  if (!result.claimed) return ok(res, { claimed: false, reason: result.reason });
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOpts());
  res.clearCookie(verification.CLAIM_COOKIE, { path: REFRESH_COOKIE_PATH });
  return ok(res, { claimed: true, session: result.session });
}

export async function forgotPassword(req: Request, res: Response) {
  const { email } = parseBody(req, z.object({ email: z.email("Enter a valid email").max(254) }));
  return ok(res, await verification.forgotPassword(email));
}

export async function checkResetLink(req: Request, res: Response) {
  const body = parseBody(req, tokenSchema);
  return ok(res, await verification.checkResetLink(body.token, body.n, meta(req)));
}

export async function resetPassword(req: Request, res: Response) {
  const body = parseBody(req, z.object({ token: z.string().min(1).max(100), password }));
  return ok(res, await verification.resetPassword(body.token, body.password));
}

export async function refresh(req: Request, res: Response) {
  if (req.get("x-requested-with") !== "aperture") throw badRequest("Missing X-Requested-With header");
  const org = typeof req.body?.organizationId === "string" ? req.body.organizationId : null;
  try {
    return sendSession(res, await service.refresh(req.cookies?.[REFRESH_COOKIE], org, meta(req)));
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    throw err;
  }
}

export async function logout(req: Request, res: Response) {
  await service.logout(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  return ok(res, { signedOut: true });
}

export async function me(req: Request, res: Response) {
  const user = currentUser(req);
  return ok(res, await service.me(user.id, req.get("x-organization-id") ?? (req as { tokenOrg?: string | null }).tokenOrg ?? null));
}

export async function acceptInvite(req: Request, res: Response) {
  const { token } = parseBody(req, z.object({ token: z.string().min(10).max(200) }));
  const user = currentUser(req);
  return ok(res, await service.acceptInvite(user.id, user.email, token));
}

export function providers(_req: Request, res: Response) {
  return ok(res, { google: features.googleOAuth, passwordReset: verification.verificationRequired() });
}

export function googleStart(req: Request, res: Response) {
  // This is a page the browser navigates to, so problems go back to the sign-in page instead of showing raw JSON.
  if (!features.googleOAuth) {
    return res.redirect(302, `${webOrigins[0] ?? ""}/signin?error=${encodeURIComponent("Google sign-in isn't switched on yet. Use your email for now.")}`);
  }
  const { url, state } = buildGoogleAuthUrl(String(req.query.next ?? "/app"), typeof req.query.domain === "string" ? req.query.domain : null);
  const signed = jwt.sign(state, env.JWT_ACCESS_SECRET, { expiresIn: 600 });
  res.cookie(OAUTH_COOKIE, signed, { httpOnly: true, secure: isProd, sameSite: "lax", path: "/api/v1/auth/oauth", maxAge: 600_000 });
  res.redirect(302, url);
}

export async function googleCallback(req: Request, res: Response) {
  const web = webOrigins[0] ?? "";
  const fail = (reason: string) => res.redirect(302, `${web}/signin?error=${encodeURIComponent(reason)}`);
  const raw = req.cookies?.[OAUTH_COOKIE];
  res.clearCookie(OAUTH_COOKIE, { path: "/api/v1/auth/oauth" });
  if (req.query.error) return fail("Google sign-in was cancelled");
  let state: OAuthState;
  try {
    state = jwt.verify(String(raw ?? ""), env.JWT_ACCESS_SECRET) as OAuthState;
  } catch {
    return fail("Your sign-in session expired, please try again");
  }
  if (!req.query.state || req.query.state !== state.state || typeof req.query.code !== "string") {
    // Usually a second sign-in started in another tab, which replaced this one's cookie.
    logger.warn({ hasCode: typeof req.query.code === "string", stateMatches: req.query.state === state.state }, "google sign-in: state check failed");
    return fail("Google sign-in was started again in another tab. Please try once more.");
  }
  try {
    const identity = await exchangeGoogleCode(req.query.code, state.verifier);
    const result = await service.oauthSignIn("google", identity.sub, identity.email, identity.name, meta(req), { domain: state.domain ?? null });
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOpts());
    return res.redirect(302, `${web}/auth/callback?next=${encodeURIComponent(state.next)}`);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "google sign-in: failed after Google returned");
    if (err instanceof Error && err.message) return fail(err.message);
    throw unauthorized();
  }
}
