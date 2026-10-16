import { prisma } from "../lib/prisma.js";
import { isFreeMailDomain, normalizeEmail } from "../lib/normalize.js";

export interface Candidate {
  email: string;
  companyDomain?: string | null;
}

export type Normalized<T> = T & { _email: string; _normalized: string; _domains: string[] };

export interface Partition<T> {
  fresh: Normalized<T>[];
  duplicates: Normalized<T>[];
  blocked: Normalized<T>[];
  capped: Normalized<T>[];
}

const LIVE_STATUSES = ["NEW", "PERSONALIZED", "QUEUED", "CONTACTED", "REPLIED"] as const;

export async function partitionCandidates<T extends Candidate>(
  orgId: string,
  candidates: T[],
  opts: { skipCompanyCap?: boolean; perCompanyCap?: number } = {},
): Promise<Partition<T>> {
  const normed: Normalized<T>[] = candidates
    .map((c) => {
      const { email, normalized, domain } = normalizeEmail(c.email);
      const domains = [...new Set([c.companyDomain, domain].filter((d): d is string => !!d).map((d) => d.toLowerCase()))];
      return { ...c, _email: email, _normalized: normalized, _domains: domains };
    })
    .filter((c) => c._normalized.includes("@"));

  const out: Partition<T> = { fresh: [], duplicates: [], blocked: [], capped: [] };
  if (!normed.length) return out;

  const emails = [...new Set(normed.map((c) => c._normalized))];
  const domains = [...new Set(normed.flatMap((c) => c._domains))];

  const [existing, blockedEmails, blockedDomains] = await Promise.all([
    prisma.contact.findMany({ where: { organizationId: orgId, emailNormalized: { in: emails } }, select: { emailNormalized: true } }),
    prisma.blocklistEntry.findMany({ where: { organizationId: orgId, entryType: "EMAIL", value: { in: emails } }, select: { value: true } }),
    domains.length
      ? prisma.blocklistEntry.findMany({ where: { organizationId: orgId, entryType: "DOMAIN", value: { in: domains } }, select: { value: true } })
      : Promise.resolve([]),
  ]);
  const existingSet = new Set(existing.map((r) => r.emailNormalized));
  const blockedEmailSet = new Set(blockedEmails.map((r) => r.value));
  const blockedDomainSet = new Set(blockedDomains.map((r) => r.value).filter((d) => !isFreeMailDomain(d)));

  const seen = new Set<string>();
  const fresh: Normalized<T>[] = [];
  for (const c of normed) {
    if (seen.has(c._normalized)) {
      out.duplicates.push(c);
      continue;
    }
    seen.add(c._normalized);
    if (existingSet.has(c._normalized)) out.duplicates.push(c);
    else if (blockedEmailSet.has(c._normalized) || c._domains.some((d) => blockedDomainSet.has(d))) out.blocked.push(c);
    else fresh.push(c);
  }

  if (opts.skipCompanyCap || !fresh.length) {
    out.fresh = fresh;
    return out;
  }

  const cap = Math.max(1, opts.perCompanyCap ?? 2);
  const freshDomains = [...new Set(fresh.flatMap((c) => c._domains).filter((d) => !isFreeMailDomain(d)))];
  const live = new Map<string, number>();
  if (freshDomains.length) {
    const rows = await prisma.contact.groupBy({
      by: ["companyDomain"],
      where: { organizationId: orgId, companyDomain: { in: freshDomains }, status: { in: [...LIVE_STATUSES] } },
      _count: { _all: true },
    });
    for (const r of rows) if (r.companyDomain) live.set(r.companyDomain.toLowerCase(), r._count._all);
  }
  for (const c of fresh) {
    const dom = c._domains.find((d) => !isFreeMailDomain(d));
    if (!dom) {
      out.fresh.push(c);
      continue;
    }
    const n = live.get(dom) ?? 0;
    if (n >= cap) {
      out.capped.push(c);
      continue;
    }
    live.set(dom, n + 1);
    out.fresh.push(c);
  }
  return out;
}
