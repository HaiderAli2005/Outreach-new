import type { Contact } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { verifierFor } from "../../integrations/verifier.js";
import { addUsage } from "../usage.js";
import { getSettings } from "../settings.js";
import { ALL_PAUSED_MESSAGE, COLD_PAUSED_MESSAGE, customerOf, isLiveConversation, release, releaseForContact, reserve, SEQUENCE_HOLD, sendAllowance } from "../credits/index.js";
import { PRICE_PER_EMAIL, REPLY_RESERVE } from "../money.js";
import { isPaused } from "./health.js";
import { colleagueReplied, stopSequence } from "./stop.js";
import { hasConsent } from "../launch.js";
import { spentToday } from "../budget.js";
import { checkFirstTouch, checkSubject, unsupportedClaims, type ClaimCorpus } from "../emailRules.js";
import { targetLocales } from "../pool/personas.js";
import { prospectTz, slotForStep, windowFor } from "./schedule.js";
import { SEQUENCE_DAYS } from "../../config/plans.js";
import { giveSlotBack, internalMayUse, pickMailbox, takeSlot } from "./pool.js";
import { emailHash, isGloballySuppressed, logContact, recentlyContacted } from "./dedup.js";
import { composeStep, textForStep, transmit, type MailboxWithDomain, type TransmitResult } from "./delivery.js";
import type { ThreadParent } from "./message.js";

/**
 * The send path, as an ordered chain. Each step gets the context and may refuse. A refusal releases any hold, gives
 * back any mailbox slot, and writes a `sends` row with status REJECTED and the reason, except for refusals that only
 * mean "not now" (no credit, paused, no capacity, our server unreachable): those leave the person queued.
 *
 *  1 stopGuard            the sequence has ended: replied, a colleague replied, unsubscribed, bounced, marked done
 *  2 launchGuard          first touches only: consent on record, and the launch approved (no timer ever approves)
 *  3 campaignGuard        the campaign is running; a paused campaign holds every sequence email back
 *  4 creditGuard          a first touch holds the whole sequence (or what is left); a follow-up needs $0.04 held or free
 *  5 budgetGuard          the customer's daily budget: 0 pauses, a number stops the day there
 *  6 customerHealthGuard  a bounce-paused customer sends no sequence email
 *  7 suppressionGuard     the customer's own suppression list and unsubscribes
 *  8 dedupGuard           global suppression; nobody emailed by ANY customer in 90 days; never the same mailbox for
 *                         one person across two customers
 *  9 verificationGuard    first touches only: verified in the last 7 days, 'ok'; catch-all refused
 * 10 contentGuard         the email rules: length, one question, no link in a first touch, no unsupported claims
 * 11 mailboxAssign        the pinned mailbox, whatever its status; else the router picks one (persona locale first)
 * 12 mailboxCapGuard      first touches only: under today's ladder cap
 * 13 domainHealthGuard    first touches only: the domain is ACTIVE or WARMING, authenticated, not paused
 * 14 deliver              SMTP, through the mailbox's transport
 * 15 recordSend           the pin (written once, for good), the contact log, the person's status
 *
 * Guards apply to new cold emails, never to conversations already in flight: a REPLIES_ONLY mailbox on a DEGRADED
 * domain still sends the follow-up and answers the person who replied yesterday. That is the whole point of pinning.
 */
export type SendContext = {
  customerId: string;
  campaignId: string | null;
  prospectId: string;
  isFirstTouch: boolean;
  /** Sequence step: 1 is the first touch, 2 to 4 the follow-ups. */
  step: number;
  mailboxId?: string;
  domainId?: string;
  reserveId?: string;
  reject?: { code: string; message: string; wait?: boolean };
  /** Loaded by the chain. */
  contact?: Contact;
  mailbox?: MailboxWithDomain;
  slotTaken?: boolean;
  /** Mailboxes this person must never be sent from (they wrote to them for another customer). */
  avoidMailboxes?: string[];
  sendId?: string;
  /** The outcome already wrote its own `sends` row (a hard bounce at send time), so a refusal adds none. */
  recorded?: boolean;
  transmitted?: TransmitResult;
  /** Delivery override, used by tests. */
  deliverFn?: (ctx: SendContext) => Promise<void>;
};

export type SendMiddleware = (ctx: SendContext) => Promise<SendContext>;

const VERIFY_FRESH_MS = 7 * 86_400_000;

