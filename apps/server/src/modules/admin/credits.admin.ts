import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { currentUser, ok } from "../../lib/http.js";
import { badRequest, notFound, unprocessable } from "../../lib/errors.js";
import { parseBody } from "../../middleware/validate.js";
import { activity, balanceView, credit, debitCorrection } from "../../domain/credits/index.js";
import { parseDeciCents } from "../../domain/money.js";

/** A workspace's balance and recent movements, as the customer sees them. */
export async function orgCredits(req: Request, res: Response) {
  const org = await prisma.organization.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!org) throw notFound("Organization");
  return ok(res, { ...(await balanceView(org.id)), activity: await activity(org.id) });
}

/**
 * Give or take money by hand (a goodwill gift, a correction), in deci-cents ("1000" is $1). Every adjustment is a
 * ledger row naming the admin and the reason. A correction can never take the balance below zero.
 */
export async function adjustCredits(req: Request, res: Response) {
  const body = parseBody(req, z.object({ amount: z.string().trim().regex(/^-?\d{1,9}$/, "Amount is a whole number of deci-cents"), reason: z.string().trim().min(3).max(200) }));
  const orgId = String(req.params.id);
  if (!(await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } }))) throw notFound("Organization");
  const amount = parseDeciCents(body.amount) ?? 0n;
  if (amount === 0n) throw badRequest("Amount can't be zero");
  const note = `admin ${currentUser(req).id}: ${body.reason}`;
  const r = amount > 0n ? await credit(orgId, "BONUS", amount, { ref: `admin:${randomUUID()}`, note }) : await debitCorrection(orgId, -amount, note);
  if (!r.ok) throw unprocessable(r.reason);
  return ok(res, await balanceView(orgId));
}

/** Bill one workspace to another organization's pool (an agency paying for its clients), or end that. */
export async function setBillingOwner(req: Request, res: Response) {
  const body = parseBody(req, z.object({ ownerId: z.string().min(1).max(40).nullable() }));
  const orgId = String(req.params.id);
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, billedWorkspaces: { select: { id: true }, take: 1 } } });
  if (!org) throw notFound("Organization");
  if (body.ownerId) {
    if (body.ownerId === orgId) throw badRequest("An organization already pays for itself");
    const owner = await prisma.organization.findUnique({ where: { id: body.ownerId }, select: { id: true, billingOrganizationId: true } });
    if (!owner) throw notFound("Billing organization");
    // One level only: an owner can't itself be billed elsewhere, and a workspace that pays for others can't be billed.
    if (owner.billingOrganizationId) throw unprocessable("That organization is itself billed to another one");
    if (org.billedWorkspaces.length) throw unprocessable("This organization pays for other workspaces, so it can't be billed to another one");
  }
  await prisma.organization.update({ where: { id: orgId }, data: { billingOrganizationId: body.ownerId } });
  return ok(res, await balanceView(orgId));
}
