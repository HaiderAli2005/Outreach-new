import { prisma } from "../../lib/prisma.js";
import { conflict, notFound } from "../../lib/errors.js";
import { SENDS_PER_WARM_INBOX, WARMUP_DAYS_TO_ACTIVE } from "../../config/plans.js";
import { logSystem } from "../systemLog.js";
import { agingUntilFrom } from "./lifecycle.js";
import { planBatch } from "./names.js";

/**
 * Restocking the shared shelf. Domains and mailboxes are bought by an operator, outside Aperture, and added on the
 * admin Domains page. The daily reorder check only raises a reminder with how many to add and some neutral names to
 * buy; nothing here spends money.
 *
 * Never a large batch: fifty domains bought the same day at one registrar, all starting to send together, is exactly
 * what snowshoe-spam detection looks for. Add 3 to 5 at a time, spread over TLDs and registrars.
 */

/** Neutral names to buy for a reminder, varied over TLDs and never one we already have. */
export async function suggestedNames(count: number, seed: number): Promise<string[]> {
  const owned = (await prisma.sendingDomain.findMany({ select: { name: true } })).map((d) => d.name);
  return planBatch(Math.max(3, Math.min(count, 10)), seed, owned).map((p) => p.domain);
}

/** The operator either takes the reminder on (they will add the domains) or dismisses it. */
export async function decideReorder(id: string, operatorId: string, approve: boolean, note?: string) {
  const r = await prisma.poolReorder.findUnique({ where: { id } });
  if (!r) throw notFound("Restock request");
  if (r.status !== "PENDING") throw conflict(`This request is already ${r.status.toLowerCase()}`);
  await prisma.poolReorder.update({ where: { id }, data: { status: approve ? "APPROVED" : "DISMISSED", decidedById: operatorId, decidedAt: new Date(), note: note ?? null } });
  await logSystem(
    null,
    "INFO",
    "pool",
    approve ? `Restock taken on: add ${r.domainsToBuy} domain${r.domainsToBuy === 1 ? "" : "s"} on the Domains page.` : `Restock request dismissed${note ? `: ${note}` : ""}.`,
    { reorderId: id, operatorId },
  );
  return { approved: approve, suggestions: approve ? await suggestedNames(r.domainsToBuy, r.createdAt.getTime()) : [] };
}

/** Closes a taken-on reminder once enough domains have been added since it was taken on. */
export async function closeFilledReorders(): Promise<number> {
  const open = await prisma.poolReorder.findMany({ where: { status: "APPROVED" } });
  let closed = 0;
  for (const r of open) {
    const added = await prisma.sendingDomain.count({ where: { organizationId: null, createdAt: { gte: r.decidedAt ?? r.createdAt } } });
    if (added >= r.domainsToBuy) {
      await prisma.poolReorder.update({ where: { id: r.id }, data: { status: "DONE" } });
      closed++;
    }
  }
  return closed;
}

/** A new pool domain, once its DNS is in place, starts its quiet aging period (never earlier than planned). */
export async function startAging(domainId: string, now = new Date()) {
  const d = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: domainId }, select: { agingUntil: true } });
  const earliest = agingUntilFrom(now);
  return prisma.sendingDomain.update({ where: { id: domainId }, data: { status: "AGING", agingUntil: d.agingUntil && d.agingUntil > earliest ? d.agingUntil : earliest } });
}

/**
 * A domain that arrived already warmed skips the quiet aging period and the ladder: once its DNS passes it is ACTIVE and its
 * signed-in mailboxes send at full capacity straight away.
 */
export async function activateWarmed(domainId: string, now = new Date(), opts: { includeWarming?: boolean } = {}): Promise<number> {
  await prisma.sendingDomain.updateMany({ where: { id: domainId, status: { in: ["REGISTERED", "AGING", "WARMING"] } }, data: { status: "ACTIVE", activatedAt: now, warmupStartedAt: now } });
  const r = await prisma.mailbox.updateMany({
    where: { sendingDomainId: domainId, status: opts.includeWarming ? { in: ["CONNECTING", "WARMING"] } : "CONNECTING", credentialRef: { not: null }, lastError: null },
    data: { status: "ACTIVE", warmupDay: WARMUP_DAYS_TO_ACTIVE, sendCapToday: SENDS_PER_WARM_INBOX, dailyLimit: SENDS_PER_WARM_INBOX, warmupStartedAt: now, activatedAt: now },
  });
  return r.count;
}

/**
 * SPF, DKIM and DMARC now resolve for a REGISTERED domain: a warmed one goes live, a new one starts its quiet aging
 * period, and one the supplier warms waits in AGING until that warmup is done (agingUntil is set from when the
 * supplier's warmup actually started, by inboxkit/sync.ts).
 */
export async function onDnsReady(domainId: string, now = new Date()): Promise<"active" | "aging"> {
  const d = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: domainId }, select: { prewarmed: true, externalWarmup: true, supplierWarmupAt: true, warmupTargetDays: true } });
  if (d.prewarmed) {
    await activateWarmed(domainId, now);
    return "active";
  }
  if (d.externalWarmup) {
    const until = d.supplierWarmupAt ? new Date(d.supplierWarmupAt.getTime() + (d.warmupTargetDays ?? 28) * 86_400_000) : null;
    await prisma.sendingDomain.update({ where: { id: domainId }, data: { status: "AGING", agingUntil: until } });
    return "aging";
  }
  await startAging(domainId, now);
  return "aging";
}
