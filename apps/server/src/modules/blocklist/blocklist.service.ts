import type { BlockEntryType, BlockReason, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { badRequest, notFound, unprocessable } from "../../lib/errors.js";
import { extractDomain, isFreeMailDomain, normalizeEmail, EMAIL_RE } from "../../lib/normalize.js";
import { blockEmail, pauseInFlight } from "../../domain/suppression.js";
import { parseEmailOrDomainList, parseLeadCsv } from "../../domain/leadImport.js";
import { verifierFor } from "../../integrations/verifier.js";

const SHARED_WEB_HOSTS = new Set([
  "facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "tiktok.com", "linktr.ee", "business.site",
  "google.com", "sites.google.com", "wixsite.com", "wordpress.com", "blogspot.com", "squarespace.com", "shopify.com", "yelp.com", "tripadvisor.com",
]);
const SOFT_RULE_REASONS: BlockReason[] = ["ALREADY_CONTACTED", "NO_RESPONSE", "MANUAL", "BOUNCED"];

/** Added by the product on its own: unsubscribes, hard bounces, complaints and hostile replies, non-responders. */
export const AUTOMATIC_REASONS: BlockReason[] = ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "NO_RESPONSE", "ALREADY_CONTACTED"];
export const originOf = (reason: BlockReason) => (AUTOMATIC_REASONS.includes(reason) ? "automatic" : "you");

export async function list(orgId: string, q: { entryType?: BlockEntryType; reason?: BlockReason; origin?: "you" | "automatic"; search?: string; page: number; limit: number }) {
  const where: Prisma.BlocklistEntryWhereInput = {
    organizationId: orgId,
    ...(q.entryType ? { entryType: q.entryType } : {}),
    ...(q.origin ? { reason: q.origin === "automatic" ? { in: AUTOMATIC_REASONS } : { notIn: AUTOMATIC_REASONS } } : {}),
    ...(q.reason ? { reason: q.reason } : {}),
    ...(q.search ? { value: { contains: q.search.toLowerCase() } } : {}),
  };
  const [rows, total, byReason] = await Promise.all([
    prisma.blocklistEntry.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.limit, take: q.limit }),
    prisma.blocklistEntry.count({ where }),
    prisma.blocklistEntry.groupBy({ by: ["reason"], where: { organizationId: orgId }, _count: { _all: true } }),
  ]);
  const byOrigin = { you: 0, automatic: 0 };
  for (const r of byReason) byOrigin[originOf(r.reason)] += r._count._all;
  return { rows: rows.map((r) => ({ ...r, origin: originOf(r.reason) })), total, byReason: Object.fromEntries(byReason.map((r) => [r.reason, r._count._all])), byOrigin };
}

export async function add(orgId: string, input: { value: string; entryType: BlockEntryType; reason: BlockReason; note?: string }) {
  if (input.entryType === "EMAIL") {
    const { normalized } = normalizeEmail(input.value);
    if (!EMAIL_RE.test(normalized)) throw badRequest("Enter a valid email address");
    await blockEmail(orgId, normalized, input.reason, null, { emailOnly: true });
    if (input.note) await prisma.blocklistEntry.update({ where: { organizationId_entryType_value: { organizationId: orgId, entryType: "EMAIL", value: normalized } }, data: { note: input.note } });
    return { value: normalized, entryType: "EMAIL" as const, message: "Email added to the blocklist" };
  }
  const domain = extractDomain(input.value);
  if (!domain || !/\.[a-z]{2,}$/.test(domain)) throw badRequest("Enter a valid domain");
  if (isFreeMailDomain(domain)) throw unprocessable("Refusing to block a free-mail provider. Block the specific email instead.");
  await prisma.blocklistEntry.upsert({
    where: { organizationId_entryType_value: { organizationId: orgId, entryType: "DOMAIN", value: domain } },
    create: { organizationId: orgId, entryType: "DOMAIN", value: domain, reason: input.reason, note: input.note ?? null },
    update: { reason: input.reason, note: input.note ?? null },
  });
  const mid = await prisma.contact.findMany({
    where: { organizationId: orgId, OR: [{ companyDomain: domain }, { domain }], status: "CONTACTED" },
    select: { id: true },
  });
  await prisma.contact.updateMany({
    where: { organizationId: orgId, OR: [{ companyDomain: domain }, { domain }], status: { notIn: ["REPLIED", "UNSUBSCRIBED", "BOUNCED", "REJECTED"] } },
    data: { status: "BLOCKLISTED" },
  });
  await pauseInFlight(orgId, mid);
  return { value: domain, entryType: "DOMAIN" as const, message: "Domain added to the blocklist (whole company)" };
}

export async function remove(orgId: string, id: string) {
  const r = await prisma.blocklistEntry.deleteMany({ where: { id, organizationId: orgId } });
  if (!r.count) throw notFound("Blocklist entry");
  return { removed: true };
}

