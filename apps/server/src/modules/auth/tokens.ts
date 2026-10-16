import jwt from "jsonwebtoken";
import type { MemberRole } from "@prisma/client";
import { env } from "../../config/env.js";

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;
export const REFRESH_COOKIE = "ap_refresh";
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

export interface AccessClaims {
  sub: string;
  org: string | null;
  role: MemberRole | null;
  pa: boolean;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TTL_SECONDS, algorithm: "HS256", issuer: "aperture" });
}

export function verifyAccessToken(token: string): AccessClaims {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"], issuer: "aperture" });
  if (typeof decoded === "string" || !decoded.sub) throw new Error("malformed token");
  return { sub: String(decoded.sub), org: (decoded.org as string) ?? null, role: (decoded.role as MemberRole) ?? null, pa: Boolean(decoded.pa) };
}
