import { prisma } from "../lib/prisma.js";

/**
 * The status vocabulary each workspace's inbox uses. It starts as the eight reply intents; the customer may rename,
 * recolour and reorder them (the keys stay, so classification keeps working).
 */
export const DEFAULT_VOCAB: { key: string; label: string; color: string }[] = [
  { key: "INTERESTED", label: "Interested", color: "g" },
  { key: "INFO_REQUEST", label: "Has a question", color: "b" },
  { key: "REFERRAL", label: "Referred us on", color: "v" },
  { key: "NOT_NOW", label: "Not now", color: "y" },
  { key: "NOT_INTERESTED", label: "Not interested", color: "n" },
  { key: "UNSUBSCRIBE", label: "Unsubscribed", color: "r" },
  { key: "HOSTILE", label: "Hostile", color: "r" },
  { key: "UNCLEAR", label: "Unclear", color: "n" },
];

export async function vocabFor(orgId: string) {
  const rows = await prisma.leadStatusVocab.findMany({ where: { organizationId: orgId }, orderBy: { sortOrder: "asc" } });
  if (rows.length) return rows.map((r) => ({ key: r.key, label: r.label, color: r.color, sortOrder: r.sortOrder }));
  return DEFAULT_VOCAB.map((v, i) => ({ ...v, sortOrder: i }));
}

/** Saves the whole list. Keys outside the defaults are the customer's own manual statuses (e.g. MEETING_BOOKED). */
export async function saveVocab(orgId: string, items: { key: string; label: string; color?: string | null }[]) {
  await prisma.$transaction([
    prisma.leadStatusVocab.deleteMany({ where: { organizationId: orgId } }),
    prisma.leadStatusVocab.createMany({ data: items.map((v, i) => ({ organizationId: orgId, key: v.key, label: v.label, color: v.color ?? null, sortOrder: i })) }),
  ]);
  return vocabFor(orgId);
}
