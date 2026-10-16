import { beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, createTenant, makeCampaign, makeContact, makePoolMailbox, reply, resetDb, sendable, transport } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { secretStore } from "../src/integrations/secrets.js";
import { sendFirstTouch, sendFollowUp } from "../src/domain/sending/pipeline.js";
import { pickMailbox } from "../src/domain/sending/pool.js";
import { pollMailboxes, retrySoftBounces } from "../src/domain/sending/jobs.js";
import { unsubscribeUrl } from "../src/domain/sending/unsubscribe.js";
import { EmailEngineTransport } from "../src/domain/sending/transport/emailengine.js";
import { recomputeCustomerHealth } from "../src/domain/sending/health.js";
import { advanceWarmup, capForWarmupDay, evaluateDomainHealth } from "../src/domain/pool/lifecycle.js";
import { setTxtResolver, verifyDomainDns } from "../src/domain/pool/auth.js";

/**
 * Acceptance tests for our own sending engine (spec 2): SMTP out, IMAP in, no third-party sender.
 * The transport is the fake one from helpers: it records every message and answers like a receiving server.
 */

const domainOf = (address: string) => address.split("@")[1];

/** A tenant with one campaign and one ready-to-send person. */
async function oneSend(email?: string) {
  const t = await createTenant();
  const campaign = await makeCampaign(t.orgId);
  const p = await makeContact(t.orgId, sendable(campaign.id, email ? { email, emailNormalized: email } : {}));
  return { t, campaign, p };
}

function raw(lines: string[]): string {
  return lines.join("\n");
}

describe("outbound headers", () => {
  beforeEach(resetDb);

  it("puts the Message-ID on the From domain, sends plain text only, and carries one-click unsubscribe", async () => {
    const m = await makePoolMailbox();
    const { t, campaign, p } = await oneSend();
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: true });
    const out = transport.sent[0].message;
    const domain = domainOf(m.address);
    expect(out.from.address).toBe(m.address);
    expect(out.messageId).toMatch(new RegExp(`^<[^@>]+@${domain.replace(/\./g, "\\.")}>$`));
    expect(out).not.toHaveProperty("html");
    expect(out.headers["List-Unsubscribe"]).toMatch(new RegExp(`^<https://${domain.replace(/\./g, "\\.")}/u/[\\w.-]+>`));
    expect(out.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // No link anywhere in a first email; the follow-ups carry the unsubscribe link on the sending domain.
    expect(out.text).not.toMatch(/https?:\/\//);
    expect(out.text).toMatch(/Best,\n\w+/);
    const send = await prisma.send.findFirstOrThrow({ where: { contactId: p.id } });
    expect(send).toMatchObject({ messageId: out.messageId, status: "SENT", smtpCode: "250" });
  });

  it("threads follow-ups under the first email with In-Reply-To and References", async () => {
    await makePoolMailbox();
    const { t, campaign, p } = await oneSend();
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    const first = transport.sent[0].message;
    expect((await sendFollowUp(t.orgId, p.id, campaign.id, 2)).ok).toBe(true);
    const second = transport.sent[1].message;
    expect(second.inReplyTo).toBe(first.messageId);
    expect(second.references).toEqual([first.messageId]);
    expect(second.subject).toBe(`Re: ${first.subject}`);
    expect((await sendFollowUp(t.orgId, p.id, campaign.id, 3)).ok).toBe(true);
    const third = transport.sent[2].message;
    expect(third.inReplyTo).toBe(second.messageId);
    expect(third.references).toEqual([first.messageId, second.messageId]);
    // All three from the pinned mailbox.
    expect(new Set(transport.sent.map((s) => s.from)).size).toBe(1);
  });
});

