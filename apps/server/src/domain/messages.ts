import type { MessageDirection, Prisma } from "@prisma/client";
import type { Db } from "../lib/prisma.js";
import { prospectOwnWords } from "./replyText.js";

export interface NewMessage {
  organizationId: string;
  contactId: string;
  campaignId?: string | null;
  direction: MessageDirection;
  via?: string | null;
  subject?: string | null;
  body?: string | null;
  intent?: string | null;
  /** RFC 5322 Message-ID of the email this records. */
  emailMessageId?: string | null;
  meta?: Prisma.InputJsonValue;
  createdAt?: Date;
}

export function preview(body: string | null | undefined): string | null {
  if (!body) return null;
  return body.replace(/\s+/g, " ").trim().slice(0, 180) || null;
}

export async function recordMessage(db: Db, m: NewMessage) {
  const at = m.createdAt ?? new Date();
  const message = await db.message.create({
    data: {
      organizationId: m.organizationId,
      contactId: m.contactId,
      campaignId: m.campaignId ?? null,
      direction: m.direction,
      via: m.via ?? null,
      subject: m.subject?.slice(0, 500) ?? null,
      body: m.body?.slice(0, 60_000) ?? null,
      intent: m.intent ?? null,
      emailMessageId: m.emailMessageId ?? null,
      meta: m.meta,
      createdAt: at,
    },
  });
  const current = await db.contact.findUnique({ where: { id: m.contactId }, select: { lastMessageAt: true } });
  const isNewest = !current?.lastMessageAt || current.lastMessageAt <= at;
  await db.contact.update({
    where: { id: m.contactId },
    data: {
      messageCount: { increment: 1 },
      ...(m.direction === "INBOUND" ? { hasInbound: true } : {}),
      ...(isNewest ? { lastMessageAt: at, lastMessageDirection: m.direction, lastMessagePreview: preview(m.direction === "INBOUND" ? prospectOwnWords(m.body) || m.body : m.body) } : {}),
    },
  });
  return message;
}
