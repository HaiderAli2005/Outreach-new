import { prisma, type Db } from "../../lib/prisma.js";
import { randomToken } from "../../lib/crypto.js";

export const userSelect = { id: true, email: true, name: true, status: true, isPlatformAdmin: true, passwordHash: true, emailVerifiedAt: true } as const;

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email }, select: userSelect });
}

export function findUserById(id: string) {
  return prisma.user.findUnique({ where: { id }, select: userSelect });
}

export function activeMemberships(userId: string) {
  return prisma.membership.findMany({
    where: { userId, status: "ACTIVE", organization: { status: "ACTIVE" } },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true, role: true, organization: { select: { id: true, name: true, primaryDomain: true } } },
  });
}

export async function createOrganizationWithOwner(db: Db, userId: string, name: string, domain: string | null) {
  const org = await db.organization.create({ data: { name, primaryDomain: domain, webhookToken: randomToken(24) } });
  await db.membership.create({ data: { organizationId: org.id, userId, role: "OWNER", status: "ACTIVE" } });
  await db.orgSettings.create({ data: { organizationId: org.id, senderCompany: name } });
  return org;
}

export function storeRefreshToken(data: { userId: string; tokenHash: string; familyId: string; expiresAt: Date; userAgent?: string | null; ip?: string | null }) {
  return prisma.refreshToken.create({ data });
}

export function findRefreshToken(tokenHash: string) {
  return prisma.refreshToken.findUnique({ where: { tokenHash } });
}

export function revokeToken(id: string) {
  return prisma.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
}

export function revokeFamily(familyId: string) {
  return prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export function revokeAllForUser(userId: string) {
  return prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
