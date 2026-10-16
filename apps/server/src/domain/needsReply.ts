import type { Prisma } from "@prisma/client";

export const NEEDS_LEAD_CLASSES = ["hot", "question", "curious", "review"];
export const LEAD_CLASSES = ["hot", "question", "review", "curious", "not_now", "away"];
export const SUPPRESSED_STATUSES = ["BLOCKLISTED", "BOUNCED", "UNSUBSCRIBED", "NO_RESPONSE"] as const;

export const activeOnly: Prisma.ContactWhereInput = {
  status: { notIn: [...SUPPRESSED_STATUSES] },
  handledAt: null,
};

export const leadClassOrUnread: Prisma.ContactWhereInput = {
  OR: [{ replyClass: null }, { replyClass: { in: NEEDS_LEAD_CLASSES } }],
};

export function needsReplyWhere(orgId: string): Prisma.ContactWhereInput {
  return {
    organizationId: orgId,
    hasInbound: true,
    lastMessageDirection: "INBOUND",
    AND: [leadClassOrUnread, activeOnly],
  };
}