const refuse = (ctx: SendContext, code: string, message: string, wait = false): SendContext => ({ ...ctx, reject: { code, message, wait } });

async function loadContact(ctx: SendContext): Promise<Contact> {
  ctx.contact ??= await prisma.contact.findFirstOrThrow({ where: { id: ctx.prospectId, organizationId: ctx.customerId } });
  return ctx.contact;
}

// 1
export const stopGuard: SendMiddleware = async (ctx) => {
  const c = await loadContact(ctx);
  if (c.sequenceStoppedAt) return refuse(ctx, "SEQUENCE_STOPPED", `This person's sequence has ended (${(c.sequenceStopReason ?? "stopped").replace(/_/g, " ")}).`);
  if (c.status === "UNSUBSCRIBED") return refuse(ctx, "UNSUBSCRIBED", "This person unsubscribed.");
  // Follow-ups go only while the person is still mid-sequence: a reply, a bounce or a block ends it.
  if (!ctx.isFirstTouch && ctx.step >= 2 && c.status !== "CONTACTED") {
    await stopSequence(c.id, c.status === "REPLIED" ? "replied" : c.status === "BOUNCED" ? "bounced" : "manual");
    return refuse(ctx, "SEQUENCE_STOPPED", "This person's sequence has ended.");
  }
  // Anyone at the same company replying to any of this customer's sequences ends this one too.
  if (await colleagueReplied(ctx.customerId, c)) {
    if (!ctx.isFirstTouch) await stopSequence(c.id, "colleague_replied");
    return refuse(ctx, "COLLEAGUE_REPLIED", "Someone at this company already replied, so nobody else there is emailed.", ctx.isFirstTouch);
  }
  return ctx;
};

// 2
export const launchGuard: SendMiddleware = async (ctx) => {
  if (!ctx.isFirstTouch) return ctx;
  if (!(await hasConsent(ctx.customerId))) return refuse(ctx, "CONSENT_REQUIRED", "Confirm you are authorised to send on your company's behalf before the first email.", true);
  const c = await loadContact(ctx);
  if (!c.approvedAt) return refuse(ctx, "AWAITING_APPROVAL", "This person and their emails haven't been approved yet.", true);
  if (c.approvalSource === "upload") return ctx;
  const s = await getSettings(ctx.customerId);
  if (s.launchMode === "APPROVE_FIRST_BATCH" && !s.firstBatchApprovedAt) return refuse(ctx, "AWAITING_APPROVAL", "Approve your first 20 people and their emails before anything sends.", true);
  return ctx;
};

// 3
export const campaignGuard: SendMiddleware = async (ctx) => {
  if (ctx.step < 1 || !ctx.campaignId) return ctx;
  const campaign = await prisma.campaign.findFirst({ where: { id: ctx.campaignId, organizationId: ctx.customerId }, select: { status: true } });
  if (campaign && campaign.status !== "ACTIVE") return refuse(ctx, "CAMPAIGN_PAUSED", "The campaign is paused. Sequences carry on once it is resumed.", true);
  return ctx;
};

// 4
export const creditGuard: SendMiddleware = async (ctx) => {
  // A first touch holds the whole sequence ($0.16), so the follow-ups are paid for before the first email goes; when
  // less is left, it holds what there is in whole emails. Cold email never touches the last $2 (the reply reserve), so
  // a live conversation never dies because the credit ran out. Internal outreach (our own companies) is not billed.
  if (ctx.step < 1) return ctx;
  const org = await prisma.organization.findUnique({ where: { id: ctx.customerId }, select: { kind: true } });
  if (org?.kind === "INTERNAL") return ctx;
  const isReply = await isLiveConversation(ctx.prospectId);
  const refuseFor = (code: "COLD_EMAIL_PAUSED" | "INSUFFICIENT_CREDITS") => refuse(ctx, code, code === "COLD_EMAIL_PAUSED" ? COLD_PAUSED_MESSAGE : ALL_PAUSED_MESSAGE, true);
  if (ctx.isFirstTouch) {
    const r = await reserve(ctx.customerId, SEQUENCE_HOLD, { contactId: ctx.prospectId, note: "Held for a 4-email sequence", atLeast: PRICE_PER_EMAIL, keep: isReply ? 0n : REPLY_RESERVE });
    if (!r.ok) return refuseFor(r.code);
    return { ...ctx, reserveId: r.reservationId };
  }
  // A follow-up spends its hold; without one it needs the money free, above the reserve.
  const a = await sendAllowance(ctx.customerId, { isReply, contactId: ctx.prospectId });
  if (!a.ok) return refuseFor(a.code);
  return ctx;
};

