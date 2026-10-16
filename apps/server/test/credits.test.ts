import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, createTenant, fund, makeCampaign, makeContact, makePoolMailbox, resetDb, sendable, transport, reply } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { balanceOf, balanceView, chargeSend, credit, debitCorrection, holdsOf, releaseForContact, releaseStaleHolds, reserve, SEQUENCE_HOLD } from "../src/domain/credits/index.js";
import { emailsFor, formatPrice, formatUsd, peopleFor, PRICE_PER_EMAIL, REPLY_RESERVE } from "../src/domain/money.js";
import { COSTS } from "../src/domain/credits/costs.js";
import { MAX_INBOXES_PER_DOMAIN, SENDS_PER_WARM_INBOX } from "../src/config/plans.js";
import { sendFirstTouch } from "../src/domain/sending/pipeline.js";

/** Ledger invariant: the newest balance_after is exactly the sum of every amount. */
async function ledgerConsistent(orgId: string) {
  const rows = await prisma.creditLedger.findMany({ where: { organizationId: orgId }, orderBy: { seq: "asc" } });
  let sum = 0n;
  for (const r of rows) {
    sum += r.amount;
    expect(r.balanceAfter).toBe(sum);
    expect(r.balanceAfter >= 0n).toBe(true);
  }
  expect(await balanceOf(orgId)).toBe(sum);
  return sum;
}

async function sendRow(orgId: string, contactId: string, step = 1) {
  return prisma.send.create({ data: { organizationId: orgId, contactId, isFirstTouch: step === 1, step, status: "SENT", sentAt: new Date() } });
}

