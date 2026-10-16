import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { ChallengePurpose, EmailChallenge } from "@prisma/client";
import { prisma, type Db } from "../../lib/prisma.js";
import { safeEqual } from "../../lib/crypto.js";

export const MAX_ATTEMPTS = 3;
export const TTL_MINUTES: Record<ChallengePurpose, number> = { VERIFY: 24 * 60, RESET: 60 };
export const NUMBER_LOCK_MINUTES = 24 * 60;

export type ChallengeReason = "not_found" | "already_used" | "too_many_attempts" | "expired" | "wrong_number" | "wrong_code";

export interface CreatedChallenge {
  id: string;
  token: string;
  matchNumber: number;
  numbers: number[];
  code: string;
  expiresAt: Date;
  purpose: ChallengePurpose;
  numberWay: boolean;
}

export type Answer =
  | { ok: true; challengeId: string; userId: string; purpose: ChallengePurpose; token: string }
  | { ok: false; reason: ChallengeReason; attemptsLeft?: number; purpose: ChallengePurpose | null };

export function pickNumbers(): number[] {
  const reversed = (n: number) => Number(String(n).split("").reverse().join(""));
  const numbers: number[] = [];
  while (numbers.length < 3) {
    const candidate = randomInt(10, 100);
    const tooClose = numbers.some((n) => n === candidate || reversed(n) === candidate || Math.abs(n - candidate) < 3);
    if (!tooClose) numbers.push(candidate);
  }
  return numbers;
}

export const sixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export async function numberWayLocked(userId: string, db: Db = prisma): Promise<boolean> {
  const since = new Date(Date.now() - NUMBER_LOCK_MINUTES * 60_000);
  const failed = await db.emailChallenge.findFirst({ where: { userId, status: "FAILED", failedAt: { gt: since } }, select: { id: true } });
  return Boolean(failed);
}

export async function createChallenge(userId: string, purpose: ChallengePurpose, db: Db = prisma): Promise<CreatedChallenge> {
  await db.emailChallenge.updateMany({ where: { userId, purpose, status: "PENDING" }, data: { status: "EXPIRED" } });
  const [matchNumber, decoyOne, decoyTwo] = pickNumbers();
  const row = await db.emailChallenge.create({
    data: {
      id: randomBytes(12).toString("hex"),
      userId,
      purpose,
      token: randomUUID(),
      matchNumber,
      decoyOne,
      decoyTwo,
      code: sixDigitCode(),
      expiresAt: new Date(Date.now() + TTL_MINUTES[purpose] * 60_000),
    },
  });
  return { ...toCreated(row), numberWay: !(await numberWayLocked(userId, db)) };
}

export async function recentPending(userId: string, purpose: ChallengePurpose, withinMs: number): Promise<CreatedChallenge | null> {
  const row = await prisma.emailChallenge.findFirst({
    where: { userId, purpose, status: "PENDING", createdAt: { gt: new Date(Date.now() - withinMs) }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  return row ? { ...toCreated(row), numberWay: !(await numberWayLocked(userId)) } : null;
}

function toCreated(row: EmailChallenge): Omit<CreatedChallenge, "numberWay"> {
  const numbers = [row.matchNumber, row.decoyOne, row.decoyTwo]
    .map((value) => ({ value, sort: randomInt(0, 1_000_000) }))
    .sort((a, b) => a.sort - b.sort)
    .map((e) => e.value);
  return { id: row.id, token: row.token, matchNumber: row.matchNumber, numbers, code: row.code, expiresAt: row.expiresAt, purpose: row.purpose };
}

export function forScreen(challenge: CreatedChallenge | null) {
  if (!challenge) return { challengeId: null, matchNumber: null, codeSent: false };
  return { challengeId: challenge.id, matchNumber: challenge.numberWay ? challenge.matchNumber : null, codeSent: !challenge.numberWay };
}

export const findByToken = (token: unknown) =>
  typeof token === "string" && token ? prisma.emailChallenge.findUnique({ where: { token } }) : Promise.resolve(null);

export const findById = (id: unknown) =>
  typeof id === "string" && id ? prisma.emailChallenge.findUnique({ where: { id } }) : Promise.resolve(null);

function usability(row: EmailChallenge | null): { ok: true } | { ok: false; reason: ChallengeReason } {
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "APPROVED") return { ok: false, reason: "already_used" };
  if (row.status === "FAILED") return { ok: false, reason: "too_many_attempts" };
  if (row.status === "EXPIRED" || row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };
  return { ok: true };
}

async function refuse(row: EmailChallenge | null, reason: ChallengeReason): Promise<Answer> {
  if (row && reason === "expired") await prisma.emailChallenge.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "EXPIRED" } });
  return { ok: false, reason, purpose: row?.purpose ?? null };
}