// 5
export const budgetGuard: SendMiddleware = async (ctx) => {
  if (ctx.step < 1) return ctx;
  const s = await getSettings(ctx.customerId);
  const budget = s.dailyBudgetDecicents;
  if (budget === null || budget === undefined) return ctx;
  if (budget <= 0n) return refuse(ctx, "BUDGET_PAUSED", "Your daily budget is set to zero, so sending is paused.", true);
  if ((await spentToday(ctx.customerId)) + PRICE_PER_EMAIL > budget) return refuse(ctx, "BUDGET_REACHED", "Today's budget is spent. Sending continues tomorrow.", true);
  return ctx;
};

// 6
export const customerHealthGuard: SendMiddleware = async (ctx) => {
  if (ctx.step < 1) return ctx;
  if (await isPaused(ctx.customerId)) return refuse(ctx, "CUSTOMER_PAUSED", "Emails are paused because too many recent ones bounced.", true);
  return ctx;
};

// 7
export const suppressionGuard: SendMiddleware = async (ctx) => {
  const c = await loadContact(ctx);
  const domain = c.companyDomain ?? c.domain;
  const own = await prisma.blocklistEntry.findFirst({
    where: { organizationId: ctx.customerId, OR: [{ entryType: "EMAIL", value: c.emailNormalized }, ...(domain ? [{ entryType: "DOMAIN" as const, value: domain }] : [])] },
    select: { reason: true },
  });
  if (own) return refuse(ctx, own.reason === "UNSUBSCRIBED" ? "UNSUBSCRIBED" : "SUPPRESSED", `This address is on your blocklist (${own.reason.toLowerCase().replace(/_/g, " ")}).`);
  return ctx;
};

// 8
export const dedupGuard: SendMiddleware = async (ctx) => {
  const c = await loadContact(ctx);
  if (await isGloballySuppressed(c.emailNormalized)) return refuse(ctx, "SUPPRESSED", "This address unsubscribed, bounced or complained before and is on the global suppression list.");
  if (!ctx.isFirstTouch) return ctx;
  // Two of our customers emailing one person from the same pool with two different pitches looks like a scam.
  if (await recentlyContacted(c.emailNormalized)) return refuse(ctx, "RECENTLY_CONTACTED", "Someone emailed this person from our senders in the last 90 days. Pick a different person.");
  const used = await prisma.prospectContactLog.findMany({ where: { emailHash: emailHash(c.emailNormalized), customerId: { not: ctx.customerId } }, select: { mailboxId: true }, distinct: ["mailboxId"] });
  return { ...ctx, avoidMailboxes: used.map((u) => u.mailboxId) };
};

// 9
export const verificationGuard: SendMiddleware = async (ctx) => {
  if (!ctx.isFirstTouch) return ctx;
  const c = await loadContact(ctx);
  const fresh = !!c.verifiedAt && Date.now() - c.verifiedAt.getTime() < VERIFY_FRESH_MS;
  let result = fresh ? (c.verifyResult ?? "unknown") : null;
  if (!result) {
    const verify = await verifierFor(ctx.customerId);
    if (!verify) return refuse(ctx, "VERIFIER_UNAVAILABLE", "Email verification is not configured, so nothing is sent unverified.", true);
    const v = await verify(c.email);
    if (v.transient) return refuse(ctx, "VERIFIER_UNAVAILABLE", "Verification didn't answer; trying again later.", true);
    await addUsage(ctx.customerId, "emailsVerified");
    result = v.result;
    ctx.contact = await prisma.contact.update({ where: { id: c.id }, data: { verifyResult: v.result, verifyQuality: v.quality, verifiedAt: new Date() } });
  }
  if (result === "ok") return ctx;
  if (result === "catch_all") return refuse(ctx, "CATCH_ALL", "The address is on a catch-all server, which can't be verified. Not sent.");
  return refuse(ctx, "INVALID", `The address didn't verify (${result}). Not sent.`);
};

const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly)\b/i;
const SPAMMY = [/\b100% free\b/i, /\bact now\b/i, /\brisk[- ]free\b/i, /\bguaranteed?\b.*\bresults?\b/i, /\bclick here\b/i, /\$\$\$/, /\bcongratulations\b.*\bwinner\b/i, /\bno credit check\b/i, /\bearn \$?\d+.*\bper (day|week)\b/i];

