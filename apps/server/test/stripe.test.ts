import { beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, createTenant, fund, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setStripeClient } from "../src/modules/billing/stripe.client.js";
import { balanceOf } from "../src/domain/credits/index.js";
import { topupOptions, validateTopup } from "../src/domain/money.js";
import { maybeAutoReload } from "../src/modules/billing/autoReload.js";
import { runBillingSyncJob } from "../src/jobs/billingSync.js";
import { setMailSender, type MailMessage } from "../src/integrations/mailer.js";

/** Stripe billing v2 acceptance: prepaid PaymentIntents only, server-side amounts, auto-reload with a mandate, disputes. */

const WEBHOOK_SECRET = "whsec_test_secret";
const signer = new Stripe("sk_test_fake");

function hook(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return api().post("/api/v1/billing/webhook").set("Stripe-Signature", header).set("Content-Type", "application/json").send(payload);
}

type Fake = ReturnType<typeof fakeStripe>;
function fakeStripe(opts: { charge?: "ok" | "decline" | "auth"; listed?: Record<string, unknown>[]; setups?: Record<string, unknown>[] } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  let n = 0;
  return {
    calls,
    customers: { create: async (...args: unknown[]) => (calls.push({ op: "customers.create", args }), { id: "cus_test_1" }) },
    paymentMethods: {
      list: async () => ({ data: [{ id: "pm_card_1" }] }),
      detach: async (id: string) => (calls.push({ op: "paymentMethods.detach", args: [id] }), { id }),
    },
    paymentIntents: {
      create: async (...args: unknown[]) => {
        calls.push({ op: "paymentIntents.create", args });
        n++;
        const a = args[0] as Record<string, unknown>;
        if (a.off_session && opts.charge === "decline") throw Object.assign(new Error("Your card was declined."), { code: "card_declined" });
        if (a.off_session && opts.charge === "auth")
          throw Object.assign(new Error("This payment requires authentication."), { code: "authentication_required", payment_intent: { id: "pi_needs_auth" } });
        return { id: `pi_${n}`, client_secret: `pi_${n}_secret`, status: a.off_session ? "succeeded" : "requires_payment_method", customer: a.customer, amount: a.amount, amount_received: a.amount, metadata: a.metadata };
      },
      retrieve: async (id: string) => ({ id, status: "requires_action", client_secret: `${id}_secret`, amount: 14_000, payment_method: "pm_card_1", metadata: { kind: "topup", source: "auto_reload", organizationId: currentOrg } }),
      list: (_q: unknown) => ({
        async *[Symbol.asyncIterator]() {
          for (const pi of opts.listed ?? []) yield pi;
        },
      }),
    },
    setupIntents: {
      create: async (...args: unknown[]) => {
        calls.push({ op: "setupIntents.create", args });
        const a = args[0] as Record<string, unknown>;
        return { id: `seti_test${calls.length}x`, client_secret: `seti_test${calls.length}x_secret`, usage: a.usage, metadata: a.metadata };
      },
      retrieve: async (id: string) => ({ id, status: "succeeded", usage: "off_session", customer: "cus_test_1", metadata: { kind: "auto_reload_mandate", organizationId: currentOrg } }),
      list: (_q: unknown) => ({
        async *[Symbol.asyncIterator]() {
          for (const si of opts.setups ?? []) yield si;
        },
      }),
    },
  };
}
let currentOrg = "";

function use(f: Fake) {
  setStripeClient(f as unknown as Stripe);
  return f;
}

function inbox() {
  const sent: MailMessage[] = [];
  setMailSender(async (m) => (sent.push(m), true));
  return sent;
}

const succeeded = (id: string, orgId: string, deciCents: string, cents: number) => ({
  id,
  object: "payment_intent",
  status: "succeeded",
  customer: "cus_test_1",
  amount: cents,
  amount_received: cents,
  currency: "usd",
  metadata: { kind: "topup", source: "manual", organizationId: orgId, deciCents },
});

async function withCard(orgId: string) {
  await prisma.organization.update({ where: { id: orgId }, data: { stripeCustomerId: "cus_test_1" } });
}

