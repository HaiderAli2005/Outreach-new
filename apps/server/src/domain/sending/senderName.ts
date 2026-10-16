import { prisma } from "../../lib/prisma.js";
import { getSettings } from "../settings.js";
import { PERSONA_SEED } from "../pool/personaSeed.js";
import { fromNameFor } from "./delivery.js";
import { firstNameOf } from "./message.js";

/**
 * Drafted emails keep {{sender_first_name}} until send time, when the mailbox is chosen. Anything shown to the
 * customer fills it first: the pinned mailbox's name, else an active mailbox's name, else the workspace's persona.
 */
const TOKEN = /\{\{\s*sender_first_name\s*\}\}/g;

export function fillSender<T extends string | null | undefined>(text: T, name: string): T {
  return (typeof text === "string" ? text.replace(TOKEN, name) : text) as T;
}

const select = { fromNameDefault: true, firstName: true, address: true } as const;

/** Resolves the sender's first name for each pinned mailbox id (or null for a person not pinned yet). */
export async function senderNames(orgId: string, mailboxIds: (string | null)[]): Promise<(mailboxId: string | null) => string> {
  const ids = [...new Set(mailboxIds.filter((x): x is string => !!x))];
  const [pinned, fallback] = await Promise.all([
    ids.length ? prisma.mailbox.findMany({ where: { id: { in: ids } }, select: { id: true, ...select } }) : Promise.resolve([]),
    prisma.mailbox.findFirst({ where: { status: "ACTIVE", OR: [{ organizationId: orgId }, { organizationId: null }] }, orderBy: [{ organizationId: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }], select }),
  ]);
  const byId = new Map(pinned.map((m) => [m.id, firstNameOf(fromNameFor(m))]));
  const settings = fallback ? null : await getSettings(orgId);
  const otherwise = fallback ? firstNameOf(fromNameFor(fallback)) : (PERSONA_SEED[settings?.language ?? "en"] ?? PERSONA_SEED.en).names[0][0];
  return (id) => (id && byId.get(id)) || otherwise;
}
