import type { Contact, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { recordMessage } from "./messages.js";
import { cleanInboundReply } from "./replyText.js";
import { postToSlack } from "../integrations/slack.js";
import { sha256 } from "../lib/crypto.js";

export interface InboundReply {
  orgId: string;
  contact: Contact;
  subject?: string | null;
  body: string;
  /** The reply's own Message-ID, so the same email read twice is recorded once. */
  emailMessageId?: string | null;
  meta?: Prisma.InputJsonValue;
  alert?: boolean;
  receivedAt?: Date;
}

const SOFT_REASONS = ["NO_RESPONSE", "ALREADY_CONTACTED"] as const;

function isEmptyish(body: string | null | undefined): boolean {
  return !body || cleanInboundReply(body).replace(/\s+/g, "").length < 2;
}

export async function recordInboundReply(r: InboundReply): Promise<{ messageId: string; duplicate: boolean }> {
  const body = cleanInboundReply(r.body);
  if (r.emailMessageId) {
    const existing = await prisma.message.findFirst({
      where: { organizationId: r.orgId, contactId: r.contact.id, direction: "INBOUND", emailMessageId: r.emailMessageId },
    });
    if (existing) {
      if (isEmptyish(existing.body) && !isEmptyish(body)) {
        await prisma.message.update({ where: { id: existing.id }, data: { body, intent: null, classifyStartedAt: null } });
      }
      return { messageId: existing.id, duplicate: true };
    }
  }
  const hash = sha256(body.replace(/\s+/g, " ").trim().toLowerCase());
  const recent = await prisma.message.findMany({
    where: { organizationId: r.orgId, contactId: r.contact.id, direction: "INBOUND", createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) } },
    select: { id: true, body: true },
  });
  const dup = recent.find((m) => sha256(cleanInboundReply(m.body).replace(/\s+/g, " ").trim().toLowerCase()) === hash);
  if (dup && body) return { messageId: dup.id, duplicate: true };

  const message = await prisma.$transaction(async (tx) => {
    const msg = await recordMessage(tx, {
      organizationId: r.orgId,
      contactId: r.contact.id,
      campaignId: r.contact.campaignId,
      direction: "INBOUND",
      via: "email",
      subject: r.subject ?? null,
      body,
      emailMessageId: r.emailMessageId ?? null,
      meta: r.meta,
      createdAt: r.receivedAt,
    });
    let status = r.contact.status;
    if (status === "BLOCKLISTED") {
      const rule = await tx.blocklistEntry.findUnique({
        where: { organizationId_entryType_value: { organizationId: r.orgId, entryType: "EMAIL", value: r.contact.emailNormalized } },
      });
      if (!rule || (SOFT_REASONS as readonly string[]).includes(rule.reason)) {
        if (rule) await tx.blocklistEntry.delete({ where: { id: rule.id } });
        status = "REPLIED";
      }
    } else if (!["UNSUBSCRIBED", "BOUNCED", "REJECTED"].includes(status)) {
      status = "REPLIED";
    }
    await tx.contact.update({
      where: { id: r.contact.id },
      data: { status, repliedAt: r.contact.repliedAt ?? new Date(), handledAt: null },
    });
    // A newer message from them makes any unsent draft stale; reply intelligence drafts again for this one.
    await tx.contact.update({ where: { id: r.contact.id }, data: { aiDraft: null, aiDraftAt: null } });
    return msg;
  });

  if (r.alert !== false) {
    const who = [r.contact.fullName || r.contact.email, r.contact.company].filter(Boolean).join(" at ");
    void postToSlack(r.orgId, `:incoming_envelope: *${who}* replied: ${body.replace(/\s+/g, " ").slice(0, 280)}`);
  }
  return { messageId: message.id, duplicate: false };
}
