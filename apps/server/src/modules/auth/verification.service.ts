import { randomBytes, randomInt } from "node:crypto";
import jwt from "jsonwebtoken";
import { env, webOrigins } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { AppError, badRequest, notConfigured, tooManyRequests } from "../../lib/errors.js";
import { mailEnabled, sendMail } from "../../integrations/mailer.js";
import * as ch from "./emailChallenge.js";
import { codeEmail, resetEmail, verifyEmail } from "./challengeEmail.js";
import * as repo from "./auth.repository.js";
import { buildSession, hashPassword, type ClientMeta } from "./auth.service.js";

export const CLAIM_COOKIE = "ap_claim";
export const CLAIM_TTL_SECONDS = 24 * 60 * 60;
const RESEND_GAP_MS = 60_000;

const origin = () => webOrigins[0] ?? "http://localhost:3100";
const answerMeta = (meta: ClientMeta) => ({ ip: meta.ip ?? null, agent: meta.userAgent ?? null });

export const verificationRequired = () => mailEnabled();

export function signClaim(userId: string): string {
  return jwt.sign({ sub: userId, purpose: "signup-claim" }, env.JWT_ACCESS_SECRET, { expiresIn: CLAIM_TTL_SECONDS, algorithm: "HS256", issuer: "aperture" });
}

function readClaim(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const decoded = jwt.verify(raw, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"], issuer: "aperture" });
    if (typeof decoded === "string" || decoded.purpose !== "signup-claim" || !decoded.sub) return null;
    return String(decoded.sub);
  } catch {
    return null;
  }
}

function challengeMail(email: string, c: ch.CreatedChallenge) {
  if (!c.numberWay) return codeEmail(email, { purpose: c.purpose, code: c.code });
  const p = { origin: origin(), token: c.token, numbers: c.numbers };
  return c.purpose === "VERIFY" ? verifyEmail(email, p) : resetEmail(email, p);
}

export async function sendChallengeMail(email: string, challenge: ch.CreatedChallenge): Promise<boolean> {
  return sendMail(challengeMail(email, challenge));
}

function fail(answer: Extract<ch.Answer, { ok: false }>): never {
  const status = answer.reason === "wrong_number" || answer.reason === "wrong_code" ? 400 : 410;
  throw new AppError(status, "CHALLENGE_FAILED", ch.challengeMessage(answer.reason), { reason: answer.reason, attemptsLeft: answer.attemptsLeft ?? 0 });
}

async function markVerified(userId: string) {
  await prisma.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
}

export async function startVerification(userId: string, email: string) {
  const recent = await ch.recentPending(userId, "VERIFY", RESEND_GAP_MS);
  if (recent) return { email, ...ch.forScreen(recent) };
  const challenge = await ch.createChallenge(userId, "VERIFY");
  await sendChallengeMail(email, challenge);
  return { email, ...ch.forScreen(challenge) };
}

export async function resendVerification(claimRaw: unknown) {
  const userId = readClaim(claimRaw);
  if (!userId) throw new AppError(401, "CLAIM_MISSING", "This screen can't send another email. Sign in again to get a new one.");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
  if (!user) throw new AppError(401, "CLAIM_MISSING", "This screen can't send another email. Sign in again to get a new one.");
  if (user.emailVerifiedAt) return { email: user.email, challengeId: null, matchNumber: null, codeSent: false, verified: true };
  const recent = await ch.recentPending(userId, "VERIFY", RESEND_GAP_MS);
  if (recent) throw tooManyRequests("An email was just sent. Check your inbox, or try again in a minute.");
  const challenge = await ch.createChallenge(userId, "VERIFY");
  await sendChallengeMail(user.email, challenge);
  return { email: user.email, ...ch.forScreen(challenge), verified: false };
}

export async function claimSession(claimRaw: unknown, meta: ClientMeta) {
  const userId = readClaim(claimRaw);
  if (!userId) return { claimed: false as const, reason: "no-claim" };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true, status: true } });
  if (!user || user.status !== "ACTIVE") return { claimed: false as const, reason: "no-user" };
  if (!user.emailVerifiedAt) return { claimed: false as const, reason: "not-verified" };
  return { claimed: true as const, ...(await buildSession(userId, null, meta)) };
}