describe("top-up amounts", () => {
  beforeEach(resetDb);

  it("accepts whole dollars from $25 to $10,000 and says why it refuses the rest", async () => {
    expect(validateTopup(37_000n)).toBeNull();
    expect(validateTopup(24_000n)).toBe("The smallest top-up is $25.00");
    expect(validateTopup(24_500n)).toBe("Top-ups are in whole dollars");
    expect(validateTopup(20_000_000n)).toBe("For more than $10,000.00, contact us");
    const t = await createTenant({ subscribed: false });
    use(fakeStripe());
    const post = (amount: string, key: string) => api().post("/api/v1/billing/topups").set(t.auth).set("Idempotency-Key", key).send({ amount });
    expect((await post("37000", "attempt-37")).status).toBe(200);
    expect((await post("24000", "attempt-24")).body.error.message).toMatch(/smallest top-up is \$25/);
    expect((await post("24500", "attempt-245")).body.error.message).toMatch(/whole dollars/);
    expect((await post("20000000", "attempt-20k")).body.error.message).toMatch(/\$10,000/);
  });

  it("suggests $25 / $60 / $100 / $440 at a $20 budget (1 day, 3 days, a 5-day week, a 22-day month), with the balance in days", async () => {
    expect(topupOptions(20_000n).map((o) => [o.label, o.amount, o.emails, o.recommended])).toEqual([
      ["1 day", "$25", 625, false],
      ["3 days", "$60", 1500, false],
      ["1 week", "$100", 2500, true],
      ["1 month", "$440", 11000, false],
    ]);
    const t = await createTenant({ subscribed: false });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { dailyBudgetDecicents: 20_000n } });
    await fund(t.orgId, 10_000n);
    const res = await api().get("/api/v1/billing/topup-options").set(t.auth).expect(200);
    expect(res.body.data).toMatchObject({ lead: "500 emails a day costs $20 a day. How long do you want to run?", balance: "$10.00", balanceLasts: "about half a day" });
    expect(res.body.data.options.map((o: { deciCents: string }) => o.deciCents)).toEqual(["25000", "60000", "100000", "440000"]);
    // At $5 a day the $25 minimum lasts 5 days, so it says so; the cards that would also be $25 merge into it.
    const preview = await api().get("/api/v1/billing/topup-options?budget=5000").set(t.auth).expect(200);
    expect(preview.body.data.options.map((o: { label: string; amount: string }) => [o.label, o.amount])).toEqual([
      ["5 days", "$25"],
      ["1 month", "$110"],
    ]);
  });

  it("reuses one PaymentIntent for a double click or a reload", async () => {
    const t = await createTenant({ subscribed: false });
    const f = use(fakeStripe());
    for (let i = 0; i < 2; i++) await api().post("/api/v1/billing/topups").set(t.auth).set("Idempotency-Key", "org1-140000-abc").send({ amount: "140000" }).expect(200);
    const keys = f.calls.filter((c) => c.op === "paymentIntents.create").map((c) => (c.args[1] as { idempotencyKey: string }).idempotencyKey);
    // Stripe returns the same PaymentIntent for the same key; the key is identical on both requests.
    expect(new Set(keys)).toEqual(new Set(["topup:org1-140000-abc"]));
  });
});