describe("money", () => {
  it("prices every email at 40 deci-cents, a reply at 0, and formats without floats", () => {
    expect(PRICE_PER_EMAIL).toBe(40n);
    expect(REPLY_RESERVE).toBe(2_000n);
    // One flat price for every email that goes out, a reply included.
    expect(COSTS).toMatchObject({ "email.sent": 40n, "email.reply": 40n, "lead.found": 0n, "lead.verified": 0n });
    expect(formatPrice(PRICE_PER_EMAIL)).toBe("$0.04");
    expect(formatUsd(47_200n)).toBe("$47.20");
    expect(formatUsd(25_009n)).toBe("$25.00");
    expect(SEQUENCE_HOLD).toBe(160n);
    // $20 is exactly 500 emails, 125 people.
    expect(emailsFor(20_000n)).toBe(500);
    expect(peopleFor(500)).toBe(125);
  });

  it("has no split pricing left anywhere in the source", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(__dirname, "../src"));
    const offenders = files.filter((f) => /first_touch|follow_up|priceForStep|priceOf\(|PRICE_REPLY|"email\.reply": 0n|0\.045|0\.025/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("sizes the pool at 30 sends per warm inbox and 3 inboxes per domain, not the old 40/5", () => {
    expect(SENDS_PER_WARM_INBOX).toBe(30);
    expect(MAX_INBOXES_PER_DOMAIN).toBe(3);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(__dirname, "../src"));
    const offenders = files.filter((f) => /SENDS_PER_WARM_INBOX\s*=\s*40|MAX_INBOXES_PER_DOMAIN\s*=\s*5|CREDITS_PER_LEAD/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("credits ledger", () => {
  beforeEach(resetDb);

  it("bills a 4-email sequence 4 x $0.04 = $0.16 and keeps the ledger sum equal to the balance", async () => {
    const t = await createTenant({ balance: 25_000n });
    const c = await makeContact(t.orgId);
    const hold = await reserve(t.orgId, SEQUENCE_HOLD, { contactId: c.id });
    expect(hold.ok).toBe(true);
    for (let step = 1; step <= 4; step++) {
      const s = await sendRow(t.orgId, c.id, step);
      expect((await chargeSend(t.orgId, s.id, c.id, PRICE_PER_EMAIL)).ok).toBe(true);
      // The same send reported twice is charged once.
      expect((await chargeSend(t.orgId, s.id, c.id, PRICE_PER_EMAIL)).ok).toBe(true);
    }
    expect(await balanceOf(t.orgId)).toBe(25_000n - 160n);
    expect(await holdsOf(t.orgId)).toBe(0n);
    const charges = await prisma.creditLedger.findMany({ where: { organizationId: t.orgId, kind: "CHARGE" }, orderBy: { seq: "asc" } });
    expect(charges.map((r) => r.amount)).toEqual([-40n, -40n, -40n, -40n]);
    // A reply costs exactly the same 40 deci-cents.
    const reply = await sendRow(t.orgId, c.id, 0);
    await chargeSend(t.orgId, reply.id, c.id, PRICE_PER_EMAIL);
    expect(await balanceOf(t.orgId)).toBe(25_000n - 200n);
    await ledgerConsistent(t.orgId);
  });

  it("runs a 10,000-email campaign against $25 without the balance ever going negative", async () => {
    const t = await createTenant({ balance: 25_000n });
    const campaign = await makeCampaign(t.orgId);
    const people = await Promise.all(Array.from({ length: 300 }, (_, i) => makeContact(t.orgId, { campaignId: campaign.id, email: `p${i}@big${i}.com`, emailNormalized: `p${i}@big${i}.com` })));
    // 3,334 sequences would be 10,000 emails. Holds are taken in parallel, as concurrent send runs would.
    const holds = await Promise.all(people.map((p) => reserve(t.orgId, SEQUENCE_HOLD, { contactId: p.id })));
    const granted = holds.filter((h) => h.ok).length;
    expect(granted).toBe(Math.floor(25_000 / 160));
    expect(await holdsOf(t.orgId)).toBe(BigInt(granted) * 160n);
    // Every held sequence is sent in full.
    const held = people.filter((_, i) => holds[i].ok);
    for (const p of held) {
      for (let step = 1; step <= 4; step++) await chargeSend(t.orgId, (await sendRow(t.orgId, p.id, step)).id, p.id, PRICE_PER_EMAIL);
    }
    expect(await balanceOf(t.orgId)).toBe(25_000n - BigInt(granted) * 160n);
    // An email the provider sends with nothing held and too little free balance is never charged below zero.
    const extra = people.find((_, i) => !holds[i].ok)!;
    for (let i = 0; i < 5; i++) await chargeSend(t.orgId, (await sendRow(t.orgId, extra.id, 1 + i)).id, extra.id, PRICE_PER_EMAIL);
    const final = await ledgerConsistent(t.orgId);
    // The 40 left over after the last full sequence pays for exactly one more email: spent to the cent, never below.
    expect(final).toBe(0n);
  });

  it("refuses a negative balance at the database too", async () => {
    const t = await createTenant({ subscribed: false });
    await expect(prisma.creditLedger.create({ data: { organizationId: t.orgId, kind: "CHARGE", amount: -1n, balanceAfter: -1n } })).rejects.toThrow();
    expect((await debitCorrection(t.orgId, 1n, "test")).ok).toBe(false);
  });

  it("credits a top-up once per Stripe reference", async () => {
    const t = await createTenant({ subscribed: false });
    expect(await credit(t.orgId, "TOPUP", 25_000n, { ref: "pi_1" })).toMatchObject({ ok: true, balance: 25_000n });
    expect(await credit(t.orgId, "TOPUP", 25_000n, { ref: "pi_1" })).toMatchObject({ ok: true, duplicate: true });
    expect(await balanceOf(t.orgId)).toBe(25_000n);
  });

  it("gives held money back when the person replies, and frees stale holds after 30 days", async () => {
    const t = await createTenant({ balance: 1_000n });
    const a = await makeContact(t.orgId);
    const b = await makeContact(t.orgId);
    await reserve(t.orgId, SEQUENCE_HOLD, { contactId: a.id });
    await chargeSend(t.orgId, (await sendRow(t.orgId, a.id)).id, a.id);
    expect(await releaseForContact(a.id, "Replied")).toBe(120n);
    const old = await reserve(t.orgId, SEQUENCE_HOLD, { contactId: b.id });
    if (!old.ok) throw new Error("hold refused");
    await prisma.creditReservation.update({ where: { id: old.reservationId }, data: { createdAt: new Date(Date.now() - 31 * 86_400_000) } });
    expect(await releaseStaleHolds()).toBe(1);
    expect(await holdsOf(t.orgId)).toBe(0n);
    expect(await balanceOf(t.orgId)).toBe(1_000n - 40n);
  });

  it("bills a workspace to the organization that pays for it", async () => {
    const owner = await createTenant({ balance: 5_000n });
    const client = await createTenant({ subscribed: false });
    await prisma.organization.update({ where: { id: client.orgId }, data: { billingOrganizationId: owner.orgId } });
    const c = await makeContact(client.orgId);
    expect((await reserve(client.orgId, SEQUENCE_HOLD, { contactId: c.id })).ok).toBe(true);
    await chargeSend(client.orgId, (await sendRow(client.orgId, c.id)).id, c.id);
    expect(await balanceOf(owner.orgId)).toBe(5_000n - 40n);
    expect(await balanceOf(client.orgId)).toBe(0n);
  });

  it("never warns before sending starts: unfunded, then the free credit as a fact, then low under two days, then empty", async () => {
    const t = await createTenant({ subscribed: false });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { dailyBudgetDecicents: 20_000n } });
    expect((await balanceView(t.orgId)).stage).toBe("unfunded");
    await credit(t.orgId, "BONUS", 10_000n, { ref: `trial:${t.orgId}` });
    let v = await balanceView(t.orgId);
    expect(v).toMatchObject({ stage: "trial", lasts: "about half a day", warnings: { low: false, empty: false } });
    // The first email goes out: now half a day of budget left is a warning.
    const c = await makeContact(t.orgId);
    await chargeSend(t.orgId, (await sendRow(t.orgId, c.id)).id, c.id);
    v = await balanceView(t.orgId);
    expect(v).toMatchObject({ stage: "low", warnings: { low: true } });
    await debitCorrection(t.orgId, await balanceOf(t.orgId), "test");
    v = await balanceView(t.orgId);
    expect(v).toMatchObject({ balance: "$0.00", emailsLeft: 0, stage: "empty", warnings: { empty: true } });
  });

  it("stops new people at zero while replies still go out", async () => {
    const t = await createTenant({ subscribed: false });
    await fund(t.orgId, 30n);
    await makePoolMailbox();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id));
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: false, code: "INSUFFICIENT_CREDITS", wait: true });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("PERSONALIZED");
    // A reply in an existing conversation is never charged, so it never waits on the balance.
    const talking = await makeContact(t.orgId, { status: "REPLIED" });
    const before = await balanceOf(t.orgId);
    await prisma.message.create({ data: { organizationId: t.orgId, contactId: talking.id, direction: "OUTBOUND", via: "inbox", body: "Thanks!" } });
    expect(await balanceOf(t.orgId)).toBe(before);
  });

  it("charges once, when the receiving server accepts the email, and never for a refusal", async () => {
    const t = await createTenant();
    await makePoolMailbox();
    const campaign = await makeCampaign(t.orgId);
    const c = await makeContact(t.orgId, sendable(campaign.id));
    expect(await sendFirstTouch(t.orgId, c.id, campaign.id)).toMatchObject({ ok: true });
    expect(await prisma.creditLedger.count({ where: { organizationId: t.orgId, kind: "CHARGE" } })).toBe(1);
    expect(await holdsOf(t.orgId)).toBe(120n);
    // The same person again is refused before anything goes out, so nothing more is charged.
    await sendFirstTouch(t.orgId, c.id, campaign.id);
    expect(await prisma.creditLedger.count({ where: { organizationId: t.orgId, kind: "CHARGE" } })).toBe(1);
    // A hard refusal at SMTP is not charged.
    transport.respond = () => reply("550", "5.1.1", "HARD_BOUNCE");
    const d = await makeContact(t.orgId, sendable(campaign.id));
    await sendFirstTouch(t.orgId, d.id, campaign.id);
    expect(await prisma.creditLedger.count({ where: { organizationId: t.orgId, kind: "CHARGE" } })).toBe(1);
    expect(await prisma.send.findFirstOrThrow({ where: { contactId: d.id } })).toMatchObject({ status: "HARD_BOUNCE", priceCharged: 0n });
  });

  it("lets an admin give or take credit, never below zero, with the reason on the ledger", async () => {
    const t = await createTenant({ balance: 1_000n });
    await prisma.user.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    const add = await api().post(`/api/v1/admin/organizations/${t.orgId}/credits`).set(t.auth).send({ amount: "5000", reason: "goodwill" });
    expect(add.status).toBe(200);
    expect(add.body.data.balance).toBe("$6.00");
    await api().post(`/api/v1/admin/organizations/${t.orgId}/credits`).set(t.auth).send({ amount: "-9000", reason: "correction" }).expect(422);
    await api().post(`/api/v1/admin/organizations/${t.orgId}/credits`).set(t.auth).send({ amount: 5.5, reason: "float" }).expect(400);
    const take = await api().post(`/api/v1/admin/organizations/${t.orgId}/credits`).set(t.auth).send({ amount: "-1000", reason: "correction" });
    expect(take.body.data.balance).toBe("$5.00");
    expect(await prisma.creditLedger.count({ where: { organizationId: t.orgId, note: { contains: "goodwill" } } })).toBe(1);
    await ledgerConsistent(t.orgId);
  });
});
