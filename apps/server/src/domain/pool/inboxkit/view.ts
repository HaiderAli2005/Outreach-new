import type { Mailbox, SendingDomain } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { SUPPLIER_WARMED_LADDER_DAY } from "../lifecycle.js";
import { WARMUP_DAYS_TO_ACTIVE } from "../../../config/plans.js";
import { listOrders } from "./orders.js";
import { SUPPLIER } from "./settings.js";

/**
 * The "where is each new domain" board on Admin > Domains: every domain ordered through InboxKit, the stage it is in,
 * how far along, and its warmup health, newest first.
 */

const DAY = 86_400_000;

export type Stage = "setting_up" | "dns" | "warmup_booked" | "warming" | "held" | "ladder" | "live" | "burned";

export const STAGE_LABEL: Record<Stage, string> = {
  setting_up: "InboxKit is setting it up",
  dns: "Waiting for DNS",
  warmup_booked: "Warmup starts when every mailbox is ready",
  warming: "Warming at InboxKit",
  held: "Held back",
  ladder: "Starting to send",
  live: "Sending",
  burned: "Burned, replies only",
};

type Row = SendingDomain & { mailboxes: Mailbox[] };

export function stageOf(d: Row, now = new Date()) {
  const boxes = d.mailboxes.filter((m) => m.status !== "RETIRED");
  const target = d.warmupTargetDays ?? 28;
  const base = { stage: "setting_up" as Stage, day: null as number | null, of: null as number | null, readyOn: null as Date | null, note: null as string | null };
  switch (d.status) {
    case "REGISTERED": {
      if (boxes.every((m) => m.status === "CREATING")) return { ...base, note: d.providerStatus ? `InboxKit: ${d.providerStatus.replace(/_/g, " ")}` : null };
      return { ...base, stage: "dns" as Stage, note: [!d.spfOk && "SPF", !d.dkimOk && "DKIM", !d.dmarcOk && "DMARC"].filter(Boolean).join(", ") ? `Not passing yet: ${[!d.spfOk && "SPF", !d.dkimOk && "DKIM", !d.dmarcOk && "DMARC"].filter(Boolean).join(", ")}` : null };
    }
    case "AGING": {
      if (!d.supplierWarmupAt) return { ...base, stage: "warmup_booked" as Stage, of: target };
      const day = Math.min(target, Math.max(1, Math.floor((now.getTime() - d.supplierWarmupAt.getTime()) / DAY) + 1));
      if (d.agingUntil && d.agingUntil <= now && d.lastError) return { ...base, stage: "held" as Stage, day, of: target, readyOn: null, note: d.lastError };
      return { ...base, stage: "warming" as Stage, day, of: target, readyOn: d.agingUntil };
    }
    case "WARMING": {
      const day = Math.min(...boxes.filter((m) => m.status === "WARMING" || m.status === "ACTIVE").map((m) => m.warmupDay), WARMUP_DAYS_TO_ACTIVE);
      const ladder = WARMUP_DAYS_TO_ACTIVE - SUPPLIER_WARMED_LADDER_DAY;
      const done = Math.max(0, day - SUPPLIER_WARMED_LADDER_DAY);
      const cap = Math.min(...boxes.filter((m) => m.status === "WARMING" || m.status === "ACTIVE").map((m) => m.sendCapToday), 30);
      return { ...base, stage: "ladder" as Stage, day: done + 1, of: ladder, readyOn: d.warmupStartedAt ? new Date(d.warmupStartedAt.getTime() + ladder * DAY) : null, note: `${cap} a day per mailbox` };
    }
    case "ACTIVE":
      return { ...base, stage: "live" as Stage };
    default:
      return { ...base, stage: "burned" as Stage, note: d.degradeReason };
  }
}

export async function pipeline(now = new Date()) {
  const [rows, orders] = await Promise.all([
    prisma.sendingDomain.findMany({ where: { organizationId: null, supplier: SUPPLIER, status: { not: "RETIRED" } }, orderBy: { createdAt: "desc" }, include: { mailboxes: { orderBy: { address: "asc" } } } }),
    listOrders(10),
  ]);
  const domains = rows.map((d) => {
    const st = stageOf(d, now);
    return {
      id: d.id,
      name: d.name,
      ...st,
      label: STAGE_LABEL[st.stage],
      orderedAt: d.createdAt,
      syncedAt: d.supplierSyncedAt,
      mailboxes: d.mailboxes
        .filter((m) => m.status !== "RETIRED")
        .map((m) => ({
          id: m.id,
          address: m.address,
          status: m.status,
          supplierStatus: m.providerStatus,
          warmup: m.supplierWarmupStatus,
          health: m.warmupHealth,
          score: m.warmupScore === null ? null : Number(m.warmupScore),
          inboxRate: m.warmupInboxRate === null ? null : Number(m.warmupInboxRate),
          supplierDay: m.supplierWarmupDay,
          capToday: m.sendCapToday,
          error: m.lastError,
        })),
    };
  });
  const counts = Object.fromEntries((Object.keys(STAGE_LABEL) as Stage[]).map((k) => [k, domains.filter((d) => d.stage === k).length])) as Record<Stage, number>;
  return { counts, domains, orders };
}
