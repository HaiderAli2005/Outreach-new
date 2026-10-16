import { beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { api, createTenant, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setStripeClient } from "../src/modules/billing/stripe.client.js";
import { balanceOf } from "../src/domain/credits/index.js";

const WEBHOOK_SECRET = "whsec_test_secret";
const signer = new Stripe("sk_test_fake");

function signed(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

function fakeStripe() {
  const calls: { op: string; args: unknown[] }[] = [];
  let pi = 0;
  const cards = new Set(["pm_card_1"]);
  return {
    calls,
    customers: { create: async (...args: unknown[]) => (calls.push({ op: "customers.create", args }), { id: "cus_test_1" }) },
    paymentIntents: {
      create: async (...args: unknown[]) => {
        calls.push({ op: "paymentIntents.create", args });
        pi++;
        const a = args[0] as { confirm?: boolean; amount?: number };
        if (a.confirm && a.amount === 9900) throw Object.assign(new Error("Your card has insufficient funds."), { type: "StripeCardError" });
        return { id: `pi_top_${pi}`, client_secret: `pi_top_${pi}_secret`, status: a.confirm ? "succeeded" : "requires_payment_method" };
      },
    },
    paymentMethods: {
      list: async () => ({ data: [...cards].map((id) => ({ id, card: { brand: "visa", last4: "4242" } })) }),
      detach: async (id: string) => (calls.push({ op: "paymentMethods.detach", args: [id] }), cards.delete(id), { id }),
    },
    refunds: { create: async (...args: unknown[]) => (calls.push({ op: "refunds.create", args }), { id: `re_${calls.length}`, status: "pending" }) },
  };
}

const hook = (event: Record<string, unknown>) => {
  const { payload, header } = signed(event);
  return api().post("/api/v1/billing/webhook").set("Stripe-Signature", header).set("Content-Type", "application/json").send(payload);
};

const topupSucceeded = (id: string, orgId: string, deciCents: string, cents: number) => ({
  id: `evt_${id}`,
  type: "payment_intent.succeeded",
  data: { object: { id, customer: "cus_test_1", amount: cents, amount_received: cents, currency: "usd", metadata: { kind: "topup", organizationId: orgId, deciCents } } },
});

describe("billing", () => {
  let stripe: ReturnType<typeof fakeStripe>;
  beforeEach(async () => {
    await resetDb();
    stripe = fakeStripe();
    setStripeClient(stripe as unknown as Stripe);
  });

  it("serves the per-email prices and the top-up options, with no plans and no supplier costs", async () => {
    const res = await api().get("/api/v1/billing/plans").expect(200);
    expect(res.body.data.plans).toBeUndefined();
    expect(res.body.data.pricing).toMatchObject({ perEmail: "$0.04", perEmailDeciCents: "40", replyReserve: "$2.00", minTopup: "$25.00", topupDays: [1, 3, 5, 22], ownership: "Your leads are yours. Export them any time." });
    expect(res.body.data.pricing.freeTrial).toEqual({ amount: "$10.00", emails: 250, people: 62 });
    expect(res.body.data.volume).toMatchObject({ min: 100, max: 5000, step: 50, presets: [250, 500, 1000, 2500, 5000] });
    expect(res.body.data.volume.stops.find((x: { emails: number }) => x.emails === 500)).toMatchObject({ perDay: "$20", people: 125, perMonth: "$440" });
    expect(res.body.data.budget).toMatchObject({ minDeciCents: "4000", maxDeciCents: "200000", defaultDeciCents: "20000", presetsDeciCents: ["10000", "20000", "40000", "100000", "200000"] });
    expect(JSON.stringify(res.body.data)).not.toMatch(/firstEmail|followUp|0\.045|0\.025/);
    expect(JSON.stringify(res.body.data)).not.toMatch(/inbox|domain|priceCents/i);
  });

  it("starts a prepaid top-up on the customer's card, remembered only for top-ups the customer makes themselves", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/billing/topups").set(t.auth).send({ amount: "25000" }).expect(400);
    await api().post("/api/v1/billing/topups").set(t.auth).set("Idempotency-Key", "topup-attempt-1").send({ amount: "12345" }).expect(422);
    await api().post("/api/v1/billing/topups").set(t.auth).set("Idempotency-Key", "topup-attempt-1").send({ amount: 25.5 }).expect(400);
    const res = await api().post("/api/v1/billing/topups").set(t.auth).set("Idempotency-Key", "topup-attempt-1").send({ amount: "50000" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ clientSecret: "pi_top_1_secret", amount: "$50.00" });
    const create = stripe.calls.find((c) => c.op === "paymentIntents.create")!;
    expect(create.args[0]).toMatchObject({ amount: 5000, currency: "usd", setup_future_usage: "on_session", metadata: { kind: "topup", source: "manual", organizationId: t.orgId, deciCents: "50000" } });
    expect((create.args[1] as { idempotencyKey: string }).idempotencyKey).toBe("topup:topup-attempt-1");
    // Nothing is credited until Stripe confirms the payment.
    expect(await balanceOf(t.orgId)).toBe(0n);
  });

  it("tops up in one click on the saved card, and says a decline in plain words", async () => {
    const t = await createTenant({ subscribed: false });
    await prisma.organization.update({ where: { id: t.orgId }, data: { stripeCustomerId: "cus_test_1" } });
    expect((await api().get("/api/v1/billing/credits").set(t.auth).expect(200)).body.data.card).toEqual({ brand: "Visa", last4: "4242" });
    const res = await api().post("/api/v1/billing/topups").set(t.auth).set("Idempotency-Key", "saved-attempt-1").send({ amount: "100000", savedCard: true }).expect(200);
    expect(res.body.data).toMatchObject({ status: "succeeded", amount: "$100.00" });
    const create = stripe.calls.find((c) => c.op === "paymentIntents.create")!;
    expect(create.args[0]).toMatchObject({ amount: 10000, customer: "cus_test_1", payment_method: "pm_card_1", confirm: true, metadata: { kind: "topup", source: "saved_card", deciCents: "100000" } });
    const declined = await api().post("/api/v1/billing/topups").set(t.auth).set("Idempotency-Key", "saved-attempt-2").send({ amount: "99000", savedCard: true }).expect(422);
    expect(declined.body.error.message).toBe("Your card was declined: Your card has insufficient funds. Try again, or use a different card.");
    // Still nothing is credited until Stripe confirms the payment.
    expect(await balanceOf(t.orgId)).toBe(0n);
  });

  it("credits a top-up once when Stripe confirms it, however often the event arrives", async () => {
    const t = await createTenant({ subscribed: false });
    await prisma.organization.update({ where: { id: t.orgId }, data: { stripeCustomerId: "cus_test_1" } });
    const ev = topupSucceeded("pi_top_9", t.orgId, "25000", 2500);
    expect((await hook(ev)).body.data.duplicate).toBe(false);
    expect(await balanceOf(t.orgId)).toBe(25_000n);
    expect((await hook(ev)).body.data.duplicate).toBe(true);
    expect((await hook(ev)).body.data.duplicate).toBe(true);
    // A different delivery of the same payment (a new event id) is still credited only once.
    await hook({ ...ev, id: "evt_replay" });
    expect(await balanceOf(t.orgId)).toBe(25_000n);
    expect(await prisma.creditLedger.count({ where: { organizationId: t.orgId, kind: "TOPUP" } })).toBe(1);
    expect((await prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: "pi_top_9" } })).status).toBe("SUCCEEDED");
  });

  it("shows the credits panel: balance, emails left, price, health and activity", async () => {
    const t = await createTenant({ balance: 47_200n });
    const res = await api().get("/api/v1/billing/credits").set(t.auth).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.data).toMatchObject({ balance: "$47.20", emailsLeft: 1180, peopleLeft: 295, pricePerEmail: "$0.04", hasCard: false, trialAvailable: true });
    expect(res.body.data.health).toMatchObject({ status: "OK", bounceRate: "0.0%", delivered: 0, bounced: 0 });
    expect(res.body.data.activity[0]).toMatchObject({ kind: "bonus", amount: "+$47.20" });
    expect(JSON.stringify(res.body.data)).not.toMatch(/mailbox|inbox|domain/i);
  });

  it("rejects webhooks with a bad signature", async () => {
    const res = await api().post("/api/v1/billing/webhook").set("Stripe-Signature", "t=1,v1=deadbeef").set("Content-Type", "application/json").send(JSON.stringify({ id: "evt_1" }));
    expect(res.status).toBe(400);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await prisma.creditLedger.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
  });

  it("records a failed card without retrying it and without touching the balance", async () => {
    const t = await createTenant({ subscribed: false });
    await prisma.organization.update({ where: { id: t.orgId }, data: { stripeCustomerId: "cus_test_1" } });
    await hook({ id: "evt_pi_fail", type: "payment_intent.payment_failed", data: { object: { id: "pi_2", customer: "cus_test_1", amount: 2500, currency: "usd", metadata: { kind: "topup" }, last_payment_error: { message: "Your card was declined." } } } }).expect(200);
    const failed = await prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: "pi_2" } });
    expect(failed).toMatchObject({ status: "FAILED", failureMessage: "Your card was declined." });
    expect(await balanceOf(t.orgId)).toBe(0n);
    expect(stripe.calls.filter((c) => c.op === "paymentIntents.create")).toHaveLength(0);
  });

  it("lets a platform admin refund a top-up, which comes off the unspent balance", async () => {
    const t = await createTenant({ subscribed: false });
    await prisma.user.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    await prisma.organization.update({ where: { id: t.orgId }, data: { stripeCustomerId: "cus_test_1" } });
    await hook(topupSucceeded("pi_refund", t.orgId, "100000", 10000));
    const payment = await prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: "pi_refund" } });
    await api().post(`/api/v1/admin/payments/${payment.id}/refund`).set(t.auth).send({ amountCents: 20000 }).expect(422);
    await api().post(`/api/v1/admin/payments/${payment.id}/refund`).set(t.auth).send({ amountCents: 4000, reason: "goodwill" }).expect(200);
    expect(stripe.calls.find((c) => c.op === "refunds.create")!.args[0]).toMatchObject({ payment_intent: "pi_refund", amount: 4000 });
    await hook({ id: "evt_refund", type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: "pi_refund", amount_refunded: 4000 } } }).expect(200);
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(p).toMatchObject({ status: "PARTIALLY_REFUNDED", amountRefundedCents: 4000 });
    expect(await balanceOf(t.orgId)).toBe(60_000n);
  });

  it("lets the customer remove their card and close the account themselves", async () => {
    const t = await createTenant();
    await prisma.organization.update({ where: { id: t.orgId }, data: { stripeCustomerId: "cus_test_1" } });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true } });
    expect((await api().delete("/api/v1/billing/card").set(t.auth).expect(200)).body.data.removed).toBe(1);
    await api().post("/api/v1/billing/close").set(t.auth).send({ confirm: "wrong name" }).expect(422);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: t.orgId } });
    await api().post("/api/v1/billing/close").set(t.auth).send({ confirm: org.name }).expect(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: t.orgId } })).status).toBe("SUSPENDED");
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).autopilotEnabled).toBe(false);
  });

  it("has no subscription, checkout or portal endpoints any more", async () => {
    const t = await createTenant();
    await api().post("/api/v1/billing/checkout").set(t.auth).set("Idempotency-Key", "attempt-zzzz").expect(404);
    await api().get("/api/v1/billing/subscription").set(t.auth).expect(404);
    await api().post("/api/v1/billing/portal").set(t.auth).expect(404);
  });
});