async function registerWrongAnswer(row: EmailChallenge, reason: "wrong_number" | "wrong_code"): Promise<Answer> {
  const attempts = row.attempts + 1;
  const dead = attempts >= MAX_ATTEMPTS;
  await prisma.emailChallenge.update({
    where: { id: row.id },
    data: dead ? { attempts, status: "FAILED", failedAt: new Date() } : { attempts },
  });
  return { ok: false, reason: dead ? "too_many_attempts" : reason, attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts), purpose: row.purpose };
}

async function approve(row: EmailChallenge, meta: { ip?: string | null; agent?: string | null }): Promise<Answer> {
  const claimed = await prisma.emailChallenge.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "APPROVED", consumedAt: new Date(), answeredIp: meta.ip ?? null, answeredAgent: meta.agent?.slice(0, 255) ?? null },
  });
  if (!claimed.count) return { ok: false, reason: "already_used", purpose: row.purpose };
  return { ok: true, challengeId: row.id, userId: row.userId, purpose: row.purpose, token: row.token };
}

export async function answerWithNumber(token: unknown, choice: unknown, meta: { ip?: string | null; agent?: string | null }): Promise<Answer> {
  const row = await findByToken(token);
  const state = usability(row);
  if (!state.ok) return refuse(row, state.reason);
  const picked = Number(choice);
  if (!Number.isInteger(picked) || !safeEqual(String(picked), String(row!.matchNumber))) return registerWrongAnswer(row!, "wrong_number");
  return approve(row!, meta);
}

export async function answerWithCode(challengeId: unknown, code: unknown, meta: { ip?: string | null; agent?: string | null }): Promise<Answer> {
  const row = await findById(challengeId);
  const state = usability(row);
  if (!state.ok) return refuse(row, state.reason);
  const given = String(code ?? "").trim();
  if (given.length !== 6 || !safeEqual(given, row!.code)) return registerWrongAnswer(row!, "wrong_code");
  return approve(row!, meta);
}

export async function approveWithoutNumber(token: unknown, meta: { ip?: string | null; agent?: string | null }): Promise<Answer> {
  const row = await findByToken(token);
  const state = usability(row);
  if (!state.ok) return refuse(row, state.reason);
  return approve(row!, meta);
}

export async function challengeStatus(challengeId: unknown) {
  const row = await findById(challengeId);
  if (!row) return { status: "PENDING" as const, purpose: null, attemptsLeft: MAX_ATTEMPTS, expiresAt: null };
  if (row.purpose === "VERIFY" && row.status === "PENDING") {
    const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { emailVerifiedAt: true } });
    if (user?.emailVerifiedAt) return { status: "APPROVED" as const, purpose: row.purpose, attemptsLeft: 0, expiresAt: row.expiresAt };
  }
  if (row.status === "PENDING" && row.expiresAt.getTime() < Date.now()) {
    await prisma.emailChallenge.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "EXPIRED" } });
    return { status: "EXPIRED" as const, purpose: row.purpose, attemptsLeft: 0, expiresAt: row.expiresAt };
  }
  return { status: row.status, purpose: row.purpose, attemptsLeft: Math.max(0, MAX_ATTEMPTS - row.attempts), expiresAt: row.expiresAt };
}

export function challengeMessage(reason: ChallengeReason): string {
  switch (reason) {
    case "wrong_number":
      return "That is not the number shown on your other screen. Check it and try again.";
    case "wrong_code":
      return "That code isn't right. Check the latest email and try again.";
    case "too_many_attempts":
      return "Too many wrong tries. Ask for a new email and try again.";
    case "expired":
      return "This link has expired. Ask for a new email.";
    case "already_used":
      return "This link has already been used.";
    default:
      return "This link isn't valid. Ask for a new email.";
  }
}
