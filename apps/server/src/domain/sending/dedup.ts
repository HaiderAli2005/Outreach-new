import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { sha256 } from "../../lib/crypto.js";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Pool-wide dedup and suppression. Both tables hold sha256(lower(email)), never the address, so the protection
 * works across customers without building a cross-customer directory of people.
 */
export const RECENT_CONTACT_DAYS = 90;

export const emailHash = (email: string) => sha256(email.trim().toLowerCase());

export type SuppressionReason = "unsubscribe" | "hard_bounce" | "complaint" | "manual";

/** Adds an address to the global list. The first reason recorded is kept. */
export async function globalSuppress(email: string, reason: SuppressionReason, db: Db = prisma): Promise<void> {
  await db.globalSuppression.upsert({ where: { emailHash: emailHash(email) }, create: { emailHash: emailHash(email), reason }, update: {} });
}

export async function isGloballySuppressed(email: string, db: Db = prisma): Promise<boolean> {
  return !!(await db.globalSuppression.findUnique({ where: { emailHash: emailHash(email) }, select: { emailHash: true } }));
}

/** True when any customer emailed this person from the pool in the last 90 days. */
export async function recentlyContacted(email: string, now = new Date(), db: Db = prisma): Promise<boolean> {
  const since = new Date(now.getTime() - RECENT_CONTACT_DAYS * 86_400_000);
  return !!(await db.prospectContactLog.findFirst({ where: { emailHash: emailHash(email), contactedAt: { gte: since } }, select: { emailHash: true } }));
}

/** True when this mailbox has ever written to this person for a different customer. */
export async function mailboxUsedByAnotherCustomer(email: string, mailboxId: string, customerId: string, db: Db = prisma): Promise<boolean> {
  return !!(await db.prospectContactLog.findFirst({ where: { emailHash: emailHash(email), mailboxId, customerId: { not: customerId } }, select: { emailHash: true } }));
}

/** Written in the same transaction as the sends row of a first touch. */
export function logContact(db: Db, row: { email: string; customerId: string; domainId: string; mailboxId: string; at?: Date }) {
  return db.prospectContactLog.create({ data: { emailHash: emailHash(row.email), customerId: row.customerId, domainId: row.domainId, mailboxId: row.mailboxId, contactedAt: row.at ?? new Date() } });
}