describe("SMTP outcomes", () => {
  beforeEach(resetDb);

  it("treats 5xx as a hard bounce: never retried, address suppressed everywhere", async () => {
    await makePoolMailbox();
    const { t, campaign, p } = await oneSend();
    transport.respond = () => reply("550", "5.1.1", "HARD_BOUNCE");
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    const send = await prisma.send.findFirstOrThrow({ where: { contactId: p.id } });
    expect(send).toMatchObject({ status: "HARD_BOUNCE", enhancedCode: "5.1.1", nextRetryAt: null, retryCount: 0 });
    await prisma.send.updateMany({ data: { nextRetryAt: new Date(0) } });
    expect((await retrySoftBounces()).retried).toBe(0);
    expect(transport.sent).toHaveLength(1);
    expect(await prisma.globalSuppression.count()).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("BOUNCED");
  });

  it("retries a 4xx three times over the day and counts it against nothing", async () => {
    const m = await makePoolMailbox();
    const { t, campaign, p } = await oneSend();
    transport.respond = () => reply("451", "4.2.2", "SOFT_BOUNCE");
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    let send = await prisma.send.findFirstOrThrow({ where: { contactId: p.id } });
    expect(send.status).toBe("SOFT_BOUNCE");
    expect(send.nextRetryAt!.getTime() - send.sentAt.getTime()).toBe(15 * 60_000);
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      await prisma.send.update({ where: { id: send.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } });
      await retrySoftBounces();
      send = await prisma.send.findUniqueOrThrow({ where: { id: send.id } });
      if (send.nextRetryAt) gaps.push(send.nextRetryAt.getTime() - send.sentAt.getTime());
    }
    // One first attempt and three retries: 15 minutes, 2 hours, 12 hours.
    expect(transport.sent).toHaveLength(4);
    expect((await retrySoftBounces()).retried).toBe(0);
    expect(gaps).toEqual([2 * 3_600_000, 12 * 3_600_000]);
    expect(send).toMatchObject({ status: "SOFT_BOUNCE", retryCount: 3, nextRetryAt: null });
    // Same Message-ID every time: one email, several attempts.
    expect(new Set(transport.sent.map((s) => s.message.messageId)).size).toBe(1);
    expect(await prisma.globalSuppression.count()).toBe(0);
    expect((await recomputeCustomerHealth(t.orgId)).status).toBe("OK");
    expect(await prisma.domainHealthDaily.aggregate({ where: { domainId: m.sendingDomainId! }, _sum: { hardBounces: true } })).toMatchObject({ _sum: { hardBounces: null } });
  });

  it.each([["4.7.27"], ["4.7.30"]])("pauses the domain on %s, alerts an operator, and leaves the customer untouched", async (code) => {
    const a = await makePoolMailbox();
    const b = await makePoolMailbox();
    const { t, campaign, p } = await oneSend();
    transport.respond = (_m, _n) => (transport.sent.length === 1 ? reply("451", code, "AUTH_FAILURE") : reply("250", "2.0.0", "SENT"));
    const r = await sendFirstTouch(t.orgId, p.id, campaign.id);
    // Rerouted once to the other domain and sent from there.
    expect(r).toMatchObject({ ok: true });
    const sends = await prisma.send.findMany({ where: { contactId: p.id }, orderBy: { sentAt: "asc" } });
    expect(sends.map((s) => s.status)).toEqual(["AUTH_FAILURE", "SENT"]);
    const failed = sends[0].mailboxId === a.id ? a : b;
    expect(sends[1].reroutedFromId).toBe(failed.id);
    const domain = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: failed.sendingDomainId! } });
    expect(domain.pausedAt).not.toBeNull();
    expect(await prisma.systemLog.count({ where: { level: "CRITICAL", message: { contains: "paused" } } })).toBe(1);
    const h = await recomputeCustomerHealth(t.orgId);
    expect(h.status).toBe("OK");
    expect(await prisma.globalSuppression.count()).toBe(0);
    // An operator resumes it from /admin/pool.
    const admin = await createTenant();
    await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformAdmin: true } });
    await api().post(`/api/v1/admin/pool/domains/${domain.id}/resume`).set(admin.auth).send({ reason: "DKIM record fixed" }).expect(200);
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: domain.id } })).pausedAt).toBeNull();
  });
});

