import { pushQueue } from "../../jobs/send.js";
import { costPrices, updateCostPrices } from "../../domain/costPrices.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { currentUser, ok } from "../../lib/http.js";
import { notFound } from "../../lib/errors.js";
import { parseBody } from "../../middleware/validate.js";
import { cachedConsole, invalidateConsole } from "../../domain/pool/metrics.js";
import { assignUnmatched, unmatchedCandidates } from "../../domain/sending/inbound.js";
import { decideReorder } from "../../domain/pool/restock.js";
import { unpause } from "../../domain/sending/health.js";
import { logSystem } from "../../domain/systemLog.js";
import { poolSettings, updatePoolSettings } from "../../domain/pool/settings.js";
import { activateNow } from "../../domain/pool/override.js";

/** The ops console: pool health, burn, shelf runway, capacity, cost and margin, at-risk domains, restock requests. */
export async function pool(req: Request, res: Response) {
  return ok(res, await cachedConsole({ fresh: req.query.fresh === "1" }));
}

/** An operator takes a restock reminder on (they will add the domains) or dismisses it. */
export async function decide(req: Request, res: Response) {
  const body = parseBody(req, z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }));
  const out = await decideReorder(String(req.params.id), currentUser(req).id, body.approve, body.note);
  await invalidateConsole();
  return ok(res, out);
}

/** Operator override for a customer paused for bounces. The reason is required and logged with who did it. */
export async function unpauseCustomer(req: Request, res: Response) {
  const body = parseBody(req, z.object({ reason: z.string().trim().min(5, "Say why").max(300) }));
  const orgId = String(req.params.id);
  if (!(await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } }))) throw notFound("Organization");
  return ok(res, await unpause(orgId, { userId: currentUser(req).id, reason: body.reason, operator: true }));
}

const tokenPrice = z.object({ input: z.number().min(0).max(1000), cachedInput: z.number().min(0).max(1000), output: z.number().min(0).max(1000) });
const costPatch = z
  .object({
    aiPrices: z.record(z.string().trim().min(1).max(60), tokenPrice).refine((r) => !!r.default, "Keep a default AI price"),
    apolloPerEnrichUsd: z.number().min(0).max(10),
    apolloPerSearchUsd: z.number().min(0).max(10),
    verifyPerEmailUsd: z.number().min(0).max(1),
    paymentFeePercent: z.number().min(0).max(20),
    paymentFeeFixedUsd: z.number().min(0).max(5),
    mailboxMonthUsd: z.number().min(0).max(100),
    repliesOnlyMailboxMonthUsd: z.number().min(0).max(100),
    domainYearUsd: z.number().min(0).max(500),
  })
  .partial()
  .strict();

/** Supplier unit prices behind the cost card. */
export async function getCosts(_req: Request, res: Response) {
  return ok(res, await costPrices());
}

export async function patchCosts(req: Request, res: Response) {
  const body = parseBody(req, costPatch);
  const out = await updateCostPrices(body, currentUser(req).id);
  await invalidateConsole();
  return ok(res, out);
}

/**
 * Support and testing only: starts whoever is ready now, ignoring each prospect's sending window. Never offered to
 * customers: a send outside the window makes a shared domain look like a bulk sender for everyone on it.
 */
export async function sendNow(req: Request, res: Response) {
  const orgId = String(req.params.id);
  if (!(await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } }))) throw notFound("Organization");
  const user = currentUser(req);
  const r = await pushQueue(orgId, { ignoreWindow: true });
  await logSystem(orgId, "INFO", "admin", `Send now by ${user.email}: ${r.pushed} sent${r.reason ? ` (${r.reason.replace(/[-_]/g, " ")})` : ""}.`, { userId: user.id, pushed: r.pushed, reason: r.reason ?? null });
  return ok(res, r);
}

/** An operator clears a domain paused for an authentication failure, once its records are fixed. */
export async function resumeDomain(req: Request, res: Response) {
  const body = parseBody(req, z.object({ reason: z.string().trim().min(5, "Say what was fixed").max(300) }));
  const d = await prisma.sendingDomain.findUnique({ where: { id: String(req.params.id) } });
  if (!d || d.organizationId) throw notFound("Pool domain");
  await prisma.sendingDomain.update({ where: { id: d.id }, data: { pausedAt: null, pauseReason: null } });
  await logSystem(null, "INFO", "pool", `${d.name} resumed by an operator: ${body.reason}.`, { domainId: d.id, operatorId: currentUser(req).id });
  await invalidateConsole();
  return ok(res, { resumed: true });
}

