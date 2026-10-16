import type { Prisma, WebhookProvider } from "@prisma/client";
import { prisma, isUniqueViolation } from "../../lib/prisma.js";
import { sha256 } from "../../lib/crypto.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { discardDraft, markHandoff } from "../../domain/conversation.js";
import { logSystem } from "../../domain/systemLog.js";
import { postToSlack } from "../../integrations/slack.js";

type Body = Record<string, unknown>;
const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));

async function claim(provider: WebhookProvider, body: Body, type: string, orgId: string | null): Promise<string | null> {
  const externalId = sha256(JSON.stringify(body)).slice(0, 48);
  const existing = await prisma.webhookEvent.findUnique({ where: { provider_externalId: { provider, externalId } }, select: { id: true } });
  if (existing) return null;
  try {
    const row = await prisma.webhookEvent.create({ data: { provider, externalId, type: type.slice(0, 80), organizationId: orgId, payload: body as Prisma.InputJsonValue } });
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

async function finish(id: string, status: "PROCESSED" | "IGNORED" | "FAILED", error?: string) {
  await prisma.webhookEvent.update({ where: { id }, data: { status, processedAt: new Date(), error: error?.slice(0, 1000) ?? null } }).catch(() => undefined);
}

export async function orgForWebhookToken(token: string): Promise<string | null> {
  if (!token || token.length < 16) return null;
  const org = await prisma.organization.findUnique({ where: { webhookToken: token }, select: { id: true } });
  return org?.id ?? null;
}

export async function handleCalendly(orgToken: string, body: Body): Promise<{ status: string }> {
  const org = await prisma.organization.findUnique({ where: { webhookToken: orgToken }, select: { id: true } });
  if (!org) return { status: "unknown-organization" };
  const event = String(body.event ?? body.event_type ?? "").toLowerCase();
  const eventId = await claim("CALENDLY", body, event || "unknown", org.id);
  if (!eventId) return { status: "duplicate" };
  const payload = ((body.payload ?? body.data ?? {}) as Body) ?? {};
  const invitee = (payload.invitee ?? {}) as Body;
  const { normalized } = normalizeEmail(str(payload.email ?? invitee.email ?? payload.invitee_email));
  if (!normalized.includes("@")) {
    await finish(eventId, "IGNORED", "no invitee email");
    return { status: "ignored" };
  }
  const contact = await prisma.contact.findUnique({ where: { organizationId_emailNormalized: { organizationId: org.id, emailNormalized: normalized } } });
  if (!contact) {
    await finish(eventId, "IGNORED", "not a lead");
    return { status: "ignored" };
  }
  if (event.includes("cancel")) {
    await prisma.contact.update({ where: { id: contact.id }, data: { meetingBookedAt: null, replyUrgent: true } });
    await markHandoff(org.id, contact.id, "meeting-cancelled");
    void postToSlack(org.id, `:warning: ${contact.email} cancelled their booked meeting. Flagged for you.`);
    await finish(eventId, "PROCESSED");
    return { status: "cancelled" };
  }
  await prisma.contact.update({ where: { id: contact.id }, data: { meetingBookedAt: new Date(), replyUrgent: false, aiDraft: null, aiDraftAt: null, followUpAt: null } });
  await markHandoff(org.id, contact.id, "meeting-booked");
  await discardDraft(org.id, contact.id);
  await logSystem(org.id, "INFO", "meeting", `Meeting booked by ${contact.email}`, { contactId: contact.id });
  void postToSlack(org.id, `:tada: *Meeting booked* by ${contact.email}. Automatic replies are now off for this prospect.`);
  await finish(eventId, "PROCESSED");
  return { status: "booked" };
}

export async function handleApollo(orgToken: string, body: Body): Promise<{ status: string; updated: number }> {
  const org = await prisma.organization.findUnique({ where: { webhookToken: orgToken }, select: { id: true } });
  if (!org) return { status: "unknown-organization", updated: 0 };
  const people = (body.people ?? body.matches ?? body.contacts ?? (body.person ? [body.person] : body.email ? [body] : [])) as Body[];
  let updated = 0;
  for (const m of people) {
    const email = str(m?.email);
    if (!email) continue;
    const { normalized } = normalizeEmail(email);
    const apolloId = str(m.id);
    const r = await prisma.contact.updateMany({
      where: { organizationId: org.id, OR: [{ emailNormalized: normalized }, ...(apolloId ? [{ apolloId }] : [])], status: { in: ["NEW"] } },
      data: { emailStatus: str(m.email_status) ?? "verified" },
    });
    updated += r.count;
  }
  return { status: "ok", updated };
}
