const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.se", "hotmail.co.uk", "outlook.com", "outlook.se",
  "live.com", "live.se", "msn.com", "yahoo.com", "yahoo.se", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com",
  "telia.com", "bredband.net", "comhem.se", "spray.se", "tele2.se", "web.de", "t-online.de", "orange.fr",
  "free.fr", "laposte.net", "libero.it", "btinternet.com", "sky.com", "virginmedia.com", "fastmail.com", "hey.com",
]);

export function isFreeMailDomain(domain: string | null | undefined): boolean {
  return !!domain && FREE_MAIL.has(domain.toLowerCase());
}

export interface NormalizedEmail {
  email: string;
  normalized: string;
  domain: string | null;
}

export function normalizeEmail(raw: string | null | undefined): NormalizedEmail {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email.includes("@")) return { email, normalized: email, domain: null };
  let [local, domain] = email.split("@") as [string, string];
  domain = (domain ?? "").trim();
  local = local.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return { email, normalized: `${local}@${domain}`, domain: domain || null };
}

export function extractDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (s.includes("@")) s = s.split("@")[1] ?? "";
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  return s || null;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain);
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function brandFromDomain(domain: string): string {
  const base = domain.split(".")[0] ?? domain;
  return base
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