describe("webhook", () => {
  beforeEach(resetDb);

  it("handles exactly the seven events and records anything else as ignored", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    use(fakeStripe());
    await hook({ id: "evt_inv", type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_test_1" } } }).expect(200);
    await hook({ id: "evt_sub", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } }).expect(200);
    expect((await prisma.webhookEvent.findMany()).map((e) => e.status)).toEqual(["IGNORED", "IGNORED"]);
  });

  it("credits an auto top-up under its own name", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    use(fakeStripe());
    const pi = { ...succeeded("pi_auto", t.orgId, "140000", 14000), metadata: { kind: "topup", source: "auto_reload", organizationId: t.orgId, deciCents: "140000" } };
    await hook({ id: "evt_auto", type: "payment_intent.succeeded", data: { object: pi } }).expect(200);
    expect((await prisma.creditLedger.findFirstOrThrow({ where: { organizationId: t.orgId, kind: "TOPUP" } })).note).toBe("Auto top-up $140.00");
  });

  it("billing-sync replays twice without crediting twice, and writes a webhook row per replay", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    use(fakeStripe({ listed: [succeeded("pi_s1", t.orgId, "60000", 6000), succeeded("pi_s2", t.orgId, "25000", 2500)] }));
    expect(await runBillingSyncJob()).toMatchObject({ replayed: 2, failed: 0 });
    expect(await runBillingSyncJob()).toMatchObject({ replayed: 2, failed: 0 });
    expect(await balanceOf(t.orgId)).toBe(85_000n);
    expect(await prisma.webhookEvent.count({ where: { externalId: { startsWith: "sync_" } } })).toBe(2);
  });

  it("a refund larger than the unspent balance logs a warning and still answers 200", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    use(fakeStripe());
    await hook({ id: "evt_top", type: "payment_intent.succeeded", data: { object: succeeded("pi_r", t.orgId, "25000", 2500) } });
    // Most of it is spent.
    const { debitCorrection } = await import("../src/domain/credits/index.js");
    await debitCorrection(t.orgId, 20_000n, "spent");
    await hook({ id: "evt_ref", type: "charge.refunded", data: { object: { id: "ch_r", payment_intent: "pi_r", amount_refunded: 2500 } } }).expect(200);
    expect(await balanceOf(t.orgId)).toBe(5_000n);
    expect(await prisma.systemLog.count({ where: { organizationId: t.orgId, level: "WARN", message: { contains: "larger than the unspent balance" } } })).toBe(1);
  });

  it("a dispute pauses sending, claws back the unspent balance and switches auto-reload off; winning it puts both back", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    use(fakeStripe());
    await hook({ id: "evt_top", type: "payment_intent.succeeded", data: { object: succeeded("pi_d", t.orgId, "60000", 6000) } });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autoReloadEnabled: true, autoReloadThresholdDecicents: 40_000n, autoReloadAmountDecicents: 140_000n, autoReloadMandateText: "m", autoReloadMandateAcceptedAt: new Date() } });
    const dispute = { id: "dp_1", object: "dispute", amount: 6000, charge: "ch_d", payment_intent: "pi_d", status: "needs_response" };
    await hook({ id: "evt_dp", type: "charge.dispute.created", data: { object: dispute } }).expect(200);
    expect(await balanceOf(t.orgId)).toBe(0n);
    expect((await prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: "pi_d" } })).status).toBe("DISPUTED");
    expect(await prisma.customerHealth.findUniqueOrThrow({ where: { organizationId: t.orgId } })).toMatchObject({ status: "PAUSED" });
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).toMatchObject({ autoReloadEnabled: false, autoReloadDisabledReason: "a payment was disputed" });
    await hook({ id: "evt_dp_won", type: "charge.dispute.closed", data: { object: { ...dispute, status: "won" } } }).expect(200);
    expect(await balanceOf(t.orgId)).toBe(60_000n);
    expect((await prisma.customerHealth.findUniqueOrThrow({ where: { organizationId: t.orgId } })).status).toBe("OK");
  });
});