/** The content policy. Returns the first rule a message breaks, or null. */
export function contentProblem(subject: string | null | undefined, bodies: (string | null | undefined)[]): string | null {
  const s = (subject ?? "").trim();
  if (!s) return "subject is empty";
  if (s.length > 120) return "subject is longer than 120 characters";
  if (!bodies[0]?.trim()) return "first email is empty";
  for (const b of bodies.filter(Boolean) as string[]) {
    const text = `${s}\n${b}`;
    if (/\{\{(?!sender_first_name\}\})[^}]*\}\}|%[a-z_-]+%/i.test(b)) return "a merge field was left unfilled";
    if (/<img\b/i.test(b)) return "images and tracking pixels are not allowed";
    if (/<\/?(a|p|div|br|span|table|html|body|font|b|i|strong)\b[^>]*>/i.test(b)) return "HTML is not allowed, emails are plain text";
    if (SHORTENERS.test(text)) return "link shorteners are not allowed";
    if ((b.match(/https?:\/\//gi) ?? []).length > 2) return "more than two links";
    const spam = SPAMMY.find((r) => r.test(text));
    if (spam) return `wording that spam filters flag (${spam.source.replace(/\\b|\\/g, "")})`;
  }
  return null;
}

/** What an email may draw on as proof: the research about this person and the customer's own sourced facts. */
async function corpusFor(orgId: string, c: Contact): Promise<ClaimCorpus> {
  const s = await getSettings(orgId);
  const company = c.companyDomain ? await prisma.company.findUnique({ where: { organizationId_domain: { organizationId: orgId, domain: c.companyDomain } }, select: { description: true, name: true, industry: true } }) : null;
  const proof = Array.isArray(s.proofPoints) ? (s.proofPoints as { claim?: string; source?: string }[]).filter((p) => p?.claim && p?.source) : [];
  return {
    prospect: [c.firstName, c.lastName, c.fullName, c.title, c.company, c.industry, c.website, c.location, c.city, c.country, c.headline, company?.name, company?.description, company?.industry].filter(Boolean).join("\n"),
    customer: [s.senderCompany, s.valueProp, JSON.stringify(s.brandProfile ?? {}), ...proof.map((p) => p.claim)].filter(Boolean).join("\n"),
  };
}

// 10
export const contentGuard: SendMiddleware = async (ctx) => {
  if (ctx.step < 1) return ctx;
  const c = await loadContact(ctx);
  const text = textForStep(c, ctx.step);
  const problem = contentProblem(ctx.step === 1 ? c.messageSubject : `Re: ${c.messageSubject ?? ""}`, [text]);
  if (problem) return refuse(ctx, "CONTENT_BLOCKED", `Content blocked: ${problem}.`);
  const corpus = await corpusFor(ctx.customerId, c);
  if (ctx.step === 1) {
    const subj = checkSubject(c.messageSubject ?? "", c);
    if (subj) return refuse(ctx, "CONTENT_BLOCKED", `Content blocked: subject ${subj}.`);
    const first = checkFirstTouch(text ?? "");
    if (first) return refuse(ctx, "CONTENT_BLOCKED", `Content blocked: ${first}.`);
  } else if (((text ?? "").match(/\?/g) ?? []).length > 1) {
    return refuse(ctx, "CONTENT_BLOCKED", "Content blocked: more than one question.");
  }
  const claims = unsupportedClaims(text ?? "", corpus);
  if (claims.length) return refuse(ctx, "CONTENT_BLOCKED", `Content blocked: unsupported claim (${claims.slice(0, 3).join(", ")}).`);
  return ctx;
};

// 11
export const mailboxAssign: SendMiddleware = async (ctx) => {
  const c = await loadContact(ctx);
  if (c.assignedMailboxId) {
    // Pinned: always this mailbox, whatever its status. Follow-ups and replies depend on it.
    const m = await prisma.mailbox.findUniqueOrThrow({ where: { id: c.assignedMailboxId }, include: { sendingDomain: true } });
    if (m.status === "RETIRED") return refuse(ctx, "MAILBOX_RETIRED", "The mailbox this conversation used has been retired, so its sequence ends.");
    if (!ctx.isFirstTouch && m.sendingDomain?.pausedAt) return refuse(ctx, "DOMAIN_PAUSED", "The sending domain is paused while we fix its authentication. Sending resumes after.", true);
    return { ...ctx, mailboxId: m.id, domainId: m.sendingDomainId ?? undefined, mailbox: m };
  }
  if (!ctx.isFirstTouch) return refuse(ctx, "NOT_PINNED", "A follow-up or reply needs the mailbox the conversation started on, and this person has none.");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.customerId }, select: { region: true, kind: true } });
  if (org.kind === "INTERNAL" && !(await internalMayUse())) return refuse(ctx, "NO_CAPACITY", "Capacity is kept for customers right now. Internal outreach goes later.", true);
  const campaign = ctx.campaignId ? await prisma.campaign.findUnique({ where: { id: ctx.campaignId }, select: { language: true } }) : null;
  const locales = targetLocales(org.region, campaign?.language ?? (await getSettings(ctx.customerId)).language);
  const picked = await pickMailbox(ctx.customerId, org.region, { exclude: ctx.avoidMailboxes, locales });
  if (!picked) return refuse(ctx, "NO_CAPACITY", "No sending capacity is free right now. The rest go tomorrow.", true);
  // The pin is written only once the email has actually been handed to a mail server (recordSend), so a send our
  // own server couldn't make can still go out from another mailbox.
  const m = await prisma.mailbox.findUniqueOrThrow({ where: { id: picked.mailboxId }, include: { sendingDomain: true } });
  return { ...ctx, mailboxId: m.id, domainId: picked.domainId, mailbox: m, slotTaken: true };
};

