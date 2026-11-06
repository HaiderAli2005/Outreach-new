import type { PoolSettings } from "@prisma/client";
import { isUniqueViolation, prisma } from "../../lib/prisma.js";

const TTL_MS = 60_000;
let cached: { at: number; row: PoolSettings } | null = null;

/** The single PoolSettings row, created on first read, cached for a minute. */
export async function poolSettings(): Promise<PoolSettings> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.row;
  // Two first reads at once both try to create the row; the loser reads the winner's.
  const row = await prisma.poolSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} }).catch((e) => {
    if (isUniqueViolation(e)) return prisma.poolSettings.findUniqueOrThrow({ where: { id: "default" } });
    throw e;
  });
  cached = { at: Date.now(), row };
  return row;
}

export type PoolSettingsPatch = Partial<Pick<PoolSettings, "spareDomainsMin" | "maxBuyPerBatch" | "maxBuyPerDay" | "autoBuyEnabled">> & { spareMultiplier?: number };

export async function updatePoolSettings(patch: PoolSettingsPatch): Promise<PoolSettings> {
  const { spareMultiplier, ...rest } = patch;
  const data = { ...rest, ...(spareMultiplier !== undefined ? { spareMultiplier: spareMultiplier.toFixed(2) } : {}) };
  const row = await prisma.poolSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  cached = { at: Date.now(), row };
  return row;
}

export function clearPoolSettingsCache(): void {
  cached = null;
}