describe("inbound over IMAP", () => {
  beforeEach(resetDb);

  async function sentOne() {
    const m = await makePoolMailbox();
    const { t, campaign, p } = await oneSend();
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    const send = await prisma.send.findFirstOrThrow({ where: { contactId: p.id } });
    return { m, t, campaign, p, send };
  }

  it("matches a DSN by our original Message-ID and classifies it by its Status field", async () => {
    const { m, p, send } = await sentOne();
    transport.deliver(
      m.address,
      raw([
        "From: Mail Delivery System <MAILER-DAEMON@mx.company.com>",
        `To: ${m.address}`,
        "Subject: Undelivered Mail Returned to Sender",
        "Message-ID: <dsn1@mx.company.com>",
        'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "Your message could not be delivered.",
        "--b1",
        "Content-Type: message/delivery-status",
        "",
        "Reporting-MTA: dns; mx.company.com",
        "",
        `Final-Recipient: rfc822; ${p.email}`,
        "Action: failed",
        "Status: 5.1.1",
        "Diagnostic-Code: smtp; 550 5.1.1 user unknown",
        "--b1",
        "Content-Type: text/rfc822-headers",
        "",
        `From: ${m.address}`,
        `To: ${p.email}`,
        `Message-ID: ${send.messageId}`,
        "Subject: Quick question",
        "--b1--",
      ]),
    );
    await pollMailboxes();
    expect(await prisma.send.findUniqueOrThrow({ where: { id: send.id } })).toMatchObject({ status: "HARD_BOUNCE", bounceCode: "5.1.1", bounceParse: "dsn" });
    expect(await prisma.inboundMessage.findFirstOrThrow()).toMatchObject({ kind: "bounce", matchedSendId: send.id });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("BOUNCED");
    // The last seen UID is kept: the same message is never read twice.
    expect(Number((await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).lastImapUid)).toBeGreaterThan(0);
    await prisma.mailbox.update({ where: { id: m.id }, data: { lastPolledAt: null } });
    await pollMailboxes();
    expect(await prisma.inboundMessage.count()).toBe(1);
  });

  it("records an out-of-office as an auto-reply and the sequence carries on", async () => {
    const { m, p, send } = await sentOne();
    transport.deliver(m.address, raw([`From: ${p.email}`, `To: ${m.address}`, `Subject: Automatic reply: ${send.subject}`, "Auto-Submitted: auto-replied", `In-Reply-To: ${send.messageId}`, "Message-ID: <ooo1@company.com>", "", "I am out of the office until Monday."]));
    await pollMailboxes();
    expect(await prisma.inboundMessage.findFirstOrThrow()).toMatchObject({ kind: "auto_reply", matchedSendId: send.id });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("CONTACTED");
    expect(await prisma.message.count({ where: { contactId: p.id, direction: "INBOUND" } })).toBe(0);
  });

  it("stops the sequence on a human reply within one poll, matched by References when In-Reply-To is missing", async () => {
    const { m, t, campaign, p, send } = await sentOne();
    transport.deliver(m.address, raw([`From: ${p.email}`, `To: ${m.address}`, `Subject: Re: ${send.subject}`, `References: <other@x.com> ${send.messageId}`, "Message-ID: <h1@company.com>", "", "Yes, send me more."]));
    await pollMailboxes();
    expect(await prisma.inboundMessage.findFirstOrThrow()).toMatchObject({ kind: "human_reply", matchedSendId: send.id });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("REPLIED");
    // No follow-up goes to someone who replied.
    expect((await sendFollowUp(t.orgId, p.id, campaign.id, 2)).ok).toBe(false);
  });

  it("puts a message it can't match in the unmatched queue for an operator", async () => {
    const { m } = await sentOne();
    transport.deliver(m.address, raw(["From: stranger@else.com", `To: ${m.address}`, "Subject: Hello", "Message-ID: <s1@else.com>", "", "Who is this?"]));
    await pollMailboxes();
    expect(await prisma.inboundMessage.findFirstOrThrow()).toMatchObject({ kind: "unmatched", matchedSendId: null });
  });
});

describe("unsubscribe and dedup across customers", () => {
  beforeEach(resetDb);

  it("one-click unsubscribe suppresses pool-wide and cancels the same person queued by another customer", async () => {
    const m = await makePoolMailbox();
    const { t, campaign, p } = await oneSend("ann@acme.com");
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    const other = await createTenant();
    const otherCampaign = await makeCampaign(other.orgId);
    const queued = await makeContact(other.orgId, sendable(otherCampaign.id, { email: "ann@acme.com", emailNormalized: "ann@acme.com" }));
    const path = new URL(unsubscribeUrl(p.id, domainOf(m.address))).pathname;
    await api().post(path).expect(200);
    expect(await prisma.globalSuppression.count()).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: queued.id } })).sequenceStoppedAt).not.toBeNull();
    await prisma.contact.update({ where: { id: queued.id }, data: { status: "PERSONALIZED", sequenceStoppedAt: null } });
    expect(await sendFirstTouch(other.orgId, queued.id, otherCampaign.id)).toMatchObject({ ok: false, code: "SUPPRESSED" });
  });

  it("never lets two customers email the same address within 90 days", async () => {
    await makePoolMailbox();
    await makePoolMailbox();
    const { t, campaign, p } = await oneSend("bob@acme.com");
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: true });
    expect(await prisma.prospectContactLog.count()).toBe(1);
    const log = await prisma.prospectContactLog.findFirstOrThrow();
    expect(log.emailHash).not.toContain("bob");
    const other = await createTenant();
    const c2 = await makeCampaign(other.orgId);
    const same = await makeContact(other.orgId, sendable(c2.id, { email: "bob@acme.com", emailNormalized: "bob@acme.com" }));
    expect(await sendFirstTouch(other.orgId, same.id, c2.id)).toMatchObject({ ok: false, code: "RECENTLY_CONTACTED" });
    // After 90 days they may, but never from the mailbox the first customer used.
    await prisma.prospectContactLog.updateMany({ data: { contactedAt: new Date(Date.now() - 91 * 86_400_000) } });
    const r = await sendFirstTouch(other.orgId, same.id, c2.id);
    expect(r).toMatchObject({ ok: true });
    expect((r as { mailboxId: string }).mailboxId).not.toBe(log.mailboxId);
  });
});

