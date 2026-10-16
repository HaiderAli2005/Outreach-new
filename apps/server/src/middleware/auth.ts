import type { RequestHandler } from "express";
import type { MemberRole } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { forbidden, unauthorized, notFound } from "../lib/errors.js";
import { verifyAccessToken } from "../modules/auth/tokens.js";
import { mailEnabled } from "../integrations/mailer.js";
import { isProd } from "../config/env.js";
import { AppError } from "../lib/errors.js";

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return next(unauthorized());
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    return next(unauthorized("Session expired"));
  }
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, email: true, name: true, status: true, isPlatformAdmin: true, emailVerifiedAt: true },
  });
  if (!user || user.status !== "ACTIVE") return next(unauthorized());
  req.user = { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin, emailVerified: !!user.emailVerifiedAt };
  (req as { tokenOrg?: string | null }).tokenOrg = claims.org;
  next();
};

export const requireOrg: RequestHandler = async (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  const requested = req.get("x-organization-id") || (req as { tokenOrg?: string | null }).tokenOrg;
  const membership = await prisma.membership.findFirst({
    where: {
      userId: req.user.id,
      status: "ACTIVE",
      ...(requested ? { organizationId: requested } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true, role: true, organization: { select: { status: true } } },
  });
  if (!membership) return next(requested ? notFound("Organization") : forbidden("You are not a member of any organization"));
  if (membership.organization.status !== "ACTIVE") return next(forbidden("This organization is suspended"));
  req.ctx = { userId: req.user.id, orgId: membership.organizationId, role: membership.role };
  next();
};

export function requireRole(...roles: MemberRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.ctx) return next(unauthorized());
    if (!roles.includes(req.ctx.role)) return next(forbidden());
    next();
  };
}

export const requireManager = requireRole("OWNER", "ADMIN");

/**
 * Work that costs money per call (the AI analysis, the sample emails, lead database counts) only runs for people
 * who have confirmed their email. Without email sending set up nobody can confirm, so outside production that
 * check is skipped; in production it always applies.
 */
export const requireVerifiedEmail: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.emailVerified || req.user.isPlatformAdmin) return next();
  if (!mailEnabled() && !isProd) return next();
  next(new AppError(403, "EMAIL_NOT_VERIFIED", "Confirm your email address first. We sent you a link when you signed up."));
};

export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!req.user.isPlatformAdmin) return next(forbidden());
  next();
};
