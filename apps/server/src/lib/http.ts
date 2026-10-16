import type { Request, Response } from "express";
import { z } from "zod";
import { unauthorized } from "./errors.js";
import type { MemberRole } from "@prisma/client";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  isPlatformAdmin: boolean;
  emailVerified: boolean;
}

export interface OrgContext {
  userId: string;
  orgId: string;
  role: MemberRole;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
    ctx?: OrgContext;
    rawBody?: Buffer;
    requestId?: string;
  }
}

export interface Meta {
  page?: number;
  limit?: number;
  total?: number;
  [key: string]: unknown;
}

export function ok<T>(res: Response, data: T, meta?: Meta, status = 200): Response {
  return res.status(status).json(meta ? { data, meta } : { data });
}

export function created<T>(res: Response, data: T): Response {
  return ok(res, data, undefined, 201);
}

export function ctx(req: Request): OrgContext {
  if (!req.ctx) throw unauthorized();
  return req.ctx;
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export const paginationSchema = (maxLimit = 100, defaultLimit = 50) =>
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  });

export function skipTake(p: { page: number; limit: number }) {
  return { skip: (p.page - 1) * p.limit, take: p.limit };
}

export const boolish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");
