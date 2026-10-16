import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { parseLeadCsv } from "../src/domain/leadImport.js";

describe("lead CSV parsing", () => {
  it("maps common headers, splits names and dedupes", () => {
    const csv = "Full Name;E-mail;Företag;Job Title;Website\nAnna Svensson;anna@acme.se;Acme AB;VD;https://acme.se\nDup Person;ANNA@acme.se;Acme AB;VD;acme.se\nNo Email;;Nope;;\n";
    const r = parseLeadCsv(csv)!;
    expect(r.leads).toHaveLength(1);
    expect(r.leads[0]).toMatchObject({ firstName: "Anna", lastName: "Svensson", company: "Acme AB", title: "VD", website: "https://acme.se" });
    expect(r.skipped).toBe(2);
  });

  it("finds an email column without headers", () => {
    const r = parseLeadCsv("ann@one.com\nbob@two.com\n")!;
    expect(r.leads.map((l) => l.emailNormalized)).toEqual(["ann@one.com", "bob@two.com"]);
  });

  it("returns null when there is no email", () => {
    expect(parseLeadCsv("name,company\nAnn,One\n")).toBeNull();
  });
});

describe("leads", () => {
  beforeEach(resetDb);

  it("imports a CSV through the dedup, blocklist and per-company gates", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, perCompanyContactCap: 2 } });
    const campaign = await makeCampaign(t.orgId);
    await makeContact(t.orgId, { email: "existing@known.com", emailNormalized: "existing@known.com" });
    await prisma.blocklistEntry.create({ data: { organizationId: t.orgId, entryType: "DOMAIN", value: "blocked.com" } });
    const csv = [
      "email,first name,last name,company,website",
      "new1@fresh.com,New,One,Fresh,fresh.com",
      "Existing@known.com,Ex,Isting,Known,known.com",
      "x@blocked.com,Bl,Ocked,Blocked,blocked.com",
      "a@big.com,A,A,Big,big.com",
      "b@big.com,B,B,Big,big.com",
      "c@big.com,C,C,Big,big.com",
    ].join("\n");
    const res = await api().post("/api/v1/contacts/import").set(t.auth).send({ text: csv, campaignId: campaign.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ imported: 3, duplicates: 1, blocked: 1, capped: 1 });
    const fresh = await prisma.contact.findUniqueOrThrow({ where: { organizationId_emailNormalized: { organizationId: t.orgId, emailNormalized: "new1@fresh.com" } } });
    expect(fresh).toMatchObject({ source: "csv", status: "NEW", campaignId: campaign.id, tier: "A" });
  });

  it("filters, paginates and exports leads as CSV", async () => {
    const t = await createTenant();
    for (let i = 0; i < 5; i++) await makeContact(t.orgId, { tier: i < 2 ? "B" : "A", fullName: `Person ${i}` });
    await makeContact(t.orgId, { status: "BLOCKLISTED", fullName: "Hidden" });
    const page = await api().get("/api/v1/contacts?limit=2&page=2&tier=A").set(t.auth);
    expect(page.body.meta).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(page.body.data).toHaveLength(1);
    const all = await api().get("/api/v1/contacts").set(t.auth);
    expect(all.body.meta.total).toBe(5);
    const suppressed = await api().get("/api/v1/contacts?suppressed=true").set(t.auth);
    expect(suppressed.body.meta.total).toBe(1);
    const csv = await api().get("/api/v1/contacts/export").set(t.auth);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text.split("\r\n").filter(Boolean)).toHaveLength(6);
    await api().get("/api/v1/contacts?tier=Z").set(t.auth).expect(400);
  });

  it("neutralises spreadsheet formulas in exports", async () => {
    const t = await createTenant();
    await makeContact(t.orgId, { fullName: "=HYPERLINK(\"http://evil\")" });
    const csv = await api().get("/api/v1/contacts/export").set(t.auth);
    expect(csv.text).toContain("'=HYPERLINK");
  });
});

describe("weekly batches", () => {
  beforeEach(resetDb);

  it("excludes leads and approves the week with the sendable count", async () => {
    const t = await createTenant();
    const batch = await prisma.weeklyBatch.create({ data: { organizationId: t.orgId, weekStart: new Date("2026-10-05"), status: "REVIEW", targetClean: 10 } });
    const leads = await Promise.all([0, 1, 2, 3].map(() => makeContact(t.orgId, { batchId: batch.id })));
    await makeContact(t.orgId, { batchId: batch.id, fitScore: 5 });
    const pending = await api().get("/api/v1/batches/pending").set(t.auth);
    expect(pending.body.data[0].stats).toMatchObject({ total: 5, sendable: 4, belowFloor: 1 });
    await api().post(`/api/v1/batches/${batch.id}/exclude`).set(t.auth).send({ contactIds: [leads[0].id] }).expect(200);
    const approved = await api().post(`/api/v1/batches/${batch.id}/approve`).set(t.auth).send({ excludeContactIds: [leads[1].id] });
    expect(approved.body.data).toMatchObject({ ok: true, approved: 2, excluded: 2 });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: leads[0].id } })).status).toBe("REJECTED");
    const again = await api().post(`/api/v1/batches/${batch.id}/approve`).set(t.auth).send({});
    expect(again.status).toBe(422);
  });

  it("approves a week that is still sourcing", async () => {
    const t = await createTenant();
    const batch = await prisma.weeklyBatch.create({ data: { organizationId: t.orgId, weekStart: new Date("2026-10-19"), status: "SOURCING" } });
    await makeContact(t.orgId, { batchId: batch.id });
    const c = await makeContact(t.orgId, { batchId: batch.id });
    expect((await api().post(`/api/v1/batches/${batch.id}/approve`).set(t.auth).send({}).expect(200)).body.data).toMatchObject({ ok: true, approved: 2 });
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ approvalSource: "review" });
  });

  it("approves from a signed one-click link and rejects tampered links", async () => {
    const t = await createTenant();
    const batch = await prisma.weeklyBatch.create({ data: { organizationId: t.orgId, weekStart: new Date("2026-10-12"), status: "REVIEW" } });
    const { approveToken } = await import("../src/domain/batches.js");
    const bad = await api().get(`/api/v1/public/batches/approve?batch=${batch.id}&token=nope`);
    expect(bad.status).toBe(403);
    const good = await api().get(`/api/v1/public/batches/approve?batch=${batch.id}&token=${approveToken(batch.id)}`);
    expect(good.status).toBe(200);
    expect(good.text).toContain("Week approved");
    expect((await prisma.weeklyBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("APPROVED");
  });
});
