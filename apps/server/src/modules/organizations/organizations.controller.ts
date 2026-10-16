import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok, created, currentUser } from "../../lib/http.js";
import { parseBody, parseParams } from "../../middleware/validate.js";
import * as service from "./organizations.service.js";

const idParam = z.object({ id: z.string().min(1) });
const role = z.enum(["OWNER", "ADMIN", "MEMBER"]);

export async function current(req: Request, res: Response) {
  const { orgId, role } = ctx(req);
  const org = await service.getOrganization(orgId);
  return ok(res, role === "MEMBER" ? { ...org, webhookToken: undefined } : org);
}

export async function update(req: Request, res: Response) {
  const body = parseBody(req, z.object({ name: z.string().trim().min(1).max(120) }));
  return ok(res, await service.updateOrganization(ctx(req).orgId, body));
}

export async function members(req: Request, res: Response) {
  return ok(res, await service.listMembers(ctx(req).orgId));
}

export async function invite(req: Request, res: Response) {
  const body = parseBody(req, z.object({ email: z.email(), role: role.default("MEMBER") }));
  return created(res, await service.inviteMember(ctx(req), body.email, body.role));
}

export async function changeRole(req: Request, res: Response) {
  const { id } = parseParams(req, idParam);
  const body = parseBody(req, z.object({ role }));
  return ok(res, await service.changeRole(ctx(req), id, body.role));
}

export async function remove(req: Request, res: Response) {
  const { id } = parseParams(req, idParam);
  return ok(res, await service.removeMember(ctx(req), id));
}

export async function create(req: Request, res: Response) {
  const body = parseBody(req, z.object({ name: z.string().trim().max(120).optional(), domain: z.string().trim().max(253).optional() }));
  return created(res, await service.createOrganization(currentUser(req).id, body));
}

export async function destroy(req: Request, res: Response) {
  const { confirm } = parseBody(req, z.object({ confirm: z.string().max(253) }));
  return ok(res, await service.deleteWorkspace(ctx(req), currentUser(req).id, confirm));
}
