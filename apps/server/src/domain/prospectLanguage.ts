import type { Contact } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { readSiteLanguage } from "../integrations/site.js";
import { countryLanguage, detectLanguage, normalizeLanguage } from "./languages.js";

/**
 * The language to write to someone in: their company website's main language, else their country's, else the
 * workspace's. Worked out once per company (everyone at acme.de shares it) and stored on the contact.
 */
export async function languageFor(
  contact: Pick<Contact, "id" | "organizationId" | "language" | "companyDomain" | "domain" | "website" | "country">,
  fallback: string,
): Promise<string> {
  if (contact.language) return contact.language;
  const domain = (contact.companyDomain || contact.domain || hostOf(contact.website) || "").toLowerCase().replace(/^www\./, "");
  let lang: string | null = null;
  if (domain) {
    // Someone else at the same company was already worked out: same website, same language.
    const known = await prisma.contact.findFirst({ where: { organizationId: contact.organizationId, companyDomain: domain, language: { not: null }, NOT: { id: contact.id } }, select: { language: true } });
    lang = known?.language ?? null;
    if (!lang) {
      const sample = await readSiteLanguage(domain);
      lang = sample ? detectLanguage(sample.text, sample.lang) : null;
    }
  }
  lang = lang ?? countryLanguage(contact.country) ?? normalizeLanguage(fallback) ?? "en";
  await prisma.contact.update({ where: { id: contact.id }, data: { language: lang } });
  return lang;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    return null;
  }
}
