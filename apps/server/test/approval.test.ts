import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, makePoolMailbox, resetDb, sendable, transport } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setApolloFactory, type ApolloPerson } from "../src/integrations/apollo.js";
import { setVerifierFactory } from "../src/integrations/verifier.js";
import { sourceForOrg } from "../src/jobs/sourcing.js";
import { personalizeNew, pushQueue, verifyNew } from "../src/jobs/send.js";
import { sendFirstTouch, sendFollowUp } from "../src/domain/sending/pipeline.js";
import { handoffToReview } from "../src/domain/batches.js";

/** Nobody is emailed unless a person approved them, uploaded them, or the workspace chose to auto-approve. */

const person = (i: number): ApolloPerson => ({
  id: `ap${i}`,
  first_name: "Sam",
  last_name: `Price${i}`,
  title: "CEO",
  email: `sam${i}@acme${i}.com`,
  email_status: "verified",
  linkedin_url: `https://linkedin.com/in/sam${i}`,
  organization: { name: `Acme ${i}`, website_url: `https://acme${i}.com`, primary_domain: `acme${i}.com`, estimated_num_employees: 40 },
});

function fakeApollo() {
  const calls = { search: 0, enrich: 0 };
  setApolloFactory(async () => ({
    searchPeople: async () => (calls.search++, { people: [person(1), person(2)], totalEntries: 2 }),
    bulkEnrich: async (ids: { id?: string }[]) => (calls.enrich++, ids.map((x) => person(Number(String(x.id).slice(2))))),
  }));
  return calls;
}

const okVerifier = () => setVerifierFactory(async () => async () => ({ configured: true, ok: true, bad: false, transient: false, result: "ok", quality: "good" }));

/** What the writer would produce, without the AI: the person becomes ready to send, approval untouched. */
const written = (id: string, campaignId: string) => {
  const { approvedAt: _a, approvalSource: _s, ...ready } = sendable(campaignId);
  return prisma.contact.update({ where: { id }, data: { ...ready, firstName: "Lead" } as never });
};

async function workspace(weeklyBatchMode: boolean) {
  await makePoolMailbox();
  const t = await createTenant();
  await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode, autopilotEnabled: true } });
  const campaign = await makeCampaign(t.orgId);
  return { t, campaign };
}

/** The two migrations' data steps, as they run on a live database. */
async function runBackfill() {
  const read = (name: string) => readFileSync(join(__dirname, `../prisma/migrations/${name}/migration.sql`), "utf8");
  const first = read("20261018120000_contact_approval");
  const sql = first.slice(first.indexOf("-- Backfill")) + ";" + read("20261019120000_narrow_approval_backfill");
  for (const stmt of sql.split(";").map((x) => x.replace(/--.*$/gm, "").trim()).filter(Boolean)) await prisma.$executeRawUnsafe(stmt);
}

