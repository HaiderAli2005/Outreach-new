import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeContact, makePoolMailbox, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { evaluateDomainHealth } from "../src/domain/pool/lifecycle.js";
import { cachedConsole, consoleView, CONSOLE_VERSION, rollUpDomainHealth, shelfRunway, snapshotPoolMetrics } from "../src/domain/pool/metrics.js";
import { dateOnly, dayKeyOf } from "../src/lib/time.js";
import { setTxtResolver } from "../src/domain/pool/auth.js";
import { generateKeyPairSync } from "node:crypto";

const DAY = 86_400_000;

async function sends(orgId: string, mailboxId: string, domainId: string, n: number, bad: number) {
  const c = await makeContact(orgId, { status: "CONTACTED" });
  const t0 = Date.now() - n * 60_000;
  await prisma.send.createMany({ data: Array.from({ length: n }, (_, i) => ({ organizationId: orgId, contactId: c.id, mailboxId, domainId, isFirstTouch: true, step: 1, status: i < bad ? "HARD_BOUNCE" : "SENT", sentAt: new Date(t0 + i * 60_000) })) });
}

async function admin() {
  const a = await createTenant();
  await prisma.user.update({ where: { id: a.userId }, data: { isPlatformAdmin: true } });
  return a;
}

/** DNS that resolves SPF, a 2048-bit DKIM key under "default", and DMARC. */
function goodDns() {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  setTxtResolver(async (name) => (name.startsWith("_dmarc.") ? [["v=DMARC1; p=none"]] : name.includes("._domainkey.") ? (name.startsWith("default.") ? [[`v=DKIM1; k=rsa; p=${key}`]] : []) : [["v=spf1 include:_spf.test ~all"]]));
}

