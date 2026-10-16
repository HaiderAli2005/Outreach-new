import bcrypt from "bcrypt";
import type { MemberRole } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { badRequest, conflict, forbidden, notFound, tooManyRequests, unauthorized } from "../../lib/errors.js";
import { getRedis } from "../../lib/redis.js";
import { brandFromDomain, extractDomain, isFreeMailDomain, isValidDomain } from "../../lib/normalize.js";
import * as repo from "./auth.repository.js";
import { ACCESS_TTL_SECONDS, REFRESH_TTL_DAYS, signAccessToken } from "./tokens.js";
import { createChallenge, forScreen } from "./emailChallenge.js";
import { sendChallengeMail, startVerification, verificationRequired } from "./verification.service.js";

const BCRYPT_COST = 12;
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hash("not-a-real-password", BCRYPT_COST));
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60_000;

export interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export type Verification = { email: string; challengeId: string | null; matchNumber: number | null; codeSent: boolean };

export type AuthOutcome =
  | { kind: "session"; session: SessionPayload; refreshToken: string }
  | { kind: "verify"; userId: string; verification: Verification };

export interface SessionPayload {
  accessToken: string;
  expiresIn: number;
  user: { id: string; email: string; name: string | null; isPlatformAdmin: boolean };
  organizations: { id: string; name: string; role: MemberRole; primaryDomain: string | null }[];
  activeOrganizationId: string | null;
}

const memoryFailures = new Map<string, { n: number; t: number }>();

async function failureCount(key: string): Promise<number> {
  const redis = getRedis();
  if (redis && redis.status === "ready") return Number((await redis.get(`lf:${key}`).catch(() => "0")) ?? 0);
  const e = memoryFailures.get(key);
  if (!e || Date.now() - e.t > FAILURE_WINDOW_MS) return 0;
  return e.n;
}

async function noteFailure(key: string): Promise<void> {
  const redis = getRedis();
  if (redis && redis.status === "ready") {
    const n = await redis.incr(`lf:${key}`).catch(() => 0);
    if (n === 1) await redis.pexpire(`lf:${key}`, FAILURE_WINDOW_MS).catch(() => undefined);
    return;
  }
  const e = memoryFailures.get(key);
  if (!e || Date.now() - e.t > FAILURE_WINDOW_MS) memoryFailures.set(key, { n: 1, t: Date.now() });
  else e.n += 1;
}

async function clearFailures(key: string): Promise<void> {
  memoryFailures.delete(key);
  await getRedis()?.del(`lf:${key}`).catch(() => undefined);
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function buildSession(userId: string, preferredOrgId: string | null, meta: ClientMeta, familyId?: string): Promise<{ session: SessionPayload; refreshToken: string }> {
  const user = await repo.findUserById(userId);
  if (!user || user.status !== "ACTIVE") throw unauthorized();
  const memberships = await repo.activeMemberships(userId);
  const active = memberships.find((m) => m.organizationId === preferredOrgId) ?? memberships[0] ?? null;
  const accessToken = signAccessToken({ sub: user.id, org: active?.organizationId ?? null, role: active?.role ?? null, pa: user.isPlatformAdmin });
  const refreshToken = randomToken(32);
  await repo.storeRefreshToken({
    userId: user.id,
    tokenHash: sha256(refreshToken),
    familyId: familyId ?? randomToken(12),
    expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    ip: meta.ip ?? null,
  });
  return {
    refreshToken,
    session: {
      accessToken,
      expiresIn: ACCESS_TTL_SECONDS,
      user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin },
      organizations: memberships.map((m) => ({ id: m.organization.id, name: m.organization.name, role: m.role, primaryDomain: m.organization.primaryDomain })),
      activeOrganizationId: active?.organizationId ?? null,
    },
  };
}

export async function register(input: { name: string; email: string; password: string; organizationName?: string; domain?: string }, meta: ClientMeta): Promise<AuthOutcome> {
  const email = input.email.trim().toLowerCase();
  if (await repo.findUserByEmail(email)) throw conflict("An account with this email already exists. Sign in instead.");
  const domain = input.domain ? extractDomain(input.domain) : null;
  if (domain && !isValidDomain(domain)) throw badRequest("That doesn't look like a domain. Try something like northwind.io");
  const passwordHash = await hashPassword(input.password);
  const mustVerify = verificationRequired();
  const { userId, challenge } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email, name: input.name.trim(), passwordHash, lastLoginAt: mustVerify ? null : new Date() } });
    const orgName = input.organizationName?.trim() || (domain ? brandFromDomain(domain) : `${input.name.trim()}'s workspace`);
    const org = await repo.createOrganizationWithOwner(tx, user.id, orgName, domain);
    if (domain) {
      await tx.onboarding.create({ data: { organizationId: org.id, domain, brand: brandFromDomain(domain), icp: { industries: [], titles: [], sizes: [], regions: [] } } });
    }
    return { userId: user.id, challenge: mustVerify ? await createChallenge(user.id, "VERIFY", tx) : null };
  });
  if (!challenge) return { kind: "session", ...(await buildSession(userId, null, meta)) };
  await sendChallengeMail(email, challenge);
  return { kind: "verify", userId, verification: { email, ...forScreen(challenge) } };
}

