import { beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { createTenant, fund, makeCampaign, makeContact, makePoolMailbox, reply, resetDb, sendable, transport } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { balanceOf, holdsOf, releaseForContact } from "../src/domain/credits/index.js";
import { emailsFor, peopleFor, PRICE_PER_EMAIL, REPLY_RESERVE } from "../src/domain/money.js";
import { sendFirstTouch, sendFollowUp } from "../src/domain/sending/pipeline.js";
import { budgetCard, emailsPerDay } from "../src/domain/budget.js";
import { maybeAutoReload } from "../src/modules/billing/autoReload.js";
import { setStripeClient } from "../src/modules/billing/stripe.client.js";
import { setMailSender, type MailMessage } from "../src/integrations/mailer.js";

/** Spec 4 acceptance: one flat price, the daily budget as the only control, auto-reload that can't surprise anyone. */

const HOUR = 3_600_000;

function fakeStripe(opts: { fail?: boolean } = {}) {
  const charges: Record<string, unknown>[] = [];
  let n = 0;
  return {
    charges,
    paymentMethods: { list: async () => ({ data: [{ id: "pm_card_1" }] }) },
    paymentIntents: {
      create: async (args: Record<string, unknown>) => {
        if (opts.fail) throw new Error("Your card was declined.");
        charges.push(args);
        n++;
        return { id: `pi_auto_${n}`, status: "succeeded", customer: args.customer, amount: args.amount, amount_received: args.amount, metadata: args.metadata };
      },
    },
  };
}

function mailbox() {
  const sent: MailMessage[] = [];
  setMailSender(async (m) => (sent.push(m), true));
  return sent;
}

async function withAutoReload(orgId: string, balance: bigint) {
  await prisma.organization.update({ where: { id: orgId }, data: { stripeCustomerId: `cus_${orgId.slice(0, 8)}` } });
  await fund(orgId, balance);
  await prisma.orgSettings.update({
    where: { organizationId: orgId },
    data: { autoReloadEnabled: true, autoReloadThresholdDecicents: 40_000n, autoReloadAmountDecicents: 140_000n, autoReloadMandateText: "test mandate", autoReloadMandateAcceptedAt: new Date() },
  });
}

describe("flat price", () => {
  beforeEach(resetDb);

  it("$20 is exactly 500 emails and 125 people", () => {
    expect(emailsFor(20_000n)).toBe(500);
    expect(peopleFor(emailsFor(20_000n))).toBe(125);
    expect(emailsPerDay({ dailyBudgetDecicents: 20_000n })).toBe(500);
  });

  it("delivers exactly N emails for a top-up of N emails, with replies, bounces and finished sequences mixed in", async () => {
    const N = 25;
    const t = await createTenant({ subscribed: false });
    // N emails of cold email on top of the $2 reply reserve.
    await fund(t.orgId, BigInt(N) * PRICE_PER_EMAIL + REPLY_RESERVE);
    for (let i = 0; i < 3; i++) await makePoolMailbox();
    const campaign = await makeCampaign(t.orgId);
    const active: { id: string; next: number }[] = [];
    let i = 0;
    for (let round = 0; round < 40; round++) {
      // Follow-ups for everyone still in a sequence.
      for (const p of [...active]) {
        const r = await sendFollowUp(t.orgId, p.id, campaign.id, p.next as 2 | 3 | 4);
        if (!r.ok || p.next === 4) active.splice(active.indexOf(p), 1);
        else p.next++;
      }
      // One new person a round. Every third replies to the first email, every fifth bounces.
      const c = await makeContact(t.orgId, sendable(campaign.id, { email: `p${i}@mix${i}.com`, emailNormalized: `p${i}@mix${i}.com`, domain: `mix${i}.com`, companyDomain: `mix${i}.com` }));
      const accept = transport.respond;
      if (i % 5 === 4) transport.respond = () => reply("550", "5.1.1", "HARD_BOUNCE");
      const r = await sendFirstTouch(t.orgId, c.id, campaign.id);
      transport.respond = accept;
      if (r.ok) {
        if (i % 3 === 0) {
          await prisma.contact.update({ where: { id: c.id }, data: { status: "REPLIED", repliedAt: new Date() } });
          await releaseForContact(c.id, "Replied");
        } else active.push({ id: c.id, next: 2 });
      }
      i++;
      if (!active.length && (await balanceOf(t.orgId)) <= REPLY_RESERVE) break;
    }
    const accepted = await prisma.send.count({ where: { organizationId: t.orgId, priceCharged: PRICE_PER_EMAIL } });
    expect(accepted).toBe(N);
    // Cold email stopped exactly at the reserve, which is still there for replies.
    expect(await balanceOf(t.orgId)).toBe(REPLY_RESERVE);
    expect(await holdsOf(t.orgId)).toBe(0n);
    // A bounce is never charged.
    expect(await prisma.send.count({ where: { organizationId: t.orgId, status: "HARD_BOUNCE", priceCharged: { gt: 0n } } })).toBe(0);
  });

  it("a $0 budget stops sending and leaves the balance untouched", async () => {
    const t = await createTenant();
    await makePoolMailbox();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { dailyBudgetDecicents: 0n } });
    const campaign = await makeCampaign(t.orgId);
    const c = await makeContact(t.orgId, sendable(campaign.id));
    const before = await balanceOf(t.orgId);
    expect(await sendFirstTouch(t.orgId, c.id, campaign.id)).toMatchObject({ ok: false, code: "BUDGET_PAUSED" });
    expect(await balanceOf(t.orgId)).toBe(before);
    expect(await holdsOf(t.orgId)).toBe(0n);
    expect(transport.sent).toHaveLength(0);
  });
});

