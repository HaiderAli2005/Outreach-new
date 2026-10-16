import type { OrgSettings, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { brandProfileOf, getSettings } from "./settings.js";

/**
 * What the AI believes about the customer's business, and the single record every email is written from. It starts
 * as what the setup analysis inferred, and the customer corrects it on Setup > Business profile. The writer reads it
 * at draft time, so a change applies to every draft written after it and never rewrites one already approved.
 */
export interface ProofPoint {
  claim: string;
  source: string;
}

export interface BusinessProfile {
  company: string;
  /** What they sell, in one or two plain sentences. */
  sell: string;
  /** Who they sell to: the buyers and companies. */
  who: string;
  /** Where they sell: countries or regions. */
  where: string;
  offerings: string[];
  differentiators: string[];
  /** How their emails should sound. */
  tone: string;
  proofPoints: ProofPoint[];
  updatedAt: string | null;
}

interface StoredBrand {
  company?: string;
  valueProp?: string | null;
  summary?: string | null;
  who?: string;
  where?: string;
  offerings?: string[];
  differentiators?: string[];
  brandVoice?: string | null;
  tone?: string;
  profileUpdatedAt?: string;
  audience?: { industries?: string[]; titles?: string[]; regions?: string[] };
}

const strs = (v: unknown, max = 12) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()).slice(0, max) : []);
const proofOf = (v: unknown): ProofPoint[] =>
  Array.isArray(v) ? (v as ProofPoint[]).filter((p) => p && typeof p.claim === "string" && typeof p.source === "string" && p.claim.trim() && p.source.trim()) : [];

/** The profile as stored, read the same way by the page and the writer. */
export function businessProfileOf(settings: OrgSettings): BusinessProfile {
  const b = brandProfileOf(settings) as StoredBrand;
  const regions = strs(b.audience?.regions);
  const titles = strs(b.audience?.titles, 6);
  const industries = strs(b.audience?.industries, 6);
  return {
    company: (settings.senderCompany || b.company || "").trim(),
    sell: (settings.valueProp || b.valueProp || b.summary || "").trim(),
    who: (b.who ?? [titles.join(", "), industries.length ? `at ${industries.join(", ")} companies` : ""].filter(Boolean).join(" ")).trim(),
    where: (b.where ?? regions.join(", ")).trim(),
    offerings: strs(b.offerings),
    differentiators: strs(b.differentiators),
    tone: (b.tone ?? b.brandVoice ?? "").trim(),
    proofPoints: proofOf(settings.proofPoints),
    updatedAt: b.profileUpdatedAt ?? null,
  };
}

/**
 * The page's starting content: the stored profile, with anything still empty filled from what the setup analysis
 * found (its facts, and the proof it read on the site). Nothing is saved until the customer saves.
 */
export async function businessProfileView(orgId: string): Promise<BusinessProfile & { suggested: string[] }> {
  const settings = await getSettings(orgId);
  const p = businessProfileOf(settings);
  const o = await prisma.onboarding.findUnique({ where: { organizationId: orgId }, select: { facts: true, analysis: true, brand: true } });
  const facts = Array.isArray(o?.facts) ? (o!.facts as { key?: string; value?: string }[]) : [];
  const fact = (k: string) => facts.find((f) => f.key === k)?.value?.trim() ?? "";
  const evidence = ((o?.analysis as { brandDetail?: { evidence?: ProofPoint[] } } | null)?.brandDetail?.evidence ?? []).filter((e) => e?.claim && e?.source);
  const suggested: string[] = [];
  const fill = <K extends keyof BusinessProfile>(k: K, v: BusinessProfile[K], empty: boolean) => {
    if (empty && (Array.isArray(v) ? v.length : v)) {
      (p as BusinessProfile)[k] = v;
      suggested.push(k);
    }
  };
  fill("company", fact("company") || o?.brand || "", !p.company);
  fill("sell", fact("sell"), !p.sell);
  fill("who", fact("who"), !p.who);
  fill("where", fact("where"), !p.where);
  fill("proofPoints", evidence.slice(0, 5).map((e) => ({ claim: e.claim.slice(0, 300), source: e.source.slice(0, 300) })), !p.proofPoints.length);
  return { ...p, suggested };
}

export interface ProfilePatch {
  company: string;
  sell: string;
  who: string;
  where: string;
  offerings: string[];
  differentiators: string[];
  tone: string;
  proofPoints: ProofPoint[];
}

/** Saves the profile. Drafts already written keep their words; every draft written from now on reads this. */
export async function saveBusinessProfile(orgId: string, patch: ProfilePatch): Promise<BusinessProfile> {
  const settings = await getSettings(orgId);
  const brand = brandProfileOf(settings) as StoredBrand & Record<string, unknown>;
  const next: StoredBrand & Record<string, unknown> = {
    ...brand,
    company: patch.company,
    valueProp: patch.sell,
    who: patch.who,
    where: patch.where,
    offerings: patch.offerings,
    differentiators: patch.differentiators,
    tone: patch.tone,
    profileUpdatedAt: new Date().toISOString(),
  };
  const saved = await prisma.orgSettings.update({
    where: { organizationId: orgId },
    data: {
      senderCompany: patch.company || settings.senderCompany,
      valueProp: patch.sell || null,
      brandProfile: next as unknown as Prisma.InputJsonValue,
      proofPoints: patch.proofPoints as unknown as Prisma.InputJsonValue,
    },
  });
  return businessProfileOf(saved);
}

/** The profile as the writer's prompt reads it. Empty parts are left out rather than guessed. */
export function profileForPrompt(p: BusinessProfile): string {
  return [
    p.who && `WHO WE SELL TO: ${p.who}`,
    p.where && `WHERE WE SELL: ${p.where}`,
    p.offerings.length ? `WHAT WE OFFER: ${p.offerings.join("; ")}` : "",
    p.differentiators.length ? `WHAT MAKES US DIFFERENT: ${p.differentiators.join("; ")}` : "",
    p.tone && `HOW WE SOUND: ${p.tone}`,
  ]
    .filter(Boolean)
    .join("\n");
}