/** Messages read from the pool's mailboxes that matched no thread, oldest first, for an operator to look at. */
export async function unmatched(_req: Request, res: Response) {
  const rows = await prisma.inboundMessage.findMany({
    where: { kind: "unmatched", handledAt: null },
    orderBy: { receivedAt: "asc" },
    take: 100,
    select: { id: true, fromEmail: true, subject: true, bodyText: true, receivedAt: true, rawHeaders: true, mailbox: { select: { address: true } } },
  });
  return ok(res, rows.map((r) => ({ ...r, bodyText: r.bodyText?.slice(0, 2000) ?? null, rawHeaders: r.rawHeaders?.slice(0, 3000) ?? null })));
}

export async function unmatchedCandidatesFor(req: Request, res: Response) {
  return ok(res, await unmatchedCandidates(String(req.params.id)));
}

/** Attach an unmatched message to a conversation: it then counts as their reply (sequence stops, classified). */
export async function assign(req: Request, res: Response) {
  const body = parseBody(req, z.object({ contactId: z.string().min(5).max(40) }));
  const r = await assignUnmatched(String(req.params.id), body.contactId, currentUser(req).id);
  if (!r) throw notFound("Unmatched message or conversation");
  await invalidateConsole();
  return ok(res, r);
}

export async function handleUnmatched(req: Request, res: Response) {
  await prisma.inboundMessage.updateMany({ where: { id: String(req.params.id), kind: "unmatched" }, data: { handledAt: new Date() } });
  await invalidateConsole();
  return ok(res, { handled: true });
}

/** Customers' corrections of reply intents, newest first: the classifier's training data, reviewed weekly. */
export async function intentCorrections(req: Request, res: Response) {
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 7) || 7));
  const rows = await prisma.contact.findMany({
    where: { customerIntent: { not: null }, intentCorrectedAt: { gte: new Date(Date.now() - days * 86_400_000) } },
    orderBy: { intentCorrectedAt: "desc" },
    take: 200,
    select: { id: true, intent: true, customerIntent: true, intentConfidence: true, intentCorrectedAt: true, replyClass: true, organization: { select: { id: true, name: true } } },
  });
  const pairs = new Map<string, number>();
  for (const r of rows) pairs.set(`${r.intent} -> ${r.customerIntent}`, (pairs.get(`${r.intent} -> ${r.customerIntent}`) ?? 0) + 1);
  const latest = await Promise.all(
    rows.slice(0, 50).map(async (r) => {
      const m = await prisma.message.findFirst({ where: { contactId: r.id, direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { body: true } });
      return { ...r, intentConfidence: r.intentConfidence === null ? null : Number(r.intentConfidence), reply: (m?.body ?? "").slice(0, 400) };
    }),
  );
  return ok(res, { days, total: rows.length, confusions: [...pairs.entries()].map(([pair, count]) => ({ pair, count })).sort((a, b) => b.count - a.count), rows: latest });
}

/** Marks a workspace as our own internal outreach (unbilled, served after customers) or as a customer. */
export async function setKind(req: Request, res: Response) {
  const body = parseBody(req, z.object({ kind: z.enum(["CUSTOMER", "INTERNAL"]) }));
  const org = await prisma.organization.update({ where: { id: String(req.params.id) }, data: { kind: body.kind }, select: { id: true, kind: true } });
  return ok(res, org);
}

const settingsView = (s: Awaited<ReturnType<typeof poolSettings>>) => ({ ...s, spareMultiplier: Number(s.spareMultiplier) });

export async function getPoolSettings(_req: Request, res: Response) {
  return ok(res, settingsView(await poolSettings()));
}

export async function patchPoolSettings(req: Request, res: Response) {
  const body = parseBody(
    req,
    z
      .object({
        spareDomainsMin: z.number().int().min(0).max(500),
        spareMultiplier: z.number().min(0.5).max(5),
        maxBuyPerBatch: z.number().int().min(1).max(50),
        maxBuyPerDay: z.number().int().min(1).max(200),
        autoBuyEnabled: z.boolean(),
      })
      .partial(),
  );
  const s = await updatePoolSettings(body);
  await logSystem(null, "INFO", "pool", `Pool restock targets changed by an operator: ${Object.entries(body).map(([k, v]) => `${k} ${v}`).join(", ")}.`, { operatorId: currentUser(req).id });
  await invalidateConsole();
  return ok(res, settingsView(s));
}

/** An operator promotes a warming domain to full capacity early. The reason is required and logged as CRITICAL. */
export async function activateNowHandler(req: Request, res: Response) {
  const body = parseBody(req, z.object({ reason: z.string().trim().min(10, "Say why, in at least 10 characters").max(300) }));
  const user = currentUser(req);
  const out = await activateNow(String(req.params.id), { id: user.id, email: user.email }, body.reason);
  await invalidateConsole();
  return ok(res, out);
}