describe("approval", () => {
  beforeEach(resetDb);

  for (const weeklyBatchMode of [true, false]) {
    it(`never sends a person found by sourcing until someone approves them (weekly review ${weeklyBatchMode ? "on" : "off"})`, async () => {
      const { t, campaign } = await workspace(weeklyBatchMode);
      fakeApollo();
      okVerifier();
      const r = await sourceForOrg(t.orgId, { force: true });
      expect(r).toMatchObject({ inserted: 2 });
      const found = await prisma.contact.findMany({ where: { organizationId: t.orgId } });
      expect(found).toHaveLength(2);
      for (const c of found) expect(c).toMatchObject({ source: "apollo", approvedAt: null, approvalSource: null });

      // Checked and written so a person can review the real emails, but never sent.
      expect((await verifyNew(t.orgId)).good).toBe(2);
      await personalizeNew(t.orgId);
      for (const c of found) await written(c.id, campaign.id);
      expect(await pushQueue(t.orgId, { ignoreWindow: true })).toMatchObject({ pushed: 0, reason: "awaiting_approval" });
      expect(transport.sent).toHaveLength(0);
      expect(await prisma.contact.count({ where: { organizationId: t.orgId, approvedAt: { not: null } } })).toBe(0);

      await api().post("/api/v1/launch/approve-people").set(t.auth).send({ ids: found.map((c) => c.id), consent: false }).expect(200);
      expect(await prisma.contact.findFirstOrThrow({ where: { organizationId: t.orgId } })).toMatchObject({ approvalSource: "review" });
      expect((await pushQueue(t.orgId, { ignoreWindow: true })).pushed).toBe(2);
    });
  }

  it("turning weekly review off makes no unapproved person sendable", async () => {
    const { t, campaign } = await workspace(true);
    const c = await makeContact(t.orgId, sendable(campaign.id, { source: "apollo", batchId: null, approvedAt: null, approvalSource: null }));
    expect((await pushQueue(t.orgId, { ignoreWindow: true })).pushed).toBe(0);
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false } });
    expect((await pushQueue(t.orgId, { ignoreWindow: true })).pushed).toBe(0);
    expect(transport.sent).toHaveLength(0);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).approvedAt).toBeNull();
  });

  it("auto-approves found people only when the workspace turned that on", async () => {
    const { t } = await workspace(false);
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).autoApproveBatches).toBe(false);
    fakeApollo();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autoApproveBatches: true } });
    await sourceForOrg(t.orgId, { force: true });
    const found = await prisma.contact.findMany({ where: { organizationId: t.orgId } });
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) expect(c.approvalSource).toBe("auto");
  });

  it("an uploaded list is approved by the upload, has no weekly list, and sends with no approval step", async () => {
    await makePoolMailbox();
    const t = await createTenant({ approved: false });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: true } });
    const campaign = await makeCampaign(t.orgId);
    const res = await api().post("/api/v1/contacts/import").set(t.auth).send({ text: "email,first name,company,website\nann@one.com,Ann,One,one.com\n" }).expect(200);
    expect(res.body.data.imported).toBe(1);
    expect(res.body.data).not.toHaveProperty("batchId");
    const c = await prisma.contact.findFirstOrThrow({ where: { organizationId: t.orgId } });
    expect(c).toMatchObject({ source: "csv", batchId: null, approvalSource: "upload" });
    expect(c.approvedAt).not.toBeNull();
    expect(await prisma.weeklyBatch.count({ where: { organizationId: t.orgId } })).toBe(0);
    await written(c.id, campaign.id);
    expect((await pushQueue(t.orgId, { ignoreWindow: true })).pushed).toBe(1);
  });

  it("with finding turned off, makes no Apollo call and adds nobody, while people already on the list still send", async () => {
    const { t, campaign } = await workspace(false);
    const calls = fakeApollo();
    await makeContact(t.orgId, sendable(campaign.id));
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { leadSourcing: "OFF" } });
    expect(await sourceForOrg(t.orgId, { force: true })).toEqual({ skipped: "sourcing-off" });
    expect(calls).toEqual({ search: 0, enrich: 0 });
    expect(await prisma.contact.count({ where: { organizationId: t.orgId } })).toBe(1);
    expect((await pushQueue(t.orgId, { ignoreWindow: true })).pushed).toBe(1);
  });

  it("approving a week approves the people in it, and they then send", async () => {
    const { t, campaign } = await workspace(true);
    const batch = await prisma.weeklyBatch.create({ data: { organizationId: t.orgId, weekStart: new Date("2030-01-07"), status: "REVIEW" } });
    const people = await Promise.all([1, 2].map(() => makeContact(t.orgId, sendable(campaign.id, { batchId: batch.id, approvedAt: null, approvalSource: null }))));
    expect((await pushQueue(t.orgId, { ignoreWindow: true })).pushed).toBe(0);
    await api().post(`/api/v1/batches/${batch.id}/approve`).set(t.auth).send({}).expect(200);
    for (const p of people) {
      const c = await prisma.contact.findUniqueOrThrow({ where: { id: p.id } });
      expect(c.approvalSource).toBe("review");
      expect(c.approvedAt).not.toBeNull();
    }
    expect((await pushQueue(t.orgId, { ignoreWindow: true })).pushed).toBe(2);
  });

  it("the migration backfill keeps an unapproved Apollo person unsendable", async () => {
    const { t, campaign } = await workspace(false);
    const approvedWeek = await prisma.weeklyBatch.create({ data: { organizationId: t.orgId, weekStart: new Date("2026-10-05"), status: "APPROVED", approvedAt: new Date("2026-10-04") } });
    const openWeek = await prisma.weeklyBatch.create({ data: { organizationId: t.orgId, weekStart: new Date("2026-10-12"), status: "REVIEW" } });
    const unapproved = { approvedAt: null, approvalSource: null };
    const loose = await makeContact(t.orgId, sendable(campaign.id, { ...unapproved, source: "apollo", batchId: null }));
    const inOpenWeek = await makeContact(t.orgId, sendable(campaign.id, { ...unapproved, source: "apollo", batchId: openWeek.id }));
    const inApprovedWeek = await makeContact(t.orgId, sendable(campaign.id, { ...unapproved, source: "apollo", batchId: approvedWeek.id }));
    const uploaded = await makeContact(t.orgId, sendable(campaign.id, { ...unapproved, source: "csv" }));

    await runBackfill();

    const read = (id: string) => prisma.contact.findUniqueOrThrow({ where: { id } });
    expect(await read(loose.id)).toMatchObject({ approvedAt: null, approvalSource: null });
    expect(await read(inOpenWeek.id)).toMatchObject({ approvedAt: null, approvalSource: null });
    expect(await read(inApprovedWeek.id)).toMatchObject({ approvedAt: new Date("2026-10-04"), approvalSource: "review" });
    expect(await read(uploaded.id)).toMatchObject({ approvalSource: "upload", approvedAt: uploaded.createdAt });

    await pushQueue(t.orgId, { ignoreWindow: true });
    const sentTo = new Set((await prisma.send.findMany({ where: { organizationId: t.orgId } })).map((s) => s.contactId));
    expect(sentTo.has(loose.id)).toBe(false);
    expect(sentTo.has(inOpenWeek.id)).toBe(false);
    expect(sentTo.has(inApprovedWeek.id)).toBe(true);
    expect(sentTo.has(uploaded.id)).toBe(true);
  });

  it("the backfill approves only what a person approved, and already-emailed people keep their follow-ups without it", async () => {
    const { t, campaign } = await workspace(false);
    const auto = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: auto.orgId }, data: { autoApproveBatches: true } });
    const autoCampaign = await makeCampaign(auto.orgId);
    const at = new Date("2026-10-04");
    const byHand = await prisma.weeklyBatch.create({ data: { organizationId: t.orgId, weekStart: new Date("2026-10-05"), status: "DONE", approvedAt: at } });
    const byAuto = await prisma.weeklyBatch.create({ data: { organizationId: auto.orgId, weekStart: new Date("2026-10-05"), status: "DONE", approvedAt: at } });
    const none = { approvedAt: null, approvalSource: null, source: "apollo" };
    const handPerson = await makeContact(t.orgId, sendable(campaign.id, { ...none, batchId: byHand.id }));
    const autoPerson = await makeContact(auto.orgId, sendable(autoCampaign.id, { ...none, batchId: byAuto.id }));
    const emailedNoWeek = await makeContact(t.orgId, sendable(campaign.id, { ...none, status: "CONTACTED", firstContactedAt: new Date() }));

    await runBackfill();
    const read = (id: string) => prisma.contact.findUniqueOrThrow({ where: { id } });
    expect(await read(handPerson.id)).toMatchObject({ approvedAt: at, approvalSource: "review" });
    expect(await read(autoPerson.id)).toMatchObject({ approvedAt: null, approvalSource: null });
    expect(await read(emailedNoWeek.id)).toMatchObject({ approvedAt: null, approvalSource: null });
  });

  it("an already-emailed person with no approval still gets their follow-ups", async () => {
    const { t, campaign } = await workspace(false);
    const p = await makeContact(t.orgId, sendable(campaign.id));
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: true });
    await prisma.contact.update({ where: { id: p.id }, data: { approvedAt: null, approvalSource: null } });
    expect(await sendFollowUp(t.orgId, p.id, campaign.id, 2)).toMatchObject({ ok: true });
  });

  it("a week approved by the auto setting is recorded as auto, not as a person's review", async () => {
    const { t, campaign } = await workspace(true);
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autoApproveBatches: true } });
    const batch = await prisma.weeklyBatch.create({ data: { organizationId: t.orgId, weekStart: new Date("2030-01-07"), status: "SOURCING" } });
    const p = await makeContact(t.orgId, sendable(campaign.id, { batchId: batch.id, approvedAt: null, approvalSource: null }));
    await handoffToReview(t.orgId, batch.id);
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ approvalSource: "auto" });
  });
});