describe("auto-reload", () => {
  beforeEach(resetDb);

  it("can't reach an off-session charge anywhere but the auto-reload job", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(__dirname, "../src"));
    const offSession = files.filter((f) => /off_session:\s*true/.test(readFileSync(f, "utf8")));
    expect(offSession.map((f) => f.split(/[\\/]/).pop())).toEqual(["autoReload.ts"]);
    const legacy = files.filter((f) => /["'`]price_[A-Za-z0-9]{6,}|checkout\.session|billingPortal|billing\.portal|customer\.subscription|subscriptions?\./i.test(readFileSync(f, "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")));
    expect(legacy).toEqual([]);
  });

  it("never charges without a recorded mandate, even if the switch were on", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    const f = use(fakeStripe());
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autoReloadEnabled: true, autoReloadThresholdDecicents: 40_000n, autoReloadAmountDecicents: 140_000n } });
    expect(await maybeAutoReload(t.orgId)).toMatchObject({ charged: false, reason: "off" });
    expect(f.calls.filter((c) => c.op === "paymentIntents.create")).toHaveLength(0);
  });

  it("switching it on needs a separate off-session consent on the saved card, and records the mandate sentence, who and when", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    currentOrg = t.orgId;
    const f = use(fakeStripe());
    const numbers = { autoReloadThresholdDecicents: "40000", autoReloadAmountDecicents: "140000" };
    await api().patch("/api/v1/settings").set(t.auth).send({ autoReloadEnabled: true, ...numbers }).expect(422);
    const si = await api().post("/api/v1/billing/setup-intents").set(t.auth).set("Idempotency-Key", "reload-consent-1").send({ purpose: "auto_reload" }).expect(200);
    expect(si.body.data).toMatchObject({ paymentMethodId: "pm_card_1" });
    expect(f.calls.find((c) => c.op === "setupIntents.create")!.args[0]).toMatchObject({ usage: "off_session", payment_method: "pm_card_1", metadata: { kind: "auto_reload_mandate" } });
    const res = await api().patch("/api/v1/settings").set(t.auth).send({ autoReloadEnabled: true, autoReloadSetupIntentId: si.body.data.setupIntentId, ...numbers }).expect(200);
    expect(res.body.data.settings).toMatchObject({ autoReloadEnabled: true, autoReloadMandateText: "When my balance drops below $40, charge my saved card $140. At most one charge a day. I can turn this off at any time." });
    expect(res.body.data.settings).not.toHaveProperty("autoReloadMandateIp");
    const s = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(s.autoReloadMandateUserId).toBe(t.userId);
    expect(s.autoReloadMandateAcceptedAt).not.toBeNull();
    await api().patch("/api/v1/settings").set(t.auth).send({ autoReloadAmountDecicents: "140500" }).expect(422);
    await api().post("/api/v1/billing/topups").set(t.auth).set("Idempotency-Key", "attempt-after-mandate").send({ amount: "60000" }).expect(200);
    expect((f.calls.find((c) => c.op === "paymentIntents.create")!.args[0] as { setup_future_usage: string }).setup_future_usage).toBe("off_session");
  });

  it("uses a dated idempotency key, so Stripe itself allows one auto-reload a day", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    const f = use(fakeStripe({ charge: "ok" }));
    inbox();
    await fund(t.orgId, 1_000n);
    const accepted = new Date("2030-03-01T08:00:00Z");
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autoReloadEnabled: true, autoReloadThresholdDecicents: 40_000n, autoReloadAmountDecicents: 140_000n, autoReloadMandateText: "m", autoReloadMandateAcceptedAt: accepted } });
    expect(await maybeAutoReload(t.orgId, new Date("2030-03-02T09:00:00Z"))).toMatchObject({ charged: true });
    expect((f.calls[0].args[1] as { idempotencyKey: string }).idempotencyKey).toBe(`autoreload:${t.orgId}:2030-03-02:${accepted.getTime()}`);
  });

  it("treats a bank asking for authentication as its own case: off, and an email with a link to approve it", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    use(fakeStripe({ charge: "auth" }));
    const mail = inbox();
    await fund(t.orgId, 1_000n);
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autoReloadEnabled: true, autoReloadThresholdDecicents: 40_000n, autoReloadAmountDecicents: 140_000n, autoReloadMandateText: "m", autoReloadMandateAcceptedAt: new Date() } });
    expect(await maybeAutoReload(t.orgId)).toMatchObject({ charged: false, reason: "the card needs authentication" });
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).toMatchObject({ autoReloadEnabled: false, autoReloadDisabledReason: "the card needs authentication" });
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe("Aperture: Please approve your auto-reload payment");
    expect(mail[0].text).toContain("/app/billing/credits?confirm=pi_needs_auth");
    // The same need reported again by the webhook does not email twice.
    await hook({ id: "evt_ra", type: "payment_intent.requires_action", data: { object: { id: "pi_needs_auth", customer: "cus_test_1", amount: 14000, currency: "usd", metadata: { kind: "topup", source: "auto_reload", organizationId: t.orgId, deciCents: "140000" } } } }).expect(200);
    expect(mail).toHaveLength(1);
    // The link opens a payment the customer can approve, and only their own.
    currentOrg = t.orgId;
    const c = await api().get("/api/v1/billing/payments/pi_needs_auth/confirm").set(t.auth).expect(200);
    expect(c.body.data).toMatchObject({ status: "needs_confirmation", clientSecret: "pi_needs_auth_secret", paymentMethodId: "pm_card_1", amount: "$140.00" });
    currentOrg = "someone-else";
    await api().get("/api/v1/billing/payments/pi_needs_auth/confirm").set(t.auth).expect(404);
  });

  it("removing the saved card switches auto-reload off", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    use(fakeStripe());
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autoReloadEnabled: true, autoReloadThresholdDecicents: 40_000n, autoReloadAmountDecicents: 140_000n, autoReloadMandateText: "m", autoReloadMandateAcceptedAt: new Date() } });
    await api().delete("/api/v1/billing/card").set(t.auth).expect(200);
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).toMatchObject({ autoReloadEnabled: false, autoReloadDisabledReason: "the saved card was removed" });
  });
});

