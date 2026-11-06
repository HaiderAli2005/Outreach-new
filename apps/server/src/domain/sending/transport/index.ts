import type { Mailbox } from "@prisma/client";
import { secretStore } from "../../../integrations/secrets.js";
import { accessTokenFor, parseGoogleSecret } from "../../../integrations/googleMail.js";
import { EmailEngineTransport } from "./emailengine.js";
import { SmtpTransport } from "./smtp.js";
import type { MailTransport, MailboxCreds } from "./types.js";

export type { MailTransport, MailboxCreds, OutboundMessage, SendResult, SendOutcome, InboundRaw } from "./types.js";

const registry = new Map<string, MailTransport>([
  ["smtp", new SmtpTransport()],
  ["emailengine", new EmailEngineTransport()],
]);

/** Tests swap in a fake transport for every mailbox. */
let override: MailTransport | null = null;
export function setTransport(t: MailTransport | null): void {
  override = t;
}

export const transportRefFor = (address: string, transport = "smtp") => `${transport}:${address}`;

/** The transport named by a mailbox's transport_ref ("smtp:name@domain.com"). */
export function transportFor(ref: string): MailTransport {
  if (override) return override;
  const id = ref.slice(0, ref.indexOf(":"));
  const t = registry.get(id);
  if (!t) throw new Error(`No mail transport called "${id}"`);
  return t;
}

/**
 * A mailbox's connection details, with the password fetched from the secret store, never from the database. A Google
 * mailbox's secret names how it signs in instead, and an access token is made for it here (integrations/googleMail.ts).
 */
export async function credsFor(m: Pick<Mailbox, "address" | "smtpHost" | "smtpPort" | "imapHost" | "imapPort" | "credentialRef">): Promise<MailboxCreds> {
  if (!m.smtpHost || !m.imapHost || !m.credentialRef) throw new Error(`${m.address} has no connection details yet`);
  const raw = await secretStore().get(m.credentialRef);
  if (!raw) throw new Error(`No stored password for ${m.address}`);
  const base = { address: m.address, smtpHost: m.smtpHost, smtpPort: m.smtpPort ?? 587, imapHost: m.imapHost, imapPort: m.imapPort ?? 993 };
  const google = parseGoogleSecret(raw);
  if (google) return { ...base, username: m.address, password: "", accessToken: await accessTokenFor(m.address, google) };
  // Stored as JSON so a username different from the address survives: {"u": "...", "p": "..."}.
  let username = m.address;
  let password = raw;
  try {
    const j = JSON.parse(raw) as { u?: string; p?: string };
    if (j.p) {
      password = j.p;
      username = j.u ?? m.address;
    }
  } catch {
    /* a bare password */
  }
  return { ...base, username, password };
}