describe("router", () => {
  beforeEach(resetDb);

  /** n domains with one mailbox each, created in bulk. */
  async function domains(n: number, capPerMailbox: number) {
    const stamp = Date.now() % 100000;
    await prisma.sendingDomain.createMany({ data: Array.from({ length: n }, (_, i) => ({ organizationId: null, name: `r${i}x${stamp}.com`, status: "ACTIVE" as const, region: "global", priceCents: 1200, spfOk: true, dkimOk: true, dmarcOk: true })) });
    const ds = await prisma.sendingDomain.findMany({ where: { name: { endsWith: `x${stamp}.com` } } });
    await prisma.mailbox.createMany({
      data: ds.map((d) => ({ organizationId: null, sendingDomainId: d.id, address: `sam@${d.name}`, transportRef: `smtp:sam@${d.name}`, smtpHost: "smtp.test", imapHost: "imap.test", status: "ACTIVE" as const, sendCapToday: capPerMailbox, warmupDay: 30, credentialRef: `mailbox:${d.id}` })),
    });
    return ds;
  }

  /** One customer's 560 first touches in a day, recorded as the pipeline would. */
  async function route(orgId: string, contactId: string, count: number) {
    const per = new Map<string, number>();
    for (let i = 0; i < count; i++) {
      const pick = await pickMailbox(orgId, "global");
      if (!pick) break;
      await prisma.send.create({ data: { organizationId: orgId, contactId, mailboxId: pick.mailboxId, domainId: pick.domainId, isFirstTouch: true, step: 1, status: "SENT", sentAt: new Date(Date.now() + i) } });
      per.set(pick.domainId, (per.get(pick.domainId) ?? 0) + 1);
    }
    return [...per.values()];
  }

  it("spreads one customer to about 80 a domain on 7 domains and about 3 on 190, never over 90", async () => {
    const t = await createTenant();
    const c = await makeContact(t.orgId);
    await domains(7, 90);
    const seven = await route(t.orgId, c.id, 560);
    expect(seven).toHaveLength(7);
    expect(seven.reduce((a, b) => a + b, 0)).toBe(560);
    expect(Math.max(...seven)).toBeLessThanOrEqual(90);
    expect(Math.min(...seven)).toBeGreaterThanOrEqual(75);

    await resetDb();
    const t2 = await createTenant();
    const c2 = await makeContact(t2.orgId);
    await domains(190, 30);
    const many = await route(t2.orgId, c2.id, 560);
    expect(many.reduce((a, b) => a + b, 0)).toBe(560);
    expect(many.length).toBeGreaterThanOrEqual(186);
    expect(Math.max(...many)).toBeLessThanOrEqual(4);
  }, 120_000);

  it("stops a domain at 90 a day across every customer", async () => {
    await domains(1, 200);
    let picked = 0;
    for (let k = 0; k < 2; k++) {
      const t = await createTenant();
      const c = await makeContact(t.orgId);
      picked += (await route(t.orgId, c.id, 60)).reduce((a, b) => a + b, 0);
    }
    expect(picked).toBe(90);
  });
});

