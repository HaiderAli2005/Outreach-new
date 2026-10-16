import { prisma } from "../../lib/prisma.js";
import { isFreeMailDomain } from "../../lib/normalize.js";
import { releaseForContact } from "../credits/index.js";

/**
 * Ending a sequence. Once any of these happens the person gets no further sequence email, ever:
 *
 *   replied              they wrote back, anything at all, "not interested" included
 *   colleague_replied    anyone at the same company domain replied to any of this customer's sequences
 *   unsubscribed         the link, the one-click button, or a reply asking to be removed
 *   bounced              a hard bounce
 *   manual               the customer marked them done
 *   finished             all four emails went
 *
 * Campaign paused, balance at zero and a bounce pause only hold follow-ups back (see the pipeline); they resume
 * where they left off once the reason is gone.
 */
export type StopReason = "replied" | "colleague_replied" | "unsubscribed" | "bounced" | "complained" | "hostile" | "manual" | "finished";

export async function stopSequence(contactId: string, reason: StopReason): Promise<boolean> {
  const r = await prisma.contact.updateMany({ where: { id: contactId, sequenceStoppedAt: null }, data: { sequenceStoppedAt: new Date(), sequenceStopReason: reason, nextTouchAt: null } });
  if (r.count) await releaseForContact(contactId, reason === "finished" ? "Sequence finished" : `Sequence stopped (${reason.replace(/_/g, " ")})`);
  return r.count > 0;
}

/** The company part of an address for the colleague rule, or null for a free provider (gmail.com and similar). */
export function companyDomainOf(c: { domain?: string | null; emailNormalized?: string | null }): string | null {
  const d = (c.domain ?? c.emailNormalized?.split("@")[1] ?? "").toLowerCase();
  return d && !isFreeMailDomain(d) ? d : null;
}

/**
 * Someone at acme.com replied: every other acme.com person in this customer's running sequences stops, so the CTO
 * forwarding the thread never hears "it's still chasing me too" from two colleagues.
 */
export async function stopColleagues(orgId: string, replier: { id: string; domain?: string | null; emailNormalized?: string | null }): Promise<number> {
  const domain = companyDomainOf(replier);
  if (!domain) return 0;
  const others = await prisma.contact.findMany({
    where: { organizationId: orgId, id: { not: replier.id }, domain, sequenceStoppedAt: null, status: { in: ["CONTACTED", "QUEUED"] } },
    select: { id: true },
  });
  let n = 0;
  for (const o of others) if (await stopSequence(o.id, "colleague_replied")) n++;
  return n;
}

/** True when someone at this person's company already replied to this customer. */
export async function colleagueReplied(orgId: string, c: { id: string; domain?: string | null; emailNormalized?: string | null }): Promise<boolean> {
  const domain = companyDomainOf(c);
  if (!domain) return false;
  return !!(await prisma.contact.findFirst({ where: { organizationId: orgId, id: { not: c.id }, domain, repliedAt: { not: null } }, select: { id: true } }));
}
