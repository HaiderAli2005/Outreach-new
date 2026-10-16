import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok, created } from "../../lib/http.js";
import { parseBody, parseParams } from "../../middleware/validate.js";
import { escapeCell, csvLine } from "../../lib/csv.js";
import { prisma } from "../../lib/prisma.js";
import { exportColumns } from "../contacts/contacts.controller.js";
import { listSelect } from "../contacts/contacts.service.js";
import * as service from "./campaigns.service.js";

const idParam = z.object({ id: z.string().min(1) });
const filtersSchema = z.object({
  person_titles: z.array(z.string().max(100)).max(40).optional(),
  person_seniorities: z.array(z.string().max(40)).max(20).optional(),
  organization_num_employees_ranges: z.array(z.string().regex(/^\d+,\d+$/)).max(10).optional(),
  person_locations: z.array(z.string().max(100)).max(20).optional(),
  q_organization_keyword_tags: z.array(z.string().max(100)).max(30).optional(),
  q_keywords: z.string().max(200).optional(),
});
const input = z.object({
  name: z.string().trim().min(1).max(120),
  niche: z.string().trim().max(200).nullish(),
  marketBrief: z.string().trim().max(2000).nullish(),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
  apolloFilters: filtersSchema.optional(),
});

export async function list(req: Request, res: Response) {
  return ok(res, await service.list(ctx(req).orgId));
}

export async function get(req: Request, res: Response) {
  return ok(res, await service.get(ctx(req).orgId, parseParams(req, idParam).id));
}

export async function create(req: Request, res: Response) {
  return created(res, await service.create(ctx(req).orgId, parseBody(req, input)));
}

export async function update(req: Request, res: Response) {
  return ok(res, await service.update(ctx(req).orgId, parseParams(req, idParam).id, parseBody(req, input.partial())));
}

export async function setStatus(req: Request, res: Response) {
  const { status } = parseBody(req, z.object({ status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]) }));
  return ok(res, await service.setStatus(ctx(req).orgId, parseParams(req, idParam).id, status));
}

export async function exportCampaign(req: Request, res: Response) {
  const orgId = ctx(req).orgId;
  const c = await service.dossier(orgId, parseParams(req, idParam).id);
  const f = (c.apolloFilters ?? {}) as Record<string, unknown>;
  const kv = (k: string, v: unknown) => `${escapeCell(k)},${escapeCell(Array.isArray(v) ? v.join(" | ") : v)}`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="campaign-${c.id}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(
    "﻿" +
      [
        "CAMPAIGN",
        kv("Name", c.name),
        kv("Campaign ID", c.id),
        kv("Market / niche", c.niche),
        kv("Status", c.saturatedAt && c.status === "ACTIVE" ? "resting (audience exhausted)" : c.status),
        kv("Language", c.language.toUpperCase()),
        kv("Created", c.createdAt),
        "",
        "ABOUT THE MARKET",
        kv("Brief", c.marketBrief),
        "",
        "TARGETING",
        kv("Titles", f.person_titles ?? []),
        kv("Seniorities", f.person_seniorities ?? []),
        kv("Company sizes", f.organization_num_employees_ranges ?? []),
        kv("Locations", f.person_locations ?? []),
        kv("Industry tags", f.q_organization_keyword_tags ?? []),
        "",
        "PROSPECTS (best fit first)",
        exportColumns.map((col) => escapeCell(col.label)).join(","),
      ].join("\r\n") +
      "\r\n",
  );
  for (let skip = 0; skip < 200_000; skip += 1000) {
    const rows = await prisma.contact.findMany({ where: { organizationId: orgId, campaignId: c.id }, select: listSelect, orderBy: [{ fitScore: "desc" }, { id: "asc" }], skip, take: 1000 });
    if (!rows.length) break;
    res.write(rows.map((r) => csvLine(r, exportColumns)).join("\r\n") + "\r\n");
    if (rows.length < 1000) break;
  }
  res.end();
}