describe("pool operator control", () => {
  beforeEach(resetDb);

  it("stores why a domain burned, at what rate over how many sends, and shows it with how long it lasted", async () => {
    const t = await createTenant();
    const m = await makePoolMailbox();
    await prisma.sendingDomain.update({ where: { id: m.sendingDomainId! }, data: { activatedAt: new Date(Date.now() - 20 * DAY) } });
    await sends(t.orgId, m.id, m.sendingDomainId!, 200, 12);
    await evaluateDomainHealth();
    const d = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: m.sendingDomainId! } });
    expect(d).toMatchObject({ status: "DEGRADED", degradeSends: 200, degradeReason: "6.0% of its last 200 emails bounced" });
    expect(Number(d.degradeBounceRate)).toBe(0.06);
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).degradeReason).toBe(`its domain ${d.name} degraded`);
    const view = await consoleView();
    expect(view.burned).toEqual([expect.objectContaining({ domain: d.name, kind: "degraded", reason: "6.0% of its last 200 emails bounced", bounceRate: 0.06, sends: 200, daysLasted: 20 })]);
  });

  it("charts what burned mailboxes still carry: lost capacity, cost, live conversations and the customers behind them", async () => {
    const t = await createTenant();
    const u = await createTenant();
    const m = await makePoolMailbox();
    await sends(t.orgId, m.id, m.sendingDomainId!, 200, 12);
    await makeContact(t.orgId, { assignedMailboxId: m.id, status: "REPLIED", hasInbound: true, lastMessageAt: new Date() });
    await makeContact(u.orgId, { assignedMailboxId: m.id, status: "CONTACTED" });
    await makeContact(u.orgId, { assignedMailboxId: m.id, status: "REPLIED", hasInbound: true, lastMessageAt: new Date(Date.now() - 40 * DAY) });
    await evaluateDomainHealth();
    const view = await consoleView();
    expect(view.charts.burnImpact).toMatchObject({ mailboxes: 1, domains: 1, capacityLost: 30, liveConversations: 1, sequencesRunning: 1, customersAffected: 2 });
    expect(view.charts.burnImpact.monthlyCostCents).toBeGreaterThanOrEqual(300);
    expect(view.burned[0].reasonKind).toBe("bounces");
    expect(view.charts.mailboxes.REPLIES_ONLY).toBe(1);
    expect(view.charts.domains.DEGRADED).toBe(1);
    expect(view.charts.daily).toHaveLength(30);
    expect(view.charts.daily.at(-1)).toMatchObject({ day: dayKeyOf(new Date()), sends: 200 });
  });

  it("claims no runway while nothing burns, and counts burn against every domain that was sending", async () => {
    await makePoolMailbox({ domainStatus: "AGING", status: "WARMING", warmupDay: 0 });
    const active = await makePoolMailbox();
    let view = await consoleView();
    // Dividing by a floor of 0.1 used to turn one spare into "10 weeks of runway" with nothing burning.
    expect(view.shelf.warmShelf).toBe(1);
    expect(view.shelf.runwayWeeks).toBeNull();

    // One burned and one still active: half of the domains that sent in 30 days, not 100% of today's active ones.
    const burned = await makePoolMailbox({ domainStatus: "DEGRADED", status: "REPLIES_ONLY" });
    await prisma.sendingDomain.update({ where: { id: burned.sendingDomainId! }, data: { degradedAt: new Date() } });
    view = await consoleView();
    expect(view.health.activeDomains).toBe(1);
    expect(view.burn.burnRatePerMonth).toBe("50.0%");
    expect(view.shelf.runwayWeeks).not.toBeNull();
    expect(active.id).toBeTruthy();
  });

  it("weighs a complaint as ten bounces in the pool's bad rate, and counts lost capacity at each mailbox's warmup step", async () => {
    const t = await createTenant();
    const m = await makePoolMailbox();
    const c = await makeContact(t.orgId, { status: "CONTACTED" });
    const t0 = Date.now() - 100 * 60_000;
    await prisma.send.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ organizationId: t.orgId, contactId: c.id, mailboxId: m.id, domainId: m.sendingDomainId!, isFirstTouch: true, step: 1, status: i === 0 ? "COMPLAINT" : "SENT", sentAt: new Date(t0 + i * 60_000) })) });
    await rollUpDomainHealth();
    // A mailbox that burned on warmup day 3 was sending 5 a day, not the full 30.
    await makePoolMailbox({ status: "REPLIES_ONLY", warmupDay: 3 });
    const view = await consoleView();
    expect(view.charts.daily.at(-1)).toMatchObject({ sends: 100, bad: 10, badRate: 0.1 });
    expect(view.charts.burnImpact).toMatchObject({ mailboxes: 1, capacityLost: 5 });
  });

  it("states a risk band, never a time to burn", async () => {
    const view = await consoleView();
    for (const r of view.atRisk) expect(["at risk", "watch"]).toContain(r.band);
    expect(JSON.stringify(view)).not.toMatch(/within \d week/);
  });

  it("serves a cached console only when it has the current shape", async () => {
    await prisma.poolMetricsDaily.create({ data: { day: dateOnly(dayKeyOf(new Date())), activeDomains: 0, warmingDomains: 0, activeMailboxes: 0, warmingMailboxes: 0, repliesOnlyMailboxes: 0, domainsDegraded: 0, domainsRetired: 0, ewmaWeeklyBurn: 0, console: { health: {} }, consoleAt: new Date() } });
    const view = (await cachedConsole()) as { version?: number; charts?: unknown };
    expect(view.version).toBe(CONSOLE_VERSION);
    expect(view.charts).toBeDefined();
    await makePoolMailbox({ cap: 20 });
    expect(await snapshotPoolMetrics()).toMatchObject({ capacity: 20, committed: 0 });
  });

  it("picks the reorder driver: burn, the spare shelf, or demand outgrowing the pool, capped at the batch size", () => {
    const base = { spareDomainsMin: 0, spareMultiplier: 1, maxBuyPerBatch: 50, committed: 0, capacityTotal: 10_000 };
    expect(shelfRunway(6, 1.5, base).reorderBecause).toMatchObject({ burnReplacement: 8, driver: "burnReplacement" });
    expect(shelfRunway(6, 0, { ...base, spareDomainsMin: 15 }).reorderBecause).toMatchObject({ burnReplacement: 0, spareShortfall: 9, driver: "spareShortfall" });
    const demand = shelfRunway(20, 0, { ...base, committed: 12_000, spareMultiplier: 1.5 });
    expect(demand.reorderBecause.driver).toBe("demandShortfall");
    expect(demand.reorderBecause.demandShortfall).toBeGreaterThan(0);
    expect(shelfRunway(6, 0, { ...base, spareDomainsMin: 15, maxBuyPerBatch: 5 }).domainsToBuy).toBe(5);
    expect(shelfRunway(20, 0, base)).toMatchObject({ reorder: false, domainsToBuy: 0, reorderBecause: { driver: null } });
    // An empty shelf with nothing burning is a spare-minimum problem, never a burn one.
    expect(shelfRunway(0, 0, { ...base, spareDomainsMin: 15, maxBuyPerBatch: 5 }).reorderBecause).toMatchObject({ burnReplacement: 0, spareShortfall: 15, driver: "spareShortfall" });
  });

  it("shows warming domains soonest first, with a projected date and held ones flagged", async () => {
    const fast = await makePoolMailbox({ status: "WARMING", domainStatus: "WARMING", warmupDay: 20 });
    const slow = await makePoolMailbox({ status: "WARMING", domainStatus: "WARMING", warmupDay: 5 });
    await prisma.mailbox.update({ where: { id: fast.id }, data: { warmupStartedAt: new Date(Date.now() - 19.5 * DAY), sendCapToday: 20 } });
    await prisma.mailbox.update({ where: { id: slow.id }, data: { warmupStartedAt: new Date(Date.now() - 10.5 * DAY), sendCapToday: 5 } });
    const view = await consoleView();
    expect(view.shelf.warming.map((w: { mailboxes: number; warmupDay: number; daysRemaining: number; held: boolean }) => [w.warmupDay, w.daysRemaining, w.held])).toEqual([
      [20, 9, false],
      [5, 24, true],
    ]);
  });

  it("promotes a warming domain early only when DNS resolves, DKIM verified within 3 days and bounces are under 2%", async () => {
    const op = await admin();
    const t = await createTenant();
    const m = await makePoolMailbox({ status: "WARMING", domainStatus: "WARMING", warmupDay: 12 });
    const id = m.sendingDomainId!;
    const go = (reason = "Customer launch needs volume this week") => api().post(`/api/v1/admin/pool/domains/${id}/activate-now`).set(op.auth).send({ reason });

    await go("too short").expect(400);
    let r = await go().expect(422);
    expect(r.body.error.message).toMatch(/SPF, DKIM, DMARC do not resolve/);

    goodDns();
    r = await go().expect(422);
    expect(r.body.error.message).toMatch(/DKIM signature has not passed the seed test/);
    await prisma.sendingDomain.update({ where: { id }, data: { dkimVerifiedAt: new Date(Date.now() - 4 * DAY) } });
    r = await go().expect(422);
    expect(r.body.error.message).toMatch(/last 3 days/);

    await prisma.sendingDomain.update({ where: { id }, data: { dkimVerifiedAt: new Date(Date.now() - DAY) } });
    await sends(t.orgId, m.id, id, 100, 2);
    r = await go().expect(422);
    expect(r.body.error.message).toMatch(/7-day bounce rate is 2.0%/);

    await prisma.send.deleteMany({ where: { domainId: id } });
    await sends(t.orgId, m.id, id, 100, 1);
    r = await go().expect(200);
    expect(r.body.data).toMatchObject({ fromDay: 12 });
    const d = await prisma.sendingDomain.findUniqueOrThrow({ where: { id } });
    expect(d).toMatchObject({ status: "ACTIVE", forcedActiveById: op.userId, forcedActiveReason: "Customer launch needs volume this week", forcedFromDay: 12 });
    expect(d.forcedActiveAt).toBeInstanceOf(Date);
    expect(await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "ACTIVE", sendCapToday: 30 });
    const log = await prisma.systemLog.findFirst({ where: { level: "CRITICAL", source: "pool" } });
    expect(log?.message).toContain(`promoted ${d.name} to active early, from warmup day 12`);
    expect((await consoleView()).forced).toEqual([expect.objectContaining({ domain: d.name, fromDay: 12 })]);
  });

  it("keeps the restock targets in one editable row, for platform admins only", async () => {
    const op = await admin();
    const t = await createTenant();
    expect((await api().get("/api/v1/admin/pool/settings").set(op.auth).expect(200)).body.data).toMatchObject({ spareDomainsMin: 15, spareMultiplier: 1, maxBuyPerBatch: 5, maxBuyPerDay: 10, autoBuyEnabled: false });
    await api().patch("/api/v1/admin/pool/settings").set(t.auth).send({ spareDomainsMin: 20 }).expect(403);
    expect((await api().patch("/api/v1/admin/pool/settings").set(op.auth).send({ spareDomainsMin: 20, spareMultiplier: 1.25 }).expect(200)).body.data).toMatchObject({ spareDomainsMin: 20, spareMultiplier: 1.25 });
    expect((await consoleView()).shelf.targets).toMatchObject({ spareDomainsMin: 20, spareMultiplier: 1.25 });
  });
});
