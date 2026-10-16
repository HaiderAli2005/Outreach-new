import { env } from "../../config/env.js";
import { hmac, safeEqual } from "../../lib/crypto.js";
import { prisma } from "../../lib/prisma.js";
import { blockEmail } from "../suppression.js";
import { releaseForContact } from "../credits/index.js";
import { discardDraft, markNeverAuto } from "../conversation.js";
import { stopSequence } from "./stop.js";
import { globalSuppress } from "./dedup.js";
import { logSystem } from "../systemLog.js";

/**
 * Every pool email carries a working unsubscribe link ON ITS OWN SENDING DOMAIN: https://<sending-domain>/u/<token>.
 * A link to a different domain than the sender reads as phishing. Each pool domain's web traffic is pointed at the
 * API, which answers /u/ for any host. The token names the person (and through them the customer) and is signed,
 * so nobody can unsubscribe someone else by guessing.
 */
export function unsubscribeToken(contactId: string): string {
  return `${Buffer.from(contactId).toString("base64url")}.${hmac(env.WEBHOOK_SECRET, `unsub:${contactId}`).slice(0, 32)}`;
}

export function contactFromToken(token: string): string | null {
  const [id64, sig] = token.split(".");
  if (!id64 || !sig) return null;
  let contactId: string;
  try {
    contactId = Buffer.from(id64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!/^[a-z0-9]{10,40}$/i.test(contactId)) return null;
  return safeEqual(sig, hmac(env.WEBHOOK_SECRET, `unsub:${contactId}`).slice(0, 32)) ? contactId : null;
}

export function unsubscribeUrl(contactId: string, sendingDomain: string): string {
  return `https://${sendingDomain.toLowerCase()}/u/${unsubscribeToken(contactId)}`;
}

/**
 * One click, no login, no confirmation step. The address goes on the customer's own list AND the global pool list,
 * and every queued email to it, for every customer, stops now. The domains are ours, so complaints come to us.
 */
export async function unsubscribeEverywhere(contactId: string, via: "link" | "one-click" | "mail", reason: "unsubscribe" | "complaint" = "unsubscribe"): Promise<boolean> {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return false;
  await globalSuppress(contact.emailNormalized, reason);
  await blockEmail(contact.organizationId, contact.emailNormalized, reason === "complaint" ? "COMPLAINED" : "UNSUBSCRIBED", contact.id, { emailOnly: true });
  await prisma.contact.update({ where: { id: contact.id }, data: { status: "UNSUBSCRIBED" } });
  await stopSequence(contact.id, reason === "complaint" ? "hostile" : "unsubscribed");
  await releaseForContact(contact.id, "Unsubscribed");
  await discardDraft(contact.organizationId, contact.id);
  await markNeverAuto(contact.organizationId, contact.id, "unsubscribed");
  // The same person in other customers' lists: stop them too. Their status leaves CONTACTED/PERSONALIZED, so no
  // first touch or follow-up goes out, and anything held for them goes back.
  const elsewhere = await prisma.contact.findMany({
    where: { emailNormalized: contact.emailNormalized, organizationId: { not: contact.organizationId }, status: { in: ["NEW", "PERSONALIZED", "QUEUED", "CONTACTED"] } },
    select: { id: true },
  });
  if (elsewhere.length) {
    await prisma.contact.updateMany({ where: { id: { in: elsewhere.map((c) => c.id) } }, data: { status: "BLOCKLISTED", nextTouchAt: null } });
    for (const c of elsewhere) await stopSequence(c.id, "unsubscribed");
  }
  await logSystem(contact.organizationId, "INFO", "sending", `Someone unsubscribed (${via}). They won't be emailed again by anyone.`, { contactId: contact.id });
  return true;
}