// 12
export const mailboxCapGuard: SendMiddleware = async (ctx) => {
  if (!ctx.isFirstTouch || ctx.slotTaken) return ctx;
  const m = ctx.mailbox!;
  if (m.status !== "ACTIVE" && m.status !== "WARMING") return refuse(ctx, "MAILBOX_REPLIES_ONLY", `${m.address} no longer takes new people, only conversations already on it.`);
  if (!(await takeSlot(m.id))) return refuse(ctx, "DEFERRED", "This person's mailbox is full today. Sending tomorrow.", true);
  return { ...ctx, slotTaken: true };
};

// 13
export const domainHealthGuard: SendMiddleware = async (ctx) => {
  if (!ctx.isFirstTouch) return ctx;
  const d = ctx.mailbox?.sendingDomain;
  if (!d || (d.status !== "ACTIVE" && d.status !== "WARMING")) return refuse(ctx, "DOMAIN_UNHEALTHY", `The sending domain is ${d?.status.toLowerCase() ?? "missing"}, so it takes no new people.`);
  if (d.pausedAt) return refuse(ctx, "DOMAIN_PAUSED", "The sending domain is paused while we fix its authentication.", true);
  if (!d.spfOk || !d.dkimOk || !d.dmarcOk) return refuse(ctx, "DOMAIN_UNAUTHENTICATED", "The sending domain's SPF, DKIM or DMARC is not verified yet.", true);
  return ctx;
};

/** The thread a follow-up continues: the previous sequence email's Message-ID and chain. */
async function parentFor(contactId: string, step: number): Promise<{ parent: ThreadParent | null; firstSubject: string | null }> {
  if (step <= 1) return { parent: null, firstSubject: null };
  const sends = await prisma.send.findMany({ where: { contactId, step: { gte: 1, lt: step }, messageId: { not: null }, status: { in: ["SENT", "DELIVERED"] } }, orderBy: { step: "asc" } });
  const prev = sends.at(-1);
  return { parent: prev ? { messageId: prev.messageId!, references: prev.referencesChain } : null, firstSubject: sends[0]?.subject ?? null };
}

