import { prisma } from "../../lib/prisma.js";
import { notFound, unprocessable } from "../../lib/errors.js";
import { logSystem } from "../systemLog.js";
import { activateWarmed } from "./restock.js";
import { checkPoolDomain } from "./auth.js";
import { ACTIVATE_MAX_RATE } from "./lifecycle.js";
import { sevenDayRates } from "./metrics.js";

const DAY = 86_400_000;
const DKIM_FRESH_MS = 3 * DAY;

/**
 * An operator promotes an AGING or WARMING pool domain to ACTIVE before its warmup is done. Three checks are never
 * overridable: SPF, DKIM and DMARC resolve now, our own DKIM signature verified in the last 3 days, and a 7-day
 * bounce rate under 2%. A domain whose signature does not verify must never carry full volume.
 */
export async function activateNow(domainId: string, operator: { id: string; email: string }, reason: string, now = new Date()) {
  const d = await prisma.sendingDomain.findUnique({ where: { id: domainId }, include: { mailboxes: { select: { status: true, warmupDay: true } } } });
  if (!d || d.organizationId) throw notFound("Pool domain");
  if (d.status !== "AGING" && d.status !== "WARMING") throw unprocessable(`${d.name} is ${d.status.toLowerCase()}. Only a domain that is aging or warming up can be promoted early.`);

  const dns = await checkPoolDomain(d, now);
  const missing = [!dns.spf && "SPF", !dns.dkim && "DKIM", !dns.dmarc && "DMARC"].filter(Boolean);
  if (missing.length) throw unprocessable(`${d.name} can't be promoted: ${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not resolve in DNS.`);
  if (!d.dkimVerifiedAt || now.getTime() - d.dkimVerifiedAt.getTime() > DKIM_FRESH_MS)
    throw unprocessable(`${d.name} can't be promoted: its own DKIM signature has not passed the seed test in the last 3 days${d.dkimVerifiedAt ? ` (last pass ${d.dkimVerifiedAt.toISOString().slice(0, 10)})` : ""}.`);
  const rate = (await sevenDayRates([d.id], now)).get(d.id)?.rate ?? 0;
  if (rate >= ACTIVATE_MAX_RATE) throw unprocessable(`${d.name} can't be promoted: its 7-day bounce rate is ${(rate * 100).toFixed(1)}%, at or above 2%.`);
  if (!d.mailboxes.some((m) => ["CONNECTING", "WARMING", "ACTIVE"].includes(m.status))) throw unprocessable(`${d.name} has no signed-in mailbox to send from.`);

  const inService = d.mailboxes.filter((m) => m.status === "WARMING" || m.status === "ACTIVE");
  const fromDay = d.status === "WARMING" && inService.length ? Math.min(...inService.map((m) => m.warmupDay)) : 0;
  await activateWarmed(d.id, now, { includeWarming: true });
  await prisma.sendingDomain.update({ where: { id: d.id }, data: { forcedActiveAt: now, forcedActiveById: operator.id, forcedActiveReason: reason, forcedFromDay: fromDay } });
  await logSystem(
    null,
    "CRITICAL",
    "pool",
    `${operator.email} promoted ${d.name} to active early, from ${d.status === "AGING" ? "its quiet month" : `warmup day ${fromDay}`}: ${reason}`,
    { domainId: d.id, operatorId: operator.id, fromDay, bounce7: Number(rate.toFixed(4)) },
  );
  return { domain: d.name, fromDay, bounce7: Number(rate.toFixed(4)) };
}
