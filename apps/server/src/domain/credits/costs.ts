import type { DeciCents } from "../money.js";

/**
 * The only price list. Everything is in deci-cents (see domain/money.ts).
 *
 * Aperture charges for one thing: an email that actually went out, $0.04 whether it is the first email, a follow-up
 * or a reply. A reply carries the whole thread as context, so it is not cheaper to write than a cold email. Finding,
 * verifying and writing are included, and if we don't find someone's address nobody pays anything for the search.
 */
export const COSTS: Record<string, DeciCents> = {
  "email.sent": 40n, // every outbound cold email, first or follow-up
  "email.reply": 40n, // answering someone who answered you: the same flat price
  "lead.found": 0n, // included
  "lead.verified": 0n, // included
  "ai.research": 0n, // included
  "ai.write": 0n, // included
};

export type CostAction = keyof typeof COSTS;

/** What an action costs. Unknown actions cost an email, never zero by accident. */
export function costFor(action: string): DeciCents {
  return COSTS[action] ?? COSTS["email.sent"];
}
