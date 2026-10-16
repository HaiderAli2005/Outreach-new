import type { SendOutcome } from "./types.js";

/** The enhanced status code ("5.1.1") in an SMTP response, when the server sends one. */
export function enhancedCodeOf(text: string | null | undefined): string | null {
  const m = (text ?? "").match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** The three-digit reply code at the start of an SMTP response. */
export function smtpCodeOf(text: string | null | undefined, code?: number | null): string | null {
  if (code && code >= 200 && code < 600) return String(code);
  const m = (text ?? "").match(/^\s*([245]\d\d)\b/);
  return m ? m[1] : null;
}

const AUTH = new Set(["4.7.27", "4.7.30", "4.7.31", "5.7.26", "5.7.27", "5.7.30", "5.7.31"]);
const DOMAIN_BLOCK = new Set(["5.7.233", "5.1.8"]);

/**
 * How a receiving server's answer is read. Authentication failures are split out first: they mean OUR records are
 * broken, and counting them against the address or the customer would pause someone who did nothing wrong.
 */
export function classifySmtp(smtpCode: string | null, enhanced: string | null): SendOutcome {
  if (enhanced && AUTH.has(enhanced)) return "AUTH_FAILURE";
  if (enhanced && DOMAIN_BLOCK.has(enhanced)) return "DOMAIN_BLOCKED";
  if (enhanced === "4.7.28") return "RATE_LIMITED";
  const first = (enhanced ?? smtpCode ?? "")[0];
  if (first === "2") return "SENT";
  if (first === "4") return "SOFT_BOUNCE";
  if (first === "5") return "HARD_BOUNCE";
  return "TRANSPORT_ERROR";
}
