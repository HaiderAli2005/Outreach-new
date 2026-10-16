import { prisma, type Db } from "../lib/prisma.js";

export const VIA_AUTO = "auto-reply";
export const VIA_INBOX = "inbox";
/** A reply someone wrote straight from the mailbox, outside Aperture. */
export const VIA_MANUAL = "manual";
export const HUMAN_VIA = [VIA_INBOX, VIA_MANUAL];

export async function markHandoff(orgId: string, contactId: string, reason: string, db: Db = prisma): Promise<void> {
  await db.contact.updateMany({
    where: { id: contactId, organizationId: orgId },
    data: { autoReplyStatus: "MANUAL", handoffAt: new Date(), lastEscalationReason: reason.slice(0, 64) },
  });
}

export async function markNeverAuto(orgId: string, contactId: string, reason: string, db: Db = prisma): Promise<void> {
  await db.contact.updateMany({
    where: { id: contactId, organizationId: orgId },
    data: { neverAuto: true, autoReplyStatus: "MANUAL", lastEscalationReason: reason.slice(0, 64) },
  });
}

/** Throws away a drafted reply nobody sent. Drafts are only ever sent by a person pressing Send. */
export async function discardDraft(orgId: string, contactId: string, db: Db = prisma): Promise<number> {
  const r = await db.contact.updateMany({ where: { id: contactId, organizationId: orgId, aiDraft: { not: null } }, data: { aiDraft: null, aiDraftAt: null } });
  return r.count;
}

export async function hasHumanReply(orgId: string, contactId: string): Promise<boolean> {
  const n = await prisma.message.count({ where: { organizationId: orgId, contactId, direction: "OUTBOUND", via: { in: HUMAN_VIA } } });
  return n > 0;
}