describe("auto-reload", () => {
  beforeEach(resetDb);

  it("never charges when it is off, which is the default", async () => {
    const t = await createTenant({ subscribed: false });
    const stripe = fakeStripe();
    setStripeClient(stripe as unknown as Stripe);
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).autoReloadEnabled).toBe(false);
    expect(await maybeAutoReload(t.orgId)).toMatchObject({ charged: false, reason: "off" });
    expect(stripe.charges).toHaveLength(0);
  });

  it("charges at most once in 24 hours and emails every charge", async () => {
    const t = await createTenant({ subscribed: false });
    const stripe = fakeStripe();
    setStripeClient(stripe as unknown as Stripe);
    const mail = mailbox();
    await withAutoReload(t.orgId, 1_000n);
    const now = new Date();
    expect(await maybeAutoReload(t.orgId, now)).toMatchObject({ charged: true });
    expect(await balanceOf(t.orgId)).toBe(141_000n);
    expect(stripe.charges[0]).toMatchObject({ amount: 14_000, off_session: true, confirm: true });
    expect(mail.map((m) => m.subject)).toEqual(["Aperture: $140.00 added to your balance"]);
    // Spent back below the threshold within the day: still no second charge.
    await prisma.creditLedger.deleteMany({ where: { organizationId: t.orgId } });
    await fund(t.orgId, 1_000n);
    expect(await maybeAutoReload(t.orgId, new Date(now.getTime() + 23 * HOUR))).toMatchObject({ charged: false });
    expect(await Promise.all([maybeAutoReload(t.orgId, new Date(now.getTime() + 25 * HOUR)), maybeAutoReload(t.orgId, new Date(now.getTime() + 25 * HOUR))])).toEqual(
      expect.arrayContaining([expect.objectContaining({ charged: true }), expect.objectContaining({ charged: false })]),
    );
    expect(stripe.charges).toHaveLength(2);
  });

  it("switches itself off and emails the customer when the card fails, without retrying", async () => {
    const t = await createTenant({ subscribed: false });
    const stripe = fakeStripe({ fail: true });
    setStripeClient(stripe as unknown as Stripe);
    const mail = mailbox();
    await withAutoReload(t.orgId, 1_000n);
    expect(await maybeAutoReload(t.orgId)).toMatchObject({ charged: false });
    const s = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(s).toMatchObject({ autoReloadEnabled: false, autoReloadDisabledReason: "Your card was declined." });
    expect(s.autoReloadDisabledAt).not.toBeNull();
    expect(mail.map((m) => m.subject)).toEqual(["Aperture: Auto-reload failed and is now off"]);
    expect(await balanceOf(t.orgId)).toBe(1_000n);
    expect(await maybeAutoReload(t.orgId, new Date(Date.now() + 48 * HOUR))).toMatchObject({ charged: false, reason: "off" });
  });
});

