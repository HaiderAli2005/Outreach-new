import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, makePoolMailbox, resetDb, sendable } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { OpenAiClient } from "../src/integrations/ai.js";
import { aiCallUsd, DEFAULT_COST_PRICES } from "../src/config/internalCosts.js";
import { costStack } from "../src/domain/pool/economics.js";
import { updateCostPrices } from "../src/domain/costPrices.js";

/** The real cost of an email: priced from what was used, at prices an operator can change. */

const DAY = 86_400_000;

describe("AI cost from real tokens", () => {
  beforeEach(resetDb);

  it("records each call's tokens against the workspace and purpose, and prices them by model", async () => {
    const t = await createTenant();
    const client = new OpenAiClient("sk-test", "gpt-4.1-mini");
    const usage = { prompt_tokens: 12_000, completion_tokens: 600, prompt_tokens_details: { cached_tokens: 4_000 } };
    (client as unknown as { client: unknown }).client = { chat: { completions: { create: async () => ({ model: "gpt-4.1-mini-2025-04-14", usage, choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }) } } };
    expect(await client.generateJSON("thread...", { meter: { orgId: t.orgId, purpose: "reply" } })).toEqual({ ok: true });
    await client.generateJSON("no meter");
    const rows = await prisma.aiUsage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: t.orgId, purpose: "reply", model: "gpt-4.1-mini-2025-04-14", inputTokens: 12_000, cachedInputTokens: 4_000, outputTokens: 600 });
    // 8,000 fresh x $0.40 + 4,000 cached x $0.10 + 600 out x $1.60, per million: $0.00456.
    expect(aiCallUsd(rows[0].model, rows[0], DEFAULT_COST_PRICES.aiPrices)).toBeCloseTo(0.00456, 8);
    // An unknown model uses the default price.
    expect(aiCallUsd("gpt-9-x", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }, DEFAULT_COST_PRICES.aiPrices)).toBe(2);
  });
});