// 14
export const deliver: SendMiddleware = async (ctx) => {
  if (ctx.deliverFn) {
    await ctx.deliverFn(ctx);
    return ctx;
  }
  const c = ctx.contact!;
  const settings = await getSettings(ctx.customerId);
  const { parent, firstSubject } = await parentFor(c.id, ctx.step);
  let m = ctx.mailbox!;
  const content = composeStep(c, ctx.step, settings, m, firstSubject);
  let r = await transmit({ orgId: ctx.customerId, contact: c, mailbox: m, campaignId: ctx.campaignId, step: ctx.step, isFirstTouch: ctx.isFirstTouch, ...content, parent, via: "sequence", slotTaken: ctx.slotTaken, recordTransportErrors: !ctx.isFirstTouch });

  // Our own authentication failed on that domain (now paused). An unpinned first touch tries one other domain.
  if (ctx.isFirstTouch && !c.assignedMailboxId && (r.outcome === "AUTH_FAILURE" || r.outcome === "DOMAIN_BLOCKED")) {
    await giveSlotBack(m.id);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.customerId }, select: { region: true } });
    const again = await pickMailbox(ctx.customerId, org.region, { locales: targetLocales(org.region, (await getSettings(ctx.customerId)).language), exclude: [...(ctx.avoidMailboxes ?? []), m.id], excludeDomains: m.sendingDomainId ? [m.sendingDomainId] : [] });
    if (!again) return refuse({ ...ctx, slotTaken: false }, "SENDING_UNAVAILABLE", "Our sending domain failed authentication and no other one is free right now.", true);
    const from = m.id;
    m = await prisma.mailbox.findUniqueOrThrow({ where: { id: again.mailboxId }, include: { sendingDomain: true } });
    ctx = { ...ctx, mailbox: m, mailboxId: m.id, domainId: again.domainId };
    r = await transmit({ orgId: ctx.customerId, contact: c, mailbox: m, campaignId: ctx.campaignId, step: 1, isFirstTouch: true, ...composeStep(c, 1, settings, m, null), parent: null, via: "sequence", slotTaken: true, reroutedFromId: from });
  }
  ctx = { ...ctx, transmitted: r, sendId: r.send?.id };
  switch (r.outcome) {
    case "SENT":
    case "SOFT_BOUNCE":
    case "RATE_LIMITED":
      return ctx;
    case "TRANSPORT_ERROR":
      if (ctx.isFirstTouch && ctx.slotTaken) await giveSlotBack(m.id);
      return refuse({ ...ctx, slotTaken: false, recorded: !!r.send }, "DELIVERY_RETRY", `Our mail server could not be reached: ${r.result.response}`, true);
    case "HARD_BOUNCE":
      return refuse({ ...ctx, slotTaken: false, recorded: true }, "HARD_BOUNCE", `The receiving server refused the address (${r.result.enhancedCode ?? r.result.smtpCode}).`);
    default:
      if (ctx.isFirstTouch && ctx.slotTaken) await giveSlotBack(m.id);
      return refuse({ ...ctx, slotTaken: false, recorded: true }, "SENDING_UNAVAILABLE", "Our sending domain failed authentication. It is paused and an operator has been alerted.", true);
  }
};

// 15
export const recordSend: SendMiddleware = async (ctx) => {
  const c = ctx.contact!;
  const now = new Date();
  if (!ctx.isFirstTouch) {
    await prisma.contact.update({ where: { id: c.id }, data: { lastContactedAt: now, ...(ctx.transmitted?.outcome === "SENT" ? {} : { nextTouchAt: null }) } });
    // A soft bounce is retried first; the next email is scheduled once this one actually goes (see retrySoftBounces).
    if (ctx.step >= 1 && (ctx.transmitted?.outcome === "SENT" || ctx.deliverFn)) await scheduleNextTouch(ctx.customerId, c.id, ctx.step, c.firstContactedAt ?? now);
    return ctx;
  }
  await prisma.$transaction(async (tx) => {
    // The pin, written once and for good. The WHERE makes it write-once even if two runs race; the database trigger
    // refuses any later change.
    await tx.contact.updateMany({ where: { id: c.id, assignedMailboxId: null }, data: { assignedMailboxId: ctx.mailboxId } });
    await tx.contact.update({ where: { id: c.id }, data: { status: "CONTACTED", firstContactedAt: c.firstContactedAt ?? now, lastContactedAt: now } });
    if (ctx.domainId && ctx.mailboxId) await logContact(tx, { email: c.emailNormalized, customerId: ctx.customerId, domainId: ctx.domainId, mailboxId: ctx.mailboxId, at: now });
  });
  if (ctx.transmitted?.outcome === "SENT" || ctx.deliverFn) await scheduleNextTouch(ctx.customerId, c.id, 1, c.firstContactedAt ?? now);
  else await prisma.contact.update({ where: { id: c.id }, data: { nextTouchAt: null } });
  return ctx;
};

/**
 * After sequence email `sentStep` went: the next one's slot (day 3, 7 or 14 after the first, a random minute inside
 * the prospect's window on a sending day), or the end of the sequence after the fourth.
 */
