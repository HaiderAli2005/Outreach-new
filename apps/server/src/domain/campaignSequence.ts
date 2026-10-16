import type { Campaign, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { SEQUENCE_DAYS } from "../config/plans.js";
import { SENDER_FIRST_NAME } from "./sending/message.js";
import { bannedPhrase, checkFirstTouch, checkFollowUp, checkSubject } from "./emailRules.js";

/**
 * The campaign's approved 4-touch sequence (days 0, 3, 7, 14). It starts as the sample sequence written in setup and
 * is edited on Setup > Email sequence. Every prospect's emails are written from it: the writer keeps its structure,
 * offer, proof and question, and fills in the prospect. Merge tokens: {{first_name}}, {{company}},
 * {{sender_first_name}}.
 */
export interface Touch {
  step: number;
  day: number;
  /** Only the first touch has its own subject; follow-ups are replies in the same thread. */
  subject: string | null;
  body: string;
}

export const MERGE_TOKENS = ["{{first_name}}", "{{company}}", "{{sender_first_name}}", "{{similar_company}}"] as const;

/** The setup sample, turned into the template: the persona name written into it goes back to its merge token. */
export function seedFromPreview(preview: unknown): Touch[] | null {
  if (!Array.isArray(preview) || preview.length < 4) return null;
  const emails = preview as { subject?: string; body?: string; sender?: string }[];
  return SEQUENCE_DAYS.map((day, i) => {
    const e = emails[i] ?? {};
    let body = String(e.body ?? "").trim();
    if (e.sender) body = body.split(`I'm ${e.sender} `).join(`I'm ${SENDER_FIRST_NAME} `);
    return { step: i + 1, day, subject: i === 0 ? String(e.subject ?? "").trim() : null, body };
  });
}

export function sequenceOf(campaign: Pick<Campaign, "sequence">): Touch[] | null {
  const s = campaign.sequence;
  if (!Array.isArray(s) || s.length !== SEQUENCE_DAYS.length) return null;
  return (s as unknown as Touch[]).map((t, i) => ({ step: i + 1, day: SEQUENCE_DAYS[i], subject: i === 0 ? String(t.subject ?? "") : null, body: String(t.body ?? "") }));
}

/** The paragraphs of an email body, without the greeting line ("Hi {{first_name}},"). */
export function paragraphsOf(body: string): string[] {
  const parts = body
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length && /^(hi|hello|hey|dear)\b[^\n]{0,60},?$/i.test(parts[0])) parts.shift();
  return parts;
}

/**
 * The template rules, checked on save. Touch 1: subject 2 to 4 words as a noun phrase with no verb; body 90 to 130
 * words in 4 paragraphs with exactly one question, at the end. Follow-ups: at most one question, no links.
 */
export function sequenceErrors(touches: Touch[]): { step: number; field: "subject" | "body"; message: string }[] {
  const out: { step: number; field: "subject" | "body"; message: string }[] = [];
  if (touches.length !== SEQUENCE_DAYS.length) return [{ step: 1, field: "body", message: "The sequence has exactly 4 emails" }];
  const [first, ...rest] = touches;
  const subj = checkSubject(first.subject ?? "");
  if (subj) out.push({ step: 1, field: "subject", message: `The subject ${subj}.` });
  const body = first.body.trim();
  const rule = checkFirstTouch(body);
  if (rule) out.push({ step: 1, field: "body", message: `${rule.charAt(0).toUpperCase()}${rule.slice(1)}.` });
  const paras = paragraphsOf(body).length;
  if (paras !== 4) out.push({ step: 1, field: "body", message: `The first email has ${paras} paragraph${paras === 1 ? "" : "s"}; it needs 4, separated by a blank line.` });
  rest.forEach((t, i) => {
    const p = checkFollowUp(t.body);
    if (p) out.push({ step: i + 2, field: "body", message: `${p.charAt(0).toUpperCase()}${p.slice(1)}.` });
    if (/https?:\/\/|www\./i.test(t.body)) out.push({ step: i + 2, field: "body", message: "No links in a follow-up." });
  });
  for (const t of touches) {
    const unknown = (t.body.match(/\{\{[^}]+\}\}/g) ?? []).filter((x) => !(MERGE_TOKENS as readonly string[]).includes(x));
    if (unknown.length) out.push({ step: t.step, field: "body", message: `Unknown merge field ${unknown[0]}. Use ${MERGE_TOKENS.slice(0, 3).join(", ")}.` });
    if (bannedPhrase(t.subject ?? "")) out.push({ step: t.step, field: "subject", message: `The subject uses "${bannedPhrase(t.subject ?? "")}".` });
  }
  return out;
}

/** The campaign this workspace's Setup pages edit: the running one, or the first one made. */
export async function activeCampaign(orgId: string) {
  return (
    (await prisma.campaign.findFirst({ where: { organizationId: orgId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } })) ??
    (await prisma.campaign.findFirst({ where: { organizationId: orgId, status: { not: "ARCHIVED" } }, orderBy: { createdAt: "asc" } }))
  );
}

/** The sequence to show: the saved one, or the setup sample when none is saved yet. */
export async function sequenceView(orgId: string) {
  const campaign = await activeCampaign(orgId);
  const saved = campaign ? sequenceOf(campaign) : null;
  if (saved) return { campaignId: campaign!.id, campaignName: campaign!.name, touches: saved, fromSample: false };
  const o = await prisma.onboarding.findUnique({ where: { organizationId: orgId }, select: { preview: true } });
  const seed = seedFromPreview(o?.preview);
  return { campaignId: campaign?.id ?? null, campaignName: campaign?.name ?? null, touches: seed ?? SEQUENCE_DAYS.map((day, i) => ({ step: i + 1, day, subject: i === 0 ? "" : null, body: "" })), fromSample: !!seed };
}

export async function saveSequence(campaignId: string, touches: Touch[]) {
  const clean = touches.map((t, i) => ({ step: i + 1, day: SEQUENCE_DAYS[i], subject: i === 0 ? (t.subject ?? "").trim() : null, body: t.body.replace(/\r\n/g, "\n").trim() }));
  await prisma.campaign.update({ where: { id: campaignId }, data: { sequence: clean as unknown as Prisma.InputJsonValue } });
  return clean;
}

/** The approved sequence as the writer's prompt reads it. */
export function sequenceForPrompt(touches: Touch[]): string {
  return touches.map((t) => `EMAIL ${t.step} (day ${t.day})${t.subject ? `, subject "${t.subject}"` : ""}:\n${t.body}`).join("\n\n");
}
