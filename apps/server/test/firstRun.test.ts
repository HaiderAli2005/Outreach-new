import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, fund, makeCapacity, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setApolloFactory } from "../src/integrations/apollo.js";
import { settleFirstRuns } from "../src/modules/onboarding/firstRun.js";

async function launched() {
  const t = await createTenant({ subscribed: false, approved: false });
  await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
  await prisma.onboarding.update({ where: { organizationId: t.orgId }, data: { summary: "x", icp: { industries: ["SaaS"], titles: ["CEO"], sizes: ["11 to 50"], regions: ["United Kingdom"] } } });
  await makeCapacity(500);
  await fund(t.orgId, 25_000n);
  return t;
}

describe("the first run after launch", () => {
  beforeEach(resetDb);

  it("starts finding at launch, and says exactly why it stopped when finding is not set up", async () => {
    const t = await launched();
    const res = await api().post("/api/v1/onboarding/launch").set(t.auth).expect(200);
    // Started by the launch itself (it may already have finished: with no Apollo it stops at once).
    expect(res.body.data.state.firstRun).toMatchObject({ found: 0, needsApproval: true, approveCount: 20 });
    expect(["running", "failed"]).toContain(res.body.data.state.firstRun.state);
    await settleFirstRuns();
    const after = (await api().get("/api/v1/onboarding").set(t.auth).expect(200)).body.data.firstRun;
    expect(after).toMatchObject({ state: "failed", reason: "apollo-not-configured" });
  });

  it("runs outside the weekly batch, so a weekday launch does not wait for Sunday, and can be tried again", async () => {
    const t = await launched();
    const searches: number[] = [];
    setApolloFactory(async () => ({ searchPeople: async (_f: Record<string, unknown>, page: number) => (searches.push(page), { people: [], totalEntries: 0 }), bulkEnrich: async () => [] }));
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: true } });
    await api().post("/api/v1/onboarding/launch").set(t.auth).expect(200);
    await settleFirstRuns();
    expect(searches.length).toBeGreaterThan(0);
    expect((await api().get("/api/v1/onboarding").set(t.auth)).body.data.firstRun).toMatchObject({ state: "failed", reason: "nobody-found" });

    const before = (await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } })).firstRunStartedAt!;
    await api().post("/api/v1/onboarding/first-run").set(t.auth).expect(200);
    await settleFirstRuns();
    const o = await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(o.firstRunStartedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(o.firstRunFinishedAt).not.toBeNull();
  });

  it("is not part of the state before launch", async () => {
    const t = await createTenant();
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    expect((await api().get("/api/v1/onboarding").set(t.auth)).body.data.firstRun).toBeNull();
  });
});

describe("first runs at scale", () => {
  beforeEach(resetDb);

  it("runs once however many times it is started at the same moment (two servers, two clicks)", async () => {
    const t = await launched();
    let searches = 0;
    setApolloFactory(async () => ({ searchPeople: async () => (searches++, { people: [], totalEntries: 0 }), bulkEnrich: async () => [] }));
    await prisma.onboarding.update({ where: { organizationId: t.orgId }, data: { launchedAt: new Date() } });
    const { startFirstRun } = await import("../src/modules/onboarding/firstRun.js");
    const started = await Promise.all([startFirstRun(t.orgId), startFirstRun(t.orgId), startFirstRun(t.orgId)]);
    await settleFirstRuns();
    expect(started.filter(Boolean)).toHaveLength(1);
    expect(searches).toBe(0);
    expect((await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } })).firstRunResult).toMatchObject({ ok: false, reason: "no-active-campaign" });
  });

  it("picks up a launch whose run never started, and one cut off by a restart, a few at a time", async () => {
    const { runPendingFirstRuns } = await import("../src/modules/onboarding/firstRun.js");
    const never = await launched();
    const cut = await launched();
    const old = await launched();
    await prisma.onboarding.update({ where: { organizationId: never.orgId }, data: { launchedAt: new Date() } });
    await prisma.onboarding.update({ where: { organizationId: cut.orgId }, data: { launchedAt: new Date(), firstRunStartedAt: new Date(Date.now() - 20 * 60_000) } });
    // Launched weeks ago: on its normal schedule, never given a first run.
    await prisma.onboarding.update({ where: { organizationId: old.orgId }, data: { launchedAt: new Date(Date.now() - 30 * 86_400_000) } });
    expect(await runPendingFirstRuns()).toEqual({ ran: 2 });
    for (const t of [never, cut]) expect((await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } })).firstRunFinishedAt).not.toBeNull();
    expect((await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: old.orgId } })).firstRunStartedAt).toBeNull();
    expect(await runPendingFirstRuns()).toEqual({ ran: 0 });
  });
});