export async function verifyFromEmail(token: unknown, choice: unknown, meta: ClientMeta) {
  const row = await ch.findByToken(token);
  if (row && row.purpose !== "VERIFY") throw badRequest("This link is for a password reset. Open it from the reset email.");
  const hasChoice = choice !== undefined && choice !== null && String(choice) !== "";
  const answer = hasChoice ? await ch.answerWithNumber(token, choice, answerMeta(meta)) : await ch.approveWithoutNumber(token, answerMeta(meta));
  if (!answer.ok) fail(answer);
  await markVerified(answer.userId);
  return buildSession(answer.userId, null, meta);
}

export async function answerCode(challengeId: unknown, code: unknown, meta: ClientMeta) {
  const answer = await ch.answerWithCode(challengeId, code, answerMeta(meta));
  if (!answer.ok) fail(answer.reason === "not_found" ? { ...answer, reason: "wrong_code", attemptsLeft: ch.MAX_ATTEMPTS - 1 } : answer);
  if (answer.purpose === "RESET") return { purpose: "RESET" as const, token: answer.token };
  await markVerified(answer.userId);
  return { purpose: "VERIFY" as const, ...(await buildSession(answer.userId, null, meta)) };
}

const codeSentAt = new Map<string, number>();

export async function sendCode(challengeId: unknown) {
  const row = await ch.findById(challengeId);
  if (!row) return { sent: true };
  if (row.status !== "PENDING" || row.expiresAt.getTime() < Date.now()) {
    const reason: ch.ChallengeReason = row.status === "FAILED" ? "too_many_attempts" : row.status === "APPROVED" ? "already_used" : "expired";
    fail({ ok: false, reason, purpose: row.purpose });
  }
  const last = codeSentAt.get(row.id) ?? 0;
  if (Date.now() - last < RESEND_GAP_MS) throw tooManyRequests("A code was just sent. Check your inbox, or try again in a minute.");
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { email: true } });
  if (!user) return { sent: true };
  codeSentAt.set(row.id, Date.now());
  await sendMail(codeEmail(user.email, { purpose: row.purpose, code: row.code }));
  return { sent: true };
}

export async function forgotPassword(emailRaw: string) {
  if (!mailEnabled()) throw notConfigured("Email");
  const email = emailRaw.trim().toLowerCase();
  const user = await repo.findUserByEmail(email);
  if (!user || user.status !== "ACTIVE") {
    return { challengeId: randomBytes(12).toString("hex"), matchNumber: randomInt(10, 100), codeSent: false };
  }
  const recent = await ch.recentPending(user.id, "RESET", RESEND_GAP_MS);
  if (recent) return ch.forScreen(recent);
  const challenge = await ch.createChallenge(user.id, "RESET");
  await sendChallengeMail(user.email, challenge);
  return ch.forScreen(challenge);
}

export async function checkResetLink(token: unknown, choice: unknown, meta: ClientMeta) {
  const row = await ch.findByToken(token);
  if (!row || row.purpose !== "RESET") fail({ ok: false, reason: "not_found", purpose: null });
  if (row!.status === "APPROVED" && row!.expiresAt.getTime() > Date.now()) return { ok: true };
  const hasChoice = choice !== undefined && choice !== null && String(choice) !== "";
  const answer = hasChoice ? await ch.answerWithNumber(token, choice, answerMeta(meta)) : await ch.approveWithoutNumber(token, answerMeta(meta));
  if (!answer.ok) fail(answer);
  return { ok: true };
}

export async function resetPassword(token: unknown, password: string) {
  const row = await ch.findByToken(token);
  if (!row || row.purpose !== "RESET") fail({ ok: false, reason: "not_found", purpose: null });
  if (row!.status === "PENDING") throw new AppError(410, "CHALLENGE_FAILED", "Tap the number in your email first.", { reason: "not_answered" });
  if (row!.status !== "APPROVED" || row!.expiresAt.getTime() < Date.now()) fail({ ok: false, reason: row!.status === "APPROVED" ? "expired" : "already_used", purpose: "RESET" });
  const passwordHash = await hashPassword(password);
  const spent = await prisma.emailChallenge.updateMany({ where: { id: row!.id, status: "APPROVED" }, data: { status: "EXPIRED" } });
  if (!spent.count) fail({ ok: false, reason: "already_used", purpose: "RESET" });
  await prisma.user.update({ where: { id: row!.userId }, data: { passwordHash } });
  await markVerified(row!.userId);
  await repo.revokeAllForUser(row!.userId);
  return { updated: true };
}