export async function scheduleNextTouch(orgId: string, contactId: string, sentStep: number, firstSentAt: Date): Promise<Date | null> {
  if (sentStep >= SEQUENCE_DAYS.length) {
    await stopSequence(contactId, "finished");
    return null;
  }
  const [settings, contact, org] = await Promise.all([
    getSettings(orgId),
    prisma.contact.findUniqueOrThrow({ where: { id: contactId }, select: { timezone: true, country: true, city: true, location: true } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { region: true } }),
  ]);
  const tz = prospectTz(contact, settings, org?.region);
  const at = slotForStep(windowFor(settings, tz), firstSentAt, SEQUENCE_DAYS[sentStep]);
  await prisma.contact.updateMany({ where: { id: contactId, sequenceStoppedAt: null }, data: { nextTouchAt: at, timezone: contact.timezone ?? tz } });
  return at;
}

export const PIPELINE: SendMiddleware[] = [stopGuard, launchGuard, campaignGuard, creditGuard, budgetGuard, customerHealthGuard, suppressionGuard, dedupGuard, verificationGuard, contentGuard, mailboxAssign, mailboxCapGuard, domainHealthGuard, deliver, recordSend];

const CONTACT_STATUS_ON_REJECT: Record<string, "BOUNCED" | "BLOCKLISTED" | "UNSUBSCRIBED" | "REJECTED"> = {
  CATCH_ALL: "REJECTED",
  INVALID: "BOUNCED",
  SUPPRESSED: "BLOCKLISTED",
  RECENTLY_CONTACTED: "REJECTED",
  UNSUBSCRIBED: "UNSUBSCRIBED",
  CONTENT_BLOCKED: "REJECTED",
  MAILBOX_REPLIES_ONLY: "REJECTED",
  DOMAIN_UNHEALTHY: "REJECTED",
};

export type SendOutcome = { ok: true; sendId: string; mailboxId: string } | { ok: false; code: string; message: string; wait: boolean };

/** Runs one person through the chain and cleans up after a refusal. */
export async function runPipeline(start: SendContext, chain: SendMiddleware[] = PIPELINE): Promise<SendOutcome> {
  let ctx = start;
  for (const step of chain) {
    ctx = await step(ctx);
    if (ctx.reject) break;
  }
  if (!ctx.reject) return { ok: true, sendId: ctx.sendId ?? "", mailboxId: ctx.mailboxId! };

  const { code, message, wait = false } = ctx.reject;
  if (ctx.reserveId) await release(ctx.reserveId, `Not sent (${code})`);
  if (ctx.slotTaken && ctx.mailboxId) await giveSlotBack(ctx.mailboxId);
  if (!wait && !ctx.recorded) {
    await prisma.send.create({
      data: { organizationId: ctx.customerId, campaignId: ctx.campaignId, contactId: ctx.prospectId, mailboxId: ctx.mailboxId ?? null, domainId: ctx.domainId ?? null, isFirstTouch: ctx.isFirstTouch, step: ctx.step, status: "REJECTED", rejectCode: code, rejectReason: message.slice(0, 500), resolvedAt: new Date() },
    });
    const status = CONTACT_STATUS_ON_REJECT[code];
    if (status && ctx.isFirstTouch) await prisma.contact.update({ where: { id: ctx.prospectId }, data: { status } }).catch(() => undefined);
    // A follow-up that can never go: the sequence ends here and what was held for it goes back.
    if (!ctx.isFirstTouch) await releaseForContact(ctx.prospectId, `Sequence ended (${code})`);
  }
  logger.debug({ orgId: ctx.customerId, contactId: ctx.prospectId, code }, "send refused");
  return { ok: false, code, message, wait };
}

/** A first touch for one person. */
export function sendFirstTouch(orgId: string, contactId: string, campaignId: string | null): Promise<SendOutcome> {
  return runPipeline({ customerId: orgId, campaignId, prospectId: contactId, isFirstTouch: true, step: 1 });
}

/** Sequence email 2, 3 or 4, from the pinned mailbox, threaded under the one before. */
export function sendFollowUp(orgId: string, contactId: string, campaignId: string | null, step: 2 | 3 | 4): Promise<SendOutcome> {
  return runPipeline({ customerId: orgId, campaignId, prospectId: contactId, isFirstTouch: false, step });
}