describe("budget nudge", () => {
  beforeEach(resetDb);

  async function spend(orgId: string, emails: number) {
    for (let i = 0; i < emails; i++) {
      const c = await makeContact(orgId);
      await prisma.send.create({ data: { organizationId: orgId, contactId: c.id, isFirstTouch: true, step: 1, status: "SENT", sentAt: new Date(), priceCharged: PRICE_PER_EMAIL } });
    }
  }

  it("shows only when the budget is spent and people are waiting", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { dailyBudgetDecicents: 4_000n } });
    const campaign = await makeCampaign(t.orgId);
    // Not reached yet, people waiting: no nudge.
    await makeContact(t.orgId, sendable(campaign.id));
    await spend(t.orgId, 50);
    expect((await budgetCard(t.orgId)).nudge).toBeNull();
    // Reached, people waiting: the nudge, with the reply rate measured over the last 30 days (5 of 100).
    await spend(t.orgId, 50);
    const replied = await prisma.contact.findMany({ where: { organizationId: t.orgId, status: "NEW" }, take: 5, select: { id: true } });
    await prisma.contact.updateMany({ where: { id: { in: replied.map((r) => r.id) } }, data: { repliedAt: new Date() } });
    const card = await budgetCard(t.orgId);
    expect(card).toMatchObject({ state: "reached", spentToday: "4000", sentToday: 100 });
    expect(card.nudge).toMatchObject({ waiting: 1, raiseBy: "1000", raiseTo: "5000", replyRate: 0.05, moreRepliesPerMonth: 7 });
    // Reached, nobody waiting: no nudge.
    await prisma.contact.updateMany({ where: { organizationId: t.orgId, status: "PERSONALIZED" }, data: { status: "CONTACTED", firstContactedAt: new Date() } });
    expect((await budgetCard(t.orgId)).nudge).toBeNull();
  });
});

describe("cockpit", () => {
  beforeEach(resetDb);

  it("shows the budget chosen in setup, and never says sending is on schedule with no capacity", async () => {
    const { api, makeCapacity } = await import("./helpers.js");
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { dailyBudgetDecicents: 20_000n, autopilotEnabled: true } });
    let c = (await api().get("/api/v1/dashboard/cockpit").set(t.auth).expect(200)).body.data;
    expect(c.budget).toEqual({ emailsPerDay: 500, perDay: "$20", deciCents: "20000", spentToday: "$0.00" });
    expect(c.engine.state).toBe("capacity");
    expect(c.engine).not.toHaveProperty("timezone");
    expect((await api().get("/api/v1/dashboard/budget").set(t.auth).expect(200)).body.data.budget).toBe("20000");
    await makeCapacity(500);
    c = (await api().get("/api/v1/dashboard/cockpit").set(t.auth).expect(200)).body.data;
    // Nothing found or written yet, so it is getting ready, not "sending".
    expect(c.engine.state).toBe("preparing");
    expect(c.progress).toMatchObject({ found: 0, verified: 0, sentEver: false });
    // Reading the cockpit never changes the budget.
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).dailyBudgetDecicents).toBe(20_000n);
  });
});