export async function login(emailRaw: string, password: string, meta: ClientMeta): Promise<AuthOutcome> {
  const email = emailRaw.trim().toLowerCase();
  const key = `${meta.ip ?? "?"}:${email}`;
  if ((await failureCount(key)) >= MAX_FAILURES) throw tooManyRequests("Too many attempts, try again in a few minutes");
  const user = await repo.findUserByEmail(email);
  const ok = await bcrypt.compare(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !user.passwordHash || !ok) {
    await noteFailure(key);
    throw unauthorized("Invalid email or password");
  }
  if (user.status !== "ACTIVE") throw forbidden("This account has been disabled");
  await clearFailures(key);
  if (verificationRequired() && !user.emailVerifiedAt) {
    return { kind: "verify", userId: user.id, verification: await startVerification(user.id, user.email) };
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { kind: "session", ...(await buildSession(user.id, null, meta)) };
}

export async function refresh(rawToken: string | undefined, preferredOrgId: string | null, meta: ClientMeta) {
  if (!rawToken) throw unauthorized();
  const stored = await repo.findRefreshToken(sha256(rawToken));
  if (!stored) throw unauthorized();
  if (stored.revokedAt) {
    await repo.revokeFamily(stored.familyId);
    throw unauthorized("Session expired");
  }
  if (stored.expiresAt < new Date()) throw unauthorized("Session expired");
  const revoked = await repo.revokeToken(stored.id);
  if (!revoked.count) {
    await repo.revokeFamily(stored.familyId);
    throw unauthorized("Session expired");
  }
  return buildSession(stored.userId, preferredOrgId, meta, stored.familyId);
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  const stored = await repo.findRefreshToken(sha256(rawToken));
  if (stored) await repo.revokeToken(stored.id);
}

export async function me(userId: string, activeOrgId: string | null) {
  const user = await repo.findUserById(userId);
  if (!user) throw unauthorized();
  const memberships = await repo.activeMemberships(userId);
  return {
    user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin },
    organizations: memberships.map((m) => ({ id: m.organization.id, name: m.organization.name, role: m.role, primaryDomain: m.organization.primaryDomain })),
    activeOrganizationId: memberships.find((m) => m.organizationId === activeOrgId)?.organizationId ?? memberships[0]?.organizationId ?? null,
  };
}

export async function acceptInvite(userId: string, email: string, token: string) {
  const membership = await prisma.membership.findUnique({ where: { inviteTokenHash: sha256(token) } });
  if (!membership || membership.status !== "INVITED") throw notFound("Invitation");
  if (membership.inviteExpiresAt && membership.inviteExpiresAt < new Date()) throw badRequest("This invitation has expired. Ask for a new one.");
  if (membership.invitedEmail && membership.invitedEmail !== email.toLowerCase()) throw forbidden("This invitation was sent to a different email address");
  const existing = await prisma.membership.findFirst({ where: { organizationId: membership.organizationId, userId } });
  if (existing) {
    await prisma.membership.delete({ where: { id: membership.id } });
    return { organizationId: membership.organizationId };
  }
  await prisma.membership.update({ where: { id: membership.id }, data: { userId, status: "ACTIVE", inviteTokenHash: null, inviteExpiresAt: null } });
  return { organizationId: membership.organizationId };
}

export async function oauthSignIn(provider: string, providerAccountId: string, email: string, name: string | null, meta: ClientMeta, opts: { domain?: string | null } = {}) {
  const normalized = email.trim().toLowerCase();
  const linked = await prisma.oAuthAccount.findUnique({ where: { provider_providerAccountId: { provider, providerAccountId } } });
  let userId = linked?.userId;
  if (!userId) {
    const byEmail = await repo.findUserByEmail(normalized);
    if (byEmail) {
      userId = byEmail.id;
    } else {
      userId = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email: normalized, name, emailVerifiedAt: new Date(), lastLoginAt: new Date() } });
        // A new Google account gets the same start as an email sign-up: the website typed on the home page names
        // the workspace and opens its setup. Without one, a company email's domain is used, never gmail.com and the like.
        const typed = opts.domain ? extractDomain(opts.domain) : null;
        const site = typed && isValidDomain(typed) ? typed : null;
        const emailDomain = normalized.split("@")[1] ?? null;
        const domain = site ?? (emailDomain && isValidDomain(emailDomain) && !isFreeMailDomain(emailDomain) ? emailDomain : null);
        const org = await repo.createOrganizationWithOwner(tx, user.id, domain ? brandFromDomain(domain) : name ? `${name}'s workspace` : "My workspace", domain);
        if (site) await tx.onboarding.create({ data: { organizationId: org.id, domain: site, brand: brandFromDomain(site), icp: { industries: [], titles: [], sizes: [], regions: [] } } });
        return user.id;
      });
    }
    await prisma.oAuthAccount.create({ data: { userId, provider, providerAccountId } });
  }
  const user = await repo.findUserById(userId);
  if (!user || user.status !== "ACTIVE") throw forbidden("This account has been disabled");
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  await prisma.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
  return buildSession(userId, null, meta);
}