describe("warmup and authentication", () => {
  beforeEach(resetDb);

  it("lets a day-3 warming mailbox take exactly 5 new people and refuses the 6th", async () => {
    await makePoolMailbox({ status: "WARMING", domainStatus: "WARMING", warmupDay: 3, cap: capForWarmupDay(3) });
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const results = [];
    for (let i = 0; i < 6; i++) {
      const p = await makeContact(t.orgId, sendable(campaign.id));
      results.push(await sendFirstTouch(t.orgId, p.id, campaign.id));
    }
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results[5]).toMatchObject({ ok: false, code: "NO_CAPACITY" });
  });

  it("holds warmup_day at 4% bounces over the last 50", async () => {
    const m = await makePoolMailbox({ status: "WARMING", domainStatus: "WARMING", warmupDay: 10, cap: capForWarmupDay(10) });
    const t = await createTenant();
    const c = await makeContact(t.orgId, { status: "CONTACTED" });
    await prisma.send.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ organizationId: t.orgId, contactId: c.id, mailboxId: m.id, domainId: m.sendingDomainId, isFirstTouch: true, step: 1, status: i < 2 ? ("HARD_BOUNCE" as const) : ("SENT" as const), sentAt: new Date(Date.now() - (50 - i) * 60_000) })) });
    await advanceWarmup();
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).warmupDay).toBe(10);
  });

  it("keeps a domain in WARMING until its own DKIM passes the seed test", async () => {
    const m = await makePoolMailbox({ status: "ACTIVE", domainStatus: "WARMING" });
    await evaluateDomainHealth();
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: m.sendingDomainId! } })).status).toBe("WARMING");
    await prisma.sendingDomain.update({ where: { id: m.sendingDomainId! }, data: { dkimVerifiedAt: new Date() } });
    await evaluateDomainHealth();
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: m.sendingDomainId! } })).status).toBe("ACTIVE");
  });

  it("degrades an ACTIVE domain whose DKIM record disappears", async () => {
    const m = await makePoolMailbox();
    const d = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: m.sendingDomainId! } });
    setTxtResolver(async (name) => (name === d.name ? [["v=spf1 include:_spf.test ~all"]] : name === `_dmarc.${d.name}` ? [["v=DMARC1; p=none"]] : []));
    await verifyDomainDns();
    expect(await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "DEGRADED", dkimOk: false, spfOk: true, dmarcOk: true });
  });
});

describe("internal outreach", () => {
  beforeEach(resetDb);

  it("sends for an internal organization without billing it, even with credit on the account", async () => {
    await makePoolMailbox();
    const { t, campaign, p } = await oneSend();
    await prisma.organization.update({ where: { id: t.orgId }, data: { kind: "INTERNAL" } });
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: true });
    expect(await prisma.creditLedger.count({ where: { organizationId: t.orgId, kind: "CHARGE" } })).toBe(0);
    expect((await prisma.send.findFirstOrThrow({ where: { contactId: p.id } })).priceCharged).toBe(0n);
  });
});

describe("transport and secrets", () => {
  beforeEach(resetDb);

  it("keeps mailbox passwords out of the database and the admin API", async () => {
    const m = await makePoolMailbox();
    expect(m.credentialRef).toBe(`mailbox:${m.id}`);
    expect(await secretStore().get(m.credentialRef!)).toBe("test-password");
    expect(JSON.stringify(await prisma.mailbox.findMany())).not.toContain("test-password");
    const admin = await createTenant();
    await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformAdmin: true } });
    const pool = await api().get("/api/v1/admin/pool").set(admin.auth);
    expect(pool.status).toBe(200);
    expect(JSON.stringify(pool.body)).not.toContain("test-password");
  });

  it("has an EmailEngine transport that is a stub until it is bought", async () => {
    const e = new EmailEngineTransport();
    const creds = { address: "a@b.com", username: "a@b.com", password: "x", smtpHost: "h", smtpPort: 587, imapHost: "h", imapPort: 993 };
    await expect(e.send(creds, { from: { name: "A", address: "a@b.com" }, to: "c@d.com", subject: "s", text: "t", messageId: "<1@b.com>", date: new Date(), headers: {} })).rejects.toThrow(/not implemented/);
    await expect(e.fetchNew(creds, 0)).rejects.toThrow(/not implemented/);
  });

  it("has no trace of the old third-party sender left in the apps", () => {
    const name = ["smart", "lead"].join("");
    const root = join(__dirname, "../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        if (["node_modules", "migrations", ".next", "dist", "coverage", ".turbo"].includes(f)) continue;
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs|json|md|css|prisma|sql|sh|example)$/.test(f) && readFileSync(p, "utf8").toLowerCase().includes(name)) hits.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
