import { clearPoolSettingsCache } from "../src/domain/pool/settings.js";
import { clearInboxKitCaches } from "../src/domain/pool/inboxkit/settings.js";
import request from "supertest";
import type { Express } from "express";
import type { MemberRole } from "@prisma/client";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient, type AiClient } from "../src/integrations/ai.js";
import { setTransport, type MailTransport, type MailboxCreds, type OutboundMessage, type SendResult } from "../src/domain/sending/transport/index.js";
import type { InboundRaw } from "../src/domain/sending/transport/types.js";
import { MemorySecretStore, mailboxCredentialRef, setSecretStore, secretStore } from "../src/integrations/secrets.js";
import { setNsResolver, setRegistrarLookup, setTxtResolver } from "../src/domain/pool/auth.js";
import { settleFirstRuns } from "../src/modules/onboarding/firstRun.js";
import { setApolloFactory } from "../src/integrations/apollo.js";
import { setVerifierFactory } from "../src/integrations/verifier.js";
import { setSiteLanguageReader } from "../src/integrations/site.js";
import { setSlackPoster } from "../src/integrations/slack.js";
import { setStripeClient } from "../src/modules/billing/stripe.client.js";
import { setSiteReader } from "../src/integrations/site.js";
import { setMailSender } from "../src/integrations/mailer.js";
import { hashPassword } from "../src/modules/auth/auth.service.js";
import { signAccessToken } from "../src/modules/auth/tokens.js";
import { features } from "../src/config/env.js";

let app: Express | null = null;
export function getApp(): Express {
  app ??= createApp();
  return app;
}

export const api = () => request(getApp());

const TABLES = [
  "analysis_events", "analysis_runs", "credit_ledger", "credit_reservations", "sends", "inbound_messages", "global_suppression", "prospect_contact_log", "customer_health", "domain_health_daily",
  "pool_metrics_daily", "pool_reorders", "Refund", "Payment", "WebhookEvent", "consent_records", "lead_status_vocab", "personas", "Message", "Contact", "Company",
  "WeeklyBatch", "Campaign", "BlocklistEntry", "SystemLog", "UsageCounter", "Mailbox", "SendingDomain", "Onboarding", "IntegrationCredential",
  "OrgSettings", "Membership", "Organization", "RefreshToken", "OAuthAccount", "EmailChallenge", "User", "PoolSettings", "ai_usage", "CostSettings",
  "SupplierOrderItem", "SupplierOrder", "InboxKitSettings", "MapsPlace",
];

export async function resetDb(): Promise<void> {
  // Background work from the previous test (a launch's first run) finishes before its rows are wiped.
  await settleFirstRuns();
  // No test reads a real website for a prospect's language; a test that needs one sets its own reader.
  setSiteLanguageReader(async () => null);
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
  setAiClient(null);
  transport = new FakeTransport();
  setTransport(transport);
  setSecretStore(new MemorySecretStore());
  setTxtResolver(async () => []);
  setNsResolver(async () => []);
  setRegistrarLookup(async () => null);
  setApolloFactory(async () => null);
  setVerifierFactory(async () => null);
  setSlackPoster(async () => true);
  setStripeClient(undefined);
  setSiteReader(async () => ({ home: null, pages: [] }));
  clearPoolSettingsCache();
  clearInboxKitCaches();
  setMailSender(null);
  features.analysisStream = false;
  features.accurateCompanyCount = false;
}

export interface TestTenant {
  orgId: string;
  userId: string;
  email: string;
  token: string;
  auth: { Authorization: string };
}

let seq = 0;
/** $100 of credit, the default a funded test tenant starts with. */
export const TEST_BALANCE = 100_000n;

/** Puts money on a workspace the way the free trial does: one BONUS ledger row. */
export async function fund(orgId: string, amount: bigint = TEST_BALANCE, ref = `test:${orgId}:${seq++}`) {
  const last = await prisma.creditLedger.findFirst({ where: { organizationId: orgId }, orderBy: { seq: "desc" }, select: { balanceAfter: true } });
  return prisma.creditLedger.create({ data: { organizationId: orgId, kind: "BONUS", amount, balanceAfter: (last?.balanceAfter ?? 0n) + amount, stripeRef: ref, note: "test funding" } });
}

/**
 * `subscribed: false` (the old name, kept so tests read the same) or `funded: false` makes an unfunded workspace.
 * A test tenant has consent on record and its first batch approved, unless `consent` / `approved` say otherwise.
 */
