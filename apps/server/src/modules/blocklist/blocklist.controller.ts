import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok, created, paginationSchema, boolish } from "../../lib/http.js";
import { parseBody, parseParams, parseQuery } from "../../middleware/validate.js";
import { streamCsv } from "../../lib/csv.js";
import { prisma } from "../../lib/prisma.js";
import * as service from "./blocklist.service.js";

const reasons = ["ALREADY_CONTACTED", "NO_RESPONSE", "UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "MANUAL", "COMPETITOR", "CUSTOMER", "DEAL_CLOSED", "REMOVED"] as const;

export async function list(req: Request, res: Response) {
  const q = parseQuery(req, paginationSchema(500, 50).extend({ entryType: z.enum(["EMAIL", "DOMAIN"]).optional(), reason: z.enum(reasons).optional(), origin: z.enum(["you", "automatic"]).optional(), search: z.string().trim().max(120).optional() }));
  const r = await service.list(ctx(req).orgId, q);
  return ok(res, r.rows, { page: q.page, limit: q.limit, total: r.total, byReason: r.byReason, byOrigin: r.byOrigin });
}

export async function add(req: Request, res: Response) {
  const body = parseBody(
    req,
    z.object({
      value: z.string().trim().min(3).max(320),
      entryType: z.enum(["EMAIL", "DOMAIN"]).default("EMAIL"),
      reason: z.enum(["MANUAL", "COMPETITOR", "CUSTOMER"]).default("MANUAL"),
      note: z.string().trim().max(500).optional(),
    }),
  );
  return created(res, await service.add(ctx(req).orgId, body));
}

export async function remove(req: Request, res: Response) {
  return ok(res, await service.remove(ctx(req).orgId, parseParams(req, z.object({ id: z.string().min(1) })).id));
}

export async function restore(req: Request, res: Response) {
  const { contactId } = parseBody(req, z.object({ contactId: z.string().min(1) }));
  return ok(res, await service.restore(ctx(req).orgId, contactId));
}

export async function importList(req: Request, res: Response) {
  const body = parseBody(req, z.object({ text: z.string().min(1).max(4_500_000), blockWholeCompany: boolish.default(true) }));
  return ok(res, await service.importList(ctx(req).orgId, body.text, body.blockWholeCompany));
}

interface ExportRow {
  entryType: string;
  value: string;
  reason: string;
  note: string | null;
  createdAt: Date;
  contact?: { fullName: string | null; company: string | null; title: string | null; status: string };
}

export async function exportCsv(req: Request, res: Response) {
  const orgId = ctx(req).orgId;
  await streamCsv<ExportRow>(
    res,
    `blocklist-${new Date().toISOString().slice(0, 10)}.csv`,
    [
      { key: "entryType", label: "Type" },
      { key: "value", label: "Email / Domain" },
      { key: "reason", label: "Reason" },
      { key: "note", label: "Note" },
      { key: "fullName", label: "Name", value: (r) => r.contact?.fullName },
      { key: "company", label: "Company", value: (r) => r.contact?.company },
      { key: "title", label: "Title", value: (r) => r.contact?.title },
      { key: "status", label: "Lead status", value: (r) => r.contact?.status },
      { key: "createdAt", label: "Added" },
    ],
    async (skip, take): Promise<ExportRow[]> => {
      const rows = await prisma.blocklistEntry.findMany({ where: { organizationId: orgId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take });
      const emails = rows.filter((r) => r.entryType === "EMAIL").map((r) => r.value);
      const contacts = emails.length
        ? await prisma.contact.findMany({ where: { organizationId: orgId, emailNormalized: { in: emails } }, select: { emailNormalized: true, fullName: true, company: true, title: true, status: true } })
        : [];
      const byEmail = new Map(contacts.map((c) => [c.emailNormalized, c]));
      return rows.map((r) => ({ ...r, contact: r.entryType === "EMAIL" ? byEmail.get(r.value) : undefined }));
    },
  );
}
