import { env } from "../config/env.js";
import { fetchJson, HttpError } from "./http.js";

/**
 * The email-finding waterfall. Apollo goes first (it comes with the search), then each finder listed in
 * FINDER_WATERFALL in order, stopping at the first address that comes back verified. Which finder found each address
 * is stored on the person (contacts.email_source) and shown next to it, with its verification status.
 *
 * The customer is never charged for a search: finding is part of the first email's price, and someone we don't find
 * costs nothing.
 *
 * RESALE RIGHTS ARE A LEGAL CONSTRAINT. A finder may only be listed once its current terms are confirmed to allow
 * using its results inside a product we sell. Each integration records what was checked and when. A finder whose
 * permission is not confirmed is never called, whatever FINDER_WATERFALL says.
 */

export interface FoundEmail {
  email: string;
  /** The finder's own verification verdict, e.g. "valid". */
  status: string | null;
  source: string;
}

export interface FinderInput {
  fullName: string;
  firstName?: string | null;
  lastName?: string | null;
  domain: string;
}

export interface EmailFinder {
  readonly id: string;
  readonly resale: { confirmed: boolean; checkedOn: string; note: string };
  find(p: FinderInput): Promise<FoundEmail | null>;
}

/**
 * Apollo. Resale: NOT confirmed for the standard API. Checked 2026-10-09: Apollo's API terms limit use to the
 * customer's "internal business purposes" unless the account is on Apollo's official reseller/partner programme.
 * Confirm the account is on that programme before selling Apollo-sourced addresses inside Aperture.
 * (Apollo runs inside sourcing.ts, not through this list.)
 */
export const APOLLO_RESALE = { confirmed: false, checkedOn: "2026-10-09", note: "Standard API terms are internal use only; needs Apollo's reseller programme." } as const;

/**
 * Anymailfinder. POST https://api.anymailfinder.com/v5.1/find-email/person, Bearer key, { full_name, domain }.
 * Charged only when a valid email is returned. Resale: NOT YET CONFIRMED. Checked 2026-10-09: the public API page
 * says the API is for building finding "into your product", but the Terms of Service could not be read to confirm
 * resale inside a SaaS. Set `confirmed: true` here only after reading the current terms (and record the date).
 */
export class AnymailfinderFinder implements EmailFinder {
  readonly id = "anymailfinder";
  readonly resale = { confirmed: false, checkedOn: "2026-10-09", note: "Terms of Service not yet confirmed for resale inside a SaaS." };
  constructor(private readonly key: string) {}
  async find(p: FinderInput): Promise<FoundEmail | null> {
    try {
      const r = await fetchJson<{ email?: string | null; email_status?: string | null }>("https://api.anymailfinder.com/v5.1/find-email/person", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}` },
        body: { full_name: p.fullName, domain: p.domain },
        timeoutMs: 20_000,
        retries: 2,
      });
      if (!r?.email || (r.email_status && r.email_status !== "valid")) return null;
      return { email: r.email.toLowerCase(), status: r.email_status ?? null, source: this.id };
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 422)) return null;
      throw e;
    }
  }
}

let override: EmailFinder[] | null = null;
/** Tests replace the waterfall. */
export function setFinders(f: EmailFinder[] | null): void {
  override = f;
}

/** The finders after Apollo, in order, with any whose resale permission is unconfirmed left out. */
export function finderWaterfall(): EmailFinder[] {
  if (override) return override.filter((f) => f.resale.confirmed);
  const out: EmailFinder[] = [];
  for (const id of env.FINDER_WATERFALL.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (id === "anymailfinder" && env.ANYMAILFINDER_API_KEY) out.push(new AnymailfinderFinder(env.ANYMAILFINDER_API_KEY));
  }
  return out.filter((f) => f.resale.confirmed);
}

/** Runs the waterfall for one person. Stops at the first verified hit. */
export async function findEmail(p: FinderInput): Promise<FoundEmail | null> {
  for (const f of finderWaterfall()) {
    try {
      const hit = await f.find(p);
      if (hit) return hit;
    } catch {
      // One finder failing never stops the next one.
    }
  }
  return null;
}