export async function createTenant(opts: { role?: MemberRole; subscribed?: boolean; funded?: boolean; balance?: bigint; email?: string; consent?: boolean; approved?: boolean } = {}): Promise<TestTenant> {
  seq++;
  const email = opts.email ?? `user${seq}-${Date.now()}@example.com`;
  const user = await prisma.user.create({ data: { email, name: `User ${seq}`, passwordHash: await hashPassword("correct-horse-1") } });
  const org = await prisma.organization.create({ data: { name: `Org ${seq}`, primaryDomain: `org${seq}.com` } });
  await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, role: opts.role ?? "OWNER" } });
  await prisma.orgSettings.create({ data: { organizationId: org.id, senderCompany: `Org ${seq}`, timezone: "UTC", meetingLink: "https://cal.com/test/intro", firstBatchApprovedAt: opts.approved === false ? null : new Date() } });
  if (opts.consent !== false) await prisma.consentRecord.create({ data: { organizationId: org.id, userId: user.id, text: "test consent", ip: "127.0.0.1" } });
  if (opts.subscribed !== false && opts.funded !== false) await fund(org.id, opts.balance ?? TEST_BALANCE);
  const token = signAccessToken({ sub: user.id, org: org.id, role: opts.role ?? "OWNER", pa: false });
  return { orgId: org.id, userId: user.id, email, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function addMember(tenant: TestTenant, role: MemberRole): Promise<TestTenant> {
  seq++;
  const email = `member${seq}-${Date.now()}@example.com`;
  const user = await prisma.user.create({ data: { email, name: `Member ${seq}`, passwordHash: await hashPassword("correct-horse-1") } });
  await prisma.membership.create({ data: { organizationId: tenant.orgId, userId: user.id, role } });
  const token = signAccessToken({ sub: user.id, org: tenant.orgId, role, pa: false });
  return { orgId: tenant.orgId, userId: user.id, email, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function makeCampaign(orgId: string, data: Partial<{ name: string; status: "ACTIVE" | "PAUSED" | "DRAFT" }> = {}) {
  return prisma.campaign.create({ data: { organizationId: orgId, name: data.name ?? "Campaign", status: data.status ?? "ACTIVE" } });
}

export async function makeContact(orgId: string, data: Record<string, unknown> = {}) {
  seq++;
  const email = (data.email as string) ?? `lead${seq}@company${seq}.com`;
  return prisma.contact.create({
    data: {
      organizationId: orgId,
      email,
      emailNormalized: email.toLowerCase(),
      domain: email.split("@")[1],
      companyDomain: email.split("@")[1],
      firstName: "Lead",
      fullName: `Lead ${seq}`,
      company: `Company ${seq}`,
      fitScore: 60,
      tier: "A",
      ...data,
    } as never,
  });
}

export function fakeAi(json: Record<string, unknown> | ((prompt: string) => Record<string, unknown> | null)): AiClient {
  return {
    async generateJSON<T>(prompt: string) {
      return (typeof json === "function" ? json(prompt) : json) as T;
    },
    async generateText() {
      return "text";
    },
  };
}

/**
 * Stands in for SMTP and IMAP. Every send is recorded; `respond` decides what the "receiving server" says (accepted
 * by default); `inbox` holds raw messages a mailbox will see on its next IMAP poll.
 */
export class FakeTransport implements MailTransport {
  readonly id = "smtp";
  sent: { from: string; message: OutboundMessage }[] = [];
  respond: (m: OutboundMessage, attempt: number) => SendResult = () => ({ outcome: "SENT", smtpCode: "250", enhancedCode: "2.0.0", response: "250 2.0.0 OK" });
  inbox = new Map<string, InboundRaw[]>();
  private uid = 100;
  async send(c: MailboxCreds, m: OutboundMessage): Promise<SendResult> {
    this.sent.push({ from: c.address, message: m });
    return this.respond(m, this.sent.filter((x) => x.message.messageId === m.messageId).length);
  }
  async fetchNew(c: MailboxCreds, sinceUid = 0): Promise<InboundRaw[]> {
    return (this.inbox.get(c.address) ?? []).filter((x) => x.uid > sinceUid);
  }
  /** Set to false to make every SMTP and IMAP sign-in fail. */
  signInOk = true;
  async verify(): Promise<{ smtp: boolean; imap: boolean; error?: string }> {
    return this.signInOk ? { smtp: true, imap: true } : { smtp: false, imap: false, error: "535 Authentication failed" };
  }
  /** Puts a raw RFC 5322 message in a mailbox's inbox. */
  deliver(address: string, raw: string): number {
    const uid = ++this.uid;
    this.inbox.set(address, [...(this.inbox.get(address) ?? []), { uid, source: Buffer.from(raw.replace(/\r?\n/g, "\r\n")) }]);
    return uid;
  }
}

/** The fake mail transport for the current test (reset by resetDb). */
export let transport = new FakeTransport();

/** SMTP refusal helper: what a receiving server says. */
export const reply = (code: string, enhanced: string | null, outcome: SendResult["outcome"]): SendResult => ({ outcome, smtpCode: code, enhancedCode: enhanced, response: `${code} ${enhanced ?? ""} test`.trim() });

let poolSeq = 0;
/**
 * One mailbox in the shared pool (no owner), on its own neutral domain unless one is given. Connected (password in
 * the secret store), its domain authenticated, and ready to take today's first touches up to `cap`.
 */
export async function makePoolMailbox(opts: { region?: string; cap?: number; status?: "WARMING" | "ACTIVE" | "REPLIES_ONLY" | "RETIRED"; domainStatus?: "AGING" | "WARMING" | "ACTIVE" | "DEGRADED" | "RETIRED"; domainId?: string; authOk?: boolean; warmupDay?: number } = {}) {
  poolSeq++;
  const auth = opts.authOk ?? true;
  const domain = opts.domainId
    ? await prisma.sendingDomain.findUniqueOrThrow({ where: { id: opts.domainId } })
    : await prisma.sendingDomain.create({ data: { organizationId: null, name: `neutral${poolSeq}x${Date.now() % 100000}.com`, status: opts.domainStatus ?? "ACTIVE", region: opts.region ?? "global", priceCents: 1200, spfOk: auth, dkimOk: auth, dmarcOk: auth } });
  const address = `sam${poolSeq}@${domain.name}`;
  const m = await prisma.mailbox.create({
    data: {
      organizationId: null,
      sendingDomainId: domain.id,
      address,
      transportRef: `smtp:${address}`,
      smtpHost: "smtp.test",
      smtpPort: 587,
      imapHost: "imap.test",
      imapPort: 993,
      status: opts.status ?? "ACTIVE",
      sendCapToday: opts.cap ?? 30,
      warmupDay: opts.warmupDay ?? 30,
    },
  });
  const ref = mailboxCredentialRef(m.id);
  await secretStore().put(ref, "test-password");
  return prisma.mailbox.update({ where: { id: m.id }, data: { credentialRef: ref } });
}

/** Pool capacity of at least `emails` a day: full warm domains of one mailbox each at the domain's daily cap. */
export async function makeCapacity(emails: number) {
  for (let left = emails; left > 0; left -= 90) await makePoolMailbox({ cap: 90 });
}

/** A first email that passes every rule: 90 to 130 words, one question at the end, no link, no unsupported claim. */
export const GOOD_FIRST_TOUCH = `Hi Lead,

I saw your team publishes a steady stream of reports and client updates every week. With a small team covering several markets, that is a lot of material to read before anything useful comes out of it.

I'm {{sender_first_name}} from our company. We build a summarizer that reads documents, videos and posts and pulls out the parts that matter, so the useful bits surface quickly for everyone.

Happy to put together a short example made for your team, with no obligation either way and nothing to install.

Would it be useful if I sent it over?`;

/** A contact ready for a first touch: written, verified today, with a subject and four emails. */
export function sendable(campaignId: string, extra: Record<string, unknown> = {}) {
  return {
    campaignId,
    status: "PERSONALIZED",
    messageSubject: "Research content volume",
    personalization: GOOD_FIRST_TOUCH,
    followup2: "A short follow-up on my note. The example would take a couple of minutes to read. Worth sending?",
    followup3: "One more thought: the example is made for your team, so it is quick to judge whether it fits.",
    followup4: "I'll leave it here so I don't crowd your inbox. Reply any time if the timing is better later.",
    verifyResult: "ok",
    verifiedAt: new Date(),
    approvedAt: new Date(),
    approvalSource: "review",
    ...extra,
  };
}
