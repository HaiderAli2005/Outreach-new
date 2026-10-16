import type { Request, Response } from "express";
import { z } from "zod";
import { ctx, ok } from "../../lib/http.js";
import { parseBody, parseParams } from "../../middleware/validate.js";
import * as service from "./batches.service.js";

const idParam = z.object({ id: z.string().min(1) });
const ids = z.array(z.string().min(1).max(40)).max(5000);

export async function list(req: Request, res: Response) {
  return ok(res, await service.list(ctx(req).orgId));
}

export async function pending(req: Request, res: Response) {
  return ok(res, await service.pending(ctx(req).orgId));
}

export async function get(req: Request, res: Response) {
  return ok(res, await service.get(ctx(req).orgId, parseParams(req, idParam).id));
}

export async function approve(req: Request, res: Response) {
  const body = parseBody(req, z.object({ excludeContactIds: ids.default([]) }));
  return ok(res, await service.approve(ctx(req).orgId, parseParams(req, idParam).id, body.excludeContactIds));
}

export async function exclude(req: Request, res: Response) {
  const body = parseBody(req, z.object({ contactIds: ids.min(1) }));
  return ok(res, await service.exclude(ctx(req).orgId, parseParams(req, idParam).id, body.contactIds));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function approveLink(req: Request, res: Response) {
  const r = await service.approveViaLink(String(req.query.batch ?? ""), String(req.query.token ?? ""));
  const color = r.tone === "good" ? "#8CCB9F" : r.tone === "warn" ? "#E3B25C" : "#E5836F";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.status(r.tone === "bad" ? 403 : 200).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.title)}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0F0E0D;color:#F2EEE7;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif">
<main style="max-width:440px;margin:16px;padding:36px 30px;border-radius:28px;text-align:center;background:linear-gradient(180deg,rgba(255,244,228,.075),rgba(255,244,228,.02));box-shadow:inset 0 0 0 1px rgba(255,240,220,.14),0 30px 80px -34px rgba(0,0,0,.8)">
<div style="width:56px;height:56px;margin:0 auto 18px;border-radius:50%;background:${color};opacity:.9"></div>
<h1 style="margin:0 0 10px;font-size:24px;letter-spacing:-.03em">${esc(r.title)}</h1>
<p style="margin:0;color:#B9B1A5">${esc(r.message)}</p>
<p style="margin:22px 0 0;font-size:12px;color:#857D72;font-family:ui-monospace,monospace">Aperture · you can close this tab</p>
</main></body></html>`);
}