describe("cost per email", () => {
  beforeEach(resetDb);

  it("adds infrastructure, AI, data, verification and card fees, against $0.04, per email, per month and per domain", async () => {
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const busy = await makePoolMailbox();
    const warming = await makePoolMailbox({ status: "WARMING", warmupDay: 3 });
    const now = new Date();
    const send = async (mailbox: { id: string; sendingDomainId: string | null }, n: number) => {
      for (let i = 0; i < n; i++) {
        const c = await makeContact(t.orgId, sendable(campaign.id));
        const sent = await prisma.send.create({ data: { organizationId: t.orgId, contactId: c.id, mailboxId: mailbox.id, domainId: mailbox.sendingDomainId, isFirstTouch: true, status: "DELIVERED", priceCharged: 40n, sentAt: new Date(now.getTime() - (i % 6) * DAY) } });
        await prisma.creditLedger.create({ data: { organizationId: t.orgId, seq: 1000 + i + (mailbox.id === busy.id ? 0 : 500), kind: "CHARGE", amount: -40n, balanceAfter: 0n, sendId: sent.id } });
      }
    };
    await send(busy, 210); // 30 a day
    await send(warming, 35); // 5 a day
    await prisma.aiUsage.create({ data: { organizationId: t.orgId, purpose: "personalize", model: "gpt-4.1-mini", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 250_000 } });
    await prisma.aiUsage.create({ data: { organizationId: t.orgId, purpose: "reply", model: "gpt-4.1-mini", inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 0 } });
    await prisma.usageCounter.create({ data: { organizationId: t.orgId, day: new Date(now.toISOString().slice(0, 10)), peopleEnriched: 100, searches: 10, emailsVerified: 1000, aiCalls: 5 } });
    await prisma.payment.create({ data: { organizationId: t.orgId, stripePaymentIntentId: "pi_1", amountCents: 10_000, status: "SUCCEEDED" } });
    await updateCostPrices({ apolloPerEnrichUsd: 0.05, apolloPerSearchUsd: 0, verifyPerEmailUsd: 0.001, paymentFeePercent: 3, paymentFeeFixedUsd: 0.3 }, t.userId);

    const s = await costStack(now);
    expect(s.emails).toBe(245);
    const line = (k: string) => s.lines.find((l) => l.key === k)!;
    // AI: 1M in x $0.40 + 250k out x $1.60 = $0.80; reply 500k in x $0.40 = $0.20.
    expect(line("ai").month).toBe(1);
    expect(line("data").month).toBe(5);
    expect(line("verification").month).toBe(1);
    expect(line("fees").month).toBe(3.3);
    expect(s.ai.byPurpose.find((p) => p.purpose === "reply")).toMatchObject({ calls: 1, usd: 0.2, avgInputTokens: 500_000 });
    // Five calls counted, two with tokens: three have no price.
    expect(s.ai.unmeasuredCalls).toBe(3);
    expect(s.total.month).toBeCloseTo(line("infrastructure").month + 10.3, 2);
    expect(s.total.perEmail).toBeCloseTo(s.total.month / 245, 4);
    expect(s.margin.perEmail).toBeCloseTo(0.04 - s.total.perEmail!, 5);
    expect(s.margin.revenueMonth).toBe(9.8);

    // Same infrastructure, a sixth of the volume: six times the infrastructure cost per email.
    const at = (id: string) => s.perDomain.find((d) => d.id === id)!;
    const fast = at(busy.sendingDomainId!);
    const slow = at(warming.sendingDomainId!);
    expect(fast.perDay).toBe(30);
    expect(slow.perDay).toBe(5);
    expect(slow.infraPerEmail! / fast.infraPerEmail!).toBeCloseTo(6, 1);
    expect(slow.costPerEmail!).toBeGreaterThan(fast.costPerEmail!);
    expect(s.perDomain[0].id).toBe(slow.id);
  });

  it("lets a platform admin change the unit prices, and nobody else", async () => {
    const t = await createTenant();
    await api().patch("/api/v1/admin/costs").set(t.auth).send({ verifyPerEmailUsd: 0.002 }).expect(403);
    await prisma.user.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    const before = (await api().get("/api/v1/admin/costs").set(t.auth).expect(200)).body.data;
    expect(before.verifyPerEmailUsd).toBe(DEFAULT_COST_PRICES.verifyPerEmailUsd);
    const after = (await api().patch("/api/v1/admin/costs").set(t.auth).send({ verifyPerEmailUsd: 0.002, aiPrices: { ...DEFAULT_COST_PRICES.aiPrices, "gpt-6-luna": { input: 3, cachedInput: 0.75, output: 12 } } }).expect(200)).body.data;
    expect(after.verifyPerEmailUsd).toBe(0.002);
    expect(after.aiPrices["gpt-6-luna"]).toEqual({ input: 3, cachedInput: 0.75, output: 12 });
    await api().patch("/api/v1/admin/costs").set(t.auth).send({ aiPrices: { "gpt-4.1": { input: 1, cachedInput: 1, output: 1 } } }).expect(400);
  });
});

describe("infrastructure prices", () => {
  beforeEach(resetDb);

  it("prices mailboxes and domains from the unit prices an operator can change, not from fixed numbers", async () => {
    const t = await createTenant();
    await prisma.user.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    await makePoolMailbox();
    await makePoolMailbox({ status: "REPLIES_ONLY" });
    // Defaults match what used to be fixed in code: $4 a mailbox, $3 a burned one, $15 a domain a year.
    expect((await costStack()).lines.find((l) => l.key === "infrastructure")!.month).toBe(4 + 3 + (2 * 15) / 12);
    await api().patch("/api/v1/admin/costs").set(t.auth).send({ mailboxMonthUsd: 5, repliesOnlyMailboxMonthUsd: 1, domainYearUsd: 24 }).expect(200);
    expect((await costStack()).lines.find((l) => l.key === "infrastructure")!.month).toBe(5 + 1 + (2 * 24) / 12);
  });
});
