import { prisma } from "../../lib/prisma.js";

/**
 * The persona pool. A handful of real first names per locale, reused across many domains (the same "Madison" on
 * decoderhubs.com and on logicplexes.com is normal); the three mailboxes on one domain always carry three different
 * personas. Never a single letter.
 *
 * Localisation is the point: a campaign into Hungary with English sender names gets nothing back. The router prefers
 * a persona whose locale matches the market the customer sells into.
 */
import { PERSONA_SEED } from "./personaSeed.js";

export { PERSONA_SEED };

/** Persona locales that fit a market: the campaign's own language first, then the region's, English as a fallback where it is a business language. */
export function targetLocales(region: string | null | undefined, language?: string | null): string[] {
  const byRegion: Record<string, string[]> = { pk: ["ur", "en"], ae: ["ar", "en"], sa: ["ar", "en"], qa: ["ar", "en"], "eu-de": ["de"], de: ["de"], "eu-fr": ["fr"], fr: ["fr"], "eu-es": ["es"], es: ["es"] };
  const out = [...(language && language !== "en" ? [language] : []), ...(byRegion[(region ?? "global").toLowerCase()] ?? ["en"])];
  return [...new Set(out)];
}

/** Puts the seed personas in place once. Safe to call any time. */
export async function ensurePersonas(): Promise<number> {
  let n = 0;
  for (const [locale, { region, names }] of Object.entries(PERSONA_SEED)) {
    for (const [firstName, lastName, genderHint] of names) {
      const r = await prisma.persona.upsert({ where: { firstName_locale: { firstName, locale } }, create: { firstName, lastName, locale, region, genderHint }, update: {} });
      if (r) n++;
    }
  }
  return n;
}

/** The local part for a persona: the lower-case first name, accents removed. Never shorter than two letters. */
export function localPartFor(firstName: string): string {
  const local = firstName.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
  if (local.length < 2) throw new Error(`"${firstName}" would make a single-letter mailbox`);
  return local;
}

/**
 * Three different personas for one new domain, from the locales that fit its region, varied across the batch so the
 * same three names don't land together every time.
 */
export async function personasForDomain(region: string, salt: number): Promise<{ id: string; firstName: string; lastName: string | null }[]> {
  await ensurePersonas();
  const locales = targetLocales(region);
  let pool = await prisma.persona.findMany({ where: { active: true, locale: { in: locales } }, orderBy: { firstName: "asc" } });
  if (pool.length < 3) pool = await prisma.persona.findMany({ where: { active: true, locale: "en" }, orderBy: { firstName: "asc" } });
  const picked: typeof pool = [];
  const seen = new Set<string>();
  for (let i = 0; picked.length < 3 && i < pool.length * 2; i++) {
    const p = pool[(salt * 7 + i * 3) % pool.length];
    const local = localPartFor(p.firstName);
    if (seen.has(local)) continue;
    seen.add(local);
    picked.push(p);
  }
  return picked;
}
