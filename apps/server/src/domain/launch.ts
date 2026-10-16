import type { Contact } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { conflict, unprocessable } from "../lib/errors.js";
import { getSettings } from "./settings.js";
import { logSystem } from "./systemLog.js";
import { SEND_FLOOR } from "./scoring.js";
import { approval } from "./approval.js";
import { fillSender, senderNames } from "./sending/senderName.js";

/**
 * Nothing sends until a person says so. Every person needs approvedAt (uploaded, reviewed, or auto-approved by the
 * workspace's own setting). On top of that, APPROVE_FIRST_BATCH holds every found person until the first 20 are
 * approved. There is no countdown anywhere: if nobody ever approves, nothing is ever sent.
 */
export const FIRST_BATCH_SIZE = 20;

export function consentText(companyName: string): string {
  return `I confirm I am authorised to send business email on behalf of ${companyName}, and that these recipients are relevant business contacts for what we offer.`;
}

export async function hasConsent(orgId: string): Promise<boolean> {
  return !!(await prisma.consentRecord.findFirst({ where: { organizationId: orgId }, select: { id: true } }));
}

/** Stores the exact wording, the person, the time and where it came from. */
export async function recordConsent(orgId: string, userId: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const [org, settings] = await Promise.all([prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } }), getSettings(orgId)]);
  const text = consentText(settings.senderCompany?.trim() || org.name);
  return prisma.consentRecord.create({ data: { organizationId: orgId, userId, text, ip: meta.ip?.slice(0, 80) ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null } });
}

const READY = { status: { in: ["PERSONALIZED", "QUEUED"] as ("PERSONALIZED" | "QUEUED")[] }, fitScore: { gte: SEND_FLOOR }, sequenceStoppedAt: null, campaign: { status: "ACTIVE" as const } };

/** People written to and waiting for a person to approve them. */
export const awaitingApprovalWhere = (orgId: string) => ({ organizationId: orgId, ...READY, approvedAt: null, OR: [{ verifyResult: null }, { verifyResult: "ok" }] });

/** The people waiting for approval, in the order the send run would take them. */
export function firstBatchCandidates(orgId: string, take = FIRST_BATCH_SIZE) {
  return prisma.contact.findMany({
    where: awaitingApprovalWhere(orgId),
    orderBy: [{ fitScore: "desc" }, { createdAt: "asc" }],
    take,
  });
}

const emailsOf = (c: Contact, sender: string) => [
  { step: 1, day: 0, subject: fillSender(c.messageSubject, sender), body: fillSender(c.personalization, sender) },
  { step: 2, day: 3, subject: c.messageSubject ? `Re: ${fillSender(c.messageSubject, sender)}` : null, body: fillSender(c.followup2, sender) },
  { step: 3, day: 7, subject: c.messageSubject ? `Re: ${fillSender(c.messageSubject, sender)}` : null, body: fillSender(c.followup3, sender) },
  { step: 4, day: 14, subject: c.messageSubject ? `Re: ${fillSender(c.messageSubject, sender)}` : null, body: fillSender(c.followup4, sender) },
];

export async function approvalView(orgId: string) {
  const [settings, consent, people, preparing] = await Promise.all([
    getSettings(orgId),
    prisma.consentRecord.findFirst({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" }, select: { createdAt: true, text: true } }),
    firstBatchCandidates(orgId),
    prisma.contact.count({ where: { organizationId: orgId, status: "NEW", sequenceStoppedAt: null, campaign: { status: "ACTIVE" } } }),
  ]);
  const [org, senderOf] = await Promise.all([prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } }), senderNames(orgId, people.map((c) => c.assignedMailboxId))]);
  return {
    launchMode: settings.launchMode,
    approved: !!settings.firstBatchApprovedAt,
    approvedAt: settings.firstBatchApprovedAt,
    needed: FIRST_BATCH_SIZE,
    ready: people.length,
    preparing,
    consent: consent ? { at: consent.createdAt, text: consent.text } : null,
    consentText: consentText(settings.senderCompany?.trim() || org.name),
    people: people.map((c) => ({
      id: c.id,
      name: c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null),
      email: c.email,
      title: c.title,
      company: c.company,
      emailSource: c.emailSource ?? c.source,
      verified: c.verifyResult,
      emails: emailsOf(c, senderOf(c.assignedMailboxId)),
    })),
  };
}

/**
 * Approves the first batch. Needs consent (given now or before), and the people on screen: the first 20, or all
 * of them if the campaign has fewer ready. Excluded people are set aside, never sent.
 */
export async function approveFirstBatch(orgId: string, userId: string, opts: { consent: boolean; excludeIds?: string[]; ip?: string | null; userAgent?: string | null }) {
  const settings = await getSettings(orgId);
  if (settings.firstBatchApprovedAt) throw conflict("Your first batch is already approved. Sending carries on until you pause it.");
  if (!(await hasConsent(orgId))) {
    if (!opts.consent) throw unprocessable("Tick the confirmation that you are authorised to send on your company's behalf.");
    await recordConsent(orgId, userId, opts);
  }
  if (opts.excludeIds?.length) {
    await prisma.contact.updateMany({ where: { organizationId: orgId, id: { in: opts.excludeIds }, status: { in: ["NEW", "PERSONALIZED", "QUEUED"] } }, data: { status: "REJECTED" } });
  }
  const people = await firstBatchCandidates(orgId);
  if (!people.length) throw unprocessable("Nobody is ready to approve yet. We're still finding and writing to your first people.");
  const now = new Date();
  await prisma.contact.updateMany({ where: { id: { in: people.map((p) => p.id) } }, data: approval("review", now) });
  await prisma.orgSettings.update({ where: { organizationId: orgId }, data: { firstBatchApprovedAt: now, firstBatchApprovedById: userId } });
  await logSystem(orgId, "INFO", "launch", `First batch approved: ${people.length} people and their emails. Sending starts in their own working hours.`, { userId });
  return { approved: people.length };
}

/** Approve named people (and their emails): every person found after the first batch, or each one in approve_each mode. */
export async function approvePeople(orgId: string, userId: string, ids: string[], meta: { consent: boolean; ip?: string | null; userAgent?: string | null }) {
  if (!(await hasConsent(orgId))) {
    if (!meta.consent) throw unprocessable("Tick the confirmation that you are authorised to send on your company's behalf.");
    await recordConsent(orgId, userId, meta);
  }
  const r = await prisma.contact.updateMany({ where: { organizationId: orgId, id: { in: ids }, approvedAt: null }, data: approval("review") });
  return { approved: r.count };
}