describe("reply reserve", () => {
  beforeEach(resetDb);

  async function thread(balance: bigint) {
    const { api, makePoolMailbox: mk } = await import("./helpers.js");
    const t = await createTenant();
    const m = await mk();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id));
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: true });
    const send = await prisma.send.findFirstOrThrow({ where: { contactId: p.id, step: 1 } });
    // Bring the balance down to what the test needs, after the first email went.
    const { debitCorrection } = await import("../src/domain/credits/index.js");
    await releaseForContact(p.id, "test");
    await debitCorrection(t.orgId, (await balanceOf(t.orgId)) - balance, "test");
    return { api, t, m, p, send, campaign };
  }
  const inbound = (m: { address: string }, p: { email: string }, send: { subject: string | null; messageId: string | null }, extra: string[], body: string, id: string) =>
    transport.deliver(m.address, [`From: Lead <${p.email}>`, `To: ${m.address}`, `Subject: Re: ${send.subject}`, `Message-ID: <${id}@company.com>`, `In-Reply-To: ${send.messageId}`, `Date: ${new Date().toUTCString()}`, ...extra, "", body].join("\n"));

  it("at $1.50 pauses cold email but a reply to someone who wrote back still sends, for exactly $0.04", async () => {
    const { api, t, m, p, send, campaign } = await thread(1_500n);
    // Cold email: a new person is refused with its own code.
    const cold = await makeContact(t.orgId, sendable(campaign.id, { email: "new@other.com", emailNormalized: "new@other.com", domain: "other.com", companyDomain: "other.com" }));
    expect(await sendFirstTouch(t.orgId, cold.id, campaign.id)).toMatchObject({ ok: false, code: "COLD_EMAIL_PAUSED" });
    // They write back: the conversation may use the reserve.
    inbound(m, p, send, [], "Sounds good, tell me more.", "h1");
    const { pollMailboxes } = await import("../src/domain/sending/jobs.js");
    await pollMailboxes();
    await api().post(`/api/v1/inbox/${p.id}/reply`).set(t.auth).send({ body: "Great, here is how it works." }).expect(200);
    expect(await balanceOf(t.orgId)).toBe(1_460n);
    const replySend = await prisma.send.findFirstOrThrow({ where: { contactId: p.id, step: 0 } });
    expect(replySend.priceCharged).toBe(40n);
  });

  it("an out-of-office does not make the thread a live conversation", async () => {
    const { api, t, m, p, send } = await thread(1_500n);
    inbound(m, p, send, ["Auto-Submitted: auto-replied"], "I am out of the office until Monday.", "ooo1");
    const { pollMailboxes } = await import("../src/domain/sending/jobs.js");
    await pollMailboxes();
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).repliedAt).toBeNull();
    const res = await api().post(`/api/v1/inbox/${p.id}/reply`).set(t.auth).send({ body: "Following up." }).expect(402);
    expect(res.body.error.code).toBe("COLD_EMAIL_PAUSED");
    expect(await balanceOf(t.orgId)).toBe(1_500n);
  });

  it("at $0 everything stops, replies included", async () => {
    const { api, t, m, p, send, campaign } = await thread(0n);
    inbound(m, p, send, [], "Yes, interested.", "h2");
    const { pollMailboxes } = await import("../src/domain/sending/jobs.js");
    await pollMailboxes();
    const res = await api().post(`/api/v1/inbox/${p.id}/reply`).set(t.auth).send({ body: "Great." }).expect(402);
    expect(res.body.error.code).toBe("INSUFFICIENT_CREDITS");
    const cold = await makeContact(t.orgId, sendable(campaign.id, { email: "x@another.com", emailNormalized: "x@another.com", domain: "another.com", companyDomain: "another.com" }));
    expect(await sendFirstTouch(t.orgId, cold.id, campaign.id)).toMatchObject({ ok: false, code: "INSUFFICIENT_CREDITS" });
    expect(await balanceOf(t.orgId)).toBe(0n);
  });

  it("shows a different state at $2 or less than at $0", async () => {
    const { api } = await import("./helpers.js");
    const t = await createTenant({ subscribed: false });
    await fund(t.orgId, 2_000n);
    expect((await api().get("/api/v1/dashboard/nav-counts").set(t.auth)).body.data.balanceStage).toBe("reserve");
    const { debitCorrection } = await import("../src/domain/credits/index.js");
    await debitCorrection(t.orgId, 2_000n, "test");
    expect((await api().get("/api/v1/dashboard/nav-counts").set(t.auth)).body.data.balanceStage).toBe("empty");
  });
});