describe("adding a card", () => {
  beforeEach(resetDb);

  it("saves the card on-session with a SetupIntent and creates no PaymentIntent", async () => {
    const t = await createTenant({ subscribed: false });
    const f = use(fakeStripe());
    const res = await api().post("/api/v1/billing/setup-intents").set(t.auth).set("Idempotency-Key", "card-setup-1").send({ purpose: "card" }).expect(200);
    expect(res.body.data.clientSecret).toMatch(/_secret$/);
    expect(f.calls.find((c) => c.op === "setupIntents.create")!.args[0]).toMatchObject({ usage: "on_session", metadata: { kind: "onboarding_card", organizationId: t.orgId } });
    expect(f.calls.filter((c) => c.op === "paymentIntents.create")).toHaveLength(0);
    // There is no way to take the free credit without a card.
    await api().post("/api/v1/billing/trial").set(t.auth).expect(404);
    expect(await balanceOf(t.orgId)).toBe(0n);
  });

  it("grants the $10 free credit once when the card is saved, however often Stripe says so", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    use(fakeStripe());
    const si = { id: "seti_card9xyz", object: "setup_intent", status: "succeeded", usage: "on_session", customer: "cus_test_1", metadata: { kind: "onboarding_card", organizationId: t.orgId } };
    for (const id of ["evt_si_1", "evt_si_1", "evt_si_2"]) await hook({ id, type: "setup_intent.succeeded", data: { object: si } }).expect(200);
    expect(await balanceOf(t.orgId)).toBe(10_000n);
    expect(await prisma.creditLedger.count({ where: { organizationId: t.orgId, kind: "BONUS" } })).toBe(1);
    // An auto-reload consent is not a card added at setup: no credit.
    const t2 = await createTenant({ subscribed: false });
    await hook({ id: "evt_si_3", type: "setup_intent.succeeded", data: { object: { ...si, id: "seti_reload1x", metadata: { kind: "auto_reload_mandate", organizationId: t2.orgId } } } }).expect(200);
    expect(await balanceOf(t2.orgId)).toBe(0n);
  });

  it("billing-sync grants a missed free credit from a saved card, once", async () => {
    const t = await createTenant({ subscribed: false });
    await withCard(t.orgId);
    use(fakeStripe({ setups: [{ id: "seti_missed1", status: "succeeded", customer: "cus_test_1", metadata: { kind: "onboarding_card", organizationId: t.orgId } }] }));
    await runBillingSyncJob();
    await runBillingSyncJob();
    expect(await balanceOf(t.orgId)).toBe(10_000n);
  });
});