export async function restore(orgId: string, contactId: string) {
  const c = await prisma.contact.findFirst({ where: { id: contactId, organizationId: orgId } });
  if (!c) throw notFound("Lead");
  if (!["BLOCKLISTED", "BOUNCED", "UNSUBSCRIBED"].includes(c.status)) throw unprocessable(`This lead is ${c.status.toLowerCase()}; only blocklisted, bounced or unsubscribed leads can be restored.`);
  const complained = await prisma.blocklistEntry.findFirst({ where: { organizationId: orgId, entryType: "EMAIL", value: c.emailNormalized, reason: "COMPLAINED" } });
  if (complained) throw unprocessable("This address filed a spam complaint, so it can't be restored.");
  const domains = [...new Set([c.companyDomain, c.domain].filter((d): d is string => !!d).map((d) => d.toLowerCase()))];
  const kept = await prisma.$transaction(async (tx) => {
    await tx.blocklistEntry.deleteMany({ where: { organizationId: orgId, entryType: "EMAIL", value: c.emailNormalized } });
    if (domains.length) {
      await tx.blocklistEntry.deleteMany({
        where: { organizationId: orgId, entryType: "DOMAIN", value: { in: domains }, reason: { in: SOFT_RULE_REASONS }, OR: [{ contactId: null }, { contactId: c.id }] },
      });
    }
    const left = domains.length ? await tx.blocklistEntry.findMany({ where: { organizationId: orgId, entryType: "DOMAIN", value: { in: domains } }, select: { value: true, reason: true } }) : [];
    const wasPersonalized = c.personalizationStatus === "done" && !!c.personalization && !c.firstContactedAt;
    const status = c.firstContactedAt ? "CONTACTED" : wasPersonalized ? "PERSONALIZED" : "NEW";
    await tx.contact.update({
      where: { id: c.id },
      data: {
        status,
        personalizationStatus: status === "NEW" ? "pending" : c.personalizationStatus,
        fitScore: c.fitScore < 25 ? 60 : c.fitScore,
        tier: c.tier ?? "A",
        verifyResult: null,
        verifyQuality: null,
        verifiedAt: null,
        neverAuto: false,
      },
    });
    return { left, status };
  });
  const keptNote = kept.left.length
    ? ` The company-level rule stays (${kept.left.map((k) => `${k.value}: ${k.reason.toLowerCase()}`).join(", ")}) because it records an opt-out or a hard block.`
    : " Email and company domain unblocked.";
  return {
    contactId: c.id,
    status: kept.status,
    keptDomains: kept.left,
    message: `${c.fullName ?? c.email} restored to Leads.${keptNote}${(await verifierFor(orgId)) ? " The address is re-verified before any send." : ""}`,
  };
}

export async function importList(orgId: string, text: string, blockWholeCompany: boolean) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const parsed = lines.length > 1 ? parseLeadCsv(text) : null;
  const tabular = parsed && (parsed.mapped.length >= 2 || parsed.mapped.includes("email"));
  if (parsed && tabular) {
    let rules = 0;
    let records = 0;
    for (const lead of parsed.leads) {
      const site = extractDomain(lead.website);
      const emailDomain = lead.emailNormalized.split("@")[1] ?? null;
      const companyDomain = site && !SHARED_WEB_HOSTS.has(site) ? site : emailDomain && !isFreeMailDomain(emailDomain) ? emailDomain : null;
      const existing = await prisma.contact.findUnique({ where: { organizationId_emailNormalized: { organizationId: orgId, emailNormalized: lead.emailNormalized } }, select: { id: true } });
      if (!existing) {
        await prisma.contact.create({
          data: {
            organizationId: orgId,
            email: lead.email,
            emailNormalized: lead.emailNormalized,
            domain: emailDomain,
            companyDomain,
            firstName: lead.firstName,
            lastName: lead.lastName,
            fullName: lead.fullName,
            title: lead.title,
            company: lead.company,
            website: lead.website,
            phone: lead.phone,
            linkedinUrl: lead.linkedinUrl,
            location: lead.location,
            industry: lead.industry,
            source: "blocklist-import",
            status: "BLOCKLISTED",
            personalizationStatus: "skipped",
          },
        });
        records++;
      }
      await blockEmail(orgId, lead.emailNormalized, "MANUAL", existing?.id ?? null, { emailOnly: !blockWholeCompany });
      rules++;
    }
    return { mode: "leads", rules, records, message: `${rules} ${rules === 1 ? "person" : "people"} blocked${blockWholeCompany ? " along with their companies" : ""}. ${records} new records kept so they can be restored.` };
  }
  const { emails, domains } = parseEmailOrDomainList(text);
  if (!emails.length && !domains.length) throw badRequest("No emails or domains found");
  for (const e of emails) await blockEmail(orgId, e, "MANUAL", null, { emailOnly: true });
  const usable = domains.filter((d) => !isFreeMailDomain(d));
  if (usable.length) {
    await prisma.blocklistEntry.createMany({
      data: usable.map((value) => ({ organizationId: orgId, entryType: "DOMAIN" as const, value, reason: "MANUAL" as const })),
      skipDuplicates: true,
    });
    await prisma.contact.updateMany({
      where: { organizationId: orgId, OR: [{ companyDomain: { in: usable } }, { domain: { in: usable } }], status: { notIn: ["REPLIED", "UNSUBSCRIBED", "BOUNCED", "REJECTED"] } },
      data: { status: "BLOCKLISTED" },
    });
  }
  return { mode: "list", rules: emails.length + usable.length, records: 0, message: `${emails.length} emails and ${usable.length} domains added to the blocklist.` };
}
