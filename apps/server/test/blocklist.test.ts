import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeContact, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

describe("blocklist", () => {
  beforeEach(resetDb);

  it("blocks a domain without ending live conversations", async () => {
    const t = await createTenant();
    const lead = await makeContact(t.orgId, { email: "a@corp.com", emailNormalized: "a@corp.com", companyDomain: "corp.com" });
    const talking = await makeContact(t.orgId, { email: "b@corp.com", emailNormalized: "b@corp.com", companyDomain: "corp.com", status: "REPLIED" });
    await api().post("/api/v1/blocklist").set(t.auth).send({ value: "https://www.corp.com/about", entryType: "DOMAIN" }).expect(201);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: talking.id } })).status).toBe("REPLIED");
    expect(await prisma.blocklistEntry.findFirst({ where: { value: "corp.com", entryType: "DOMAIN" } })).not.toBeNull();
  });

  it("refuses to block a free-mail domain and blocks the one address instead", async () => {
    const t = await createTenant();
    const res = await api().post("/api/v1/blocklist").set(t.auth).send({ value: "gmail.com", entryType: "DOMAIN" });
    expect(res.status).toBe(422);
    const email = await api().post("/api/v1/blocklist").set(t.auth).send({ value: "Some.One+tag@gmail.com", entryType: "EMAIL" });
    expect(email.body.data.value).toBe("someone@gmail.com");
  });

  it("restores a lead, deleting soft rules but keeping hard ones", async () => {
    const t = await createTenant();
    const c = await makeContact(t.orgId, { email: "x@soft.com", emailNormalized: "x@soft.com", companyDomain: "soft.com", status: "BLOCKLISTED", fitScore: 0 });
    await prisma.blocklistEntry.createMany({
      data: [
        { organizationId: t.orgId, entryType: "EMAIL", value: "x@soft.com", reason: "NO_RESPONSE" },
        { organizationId: t.orgId, entryType: "DOMAIN", value: "soft.com", reason: "UNSUBSCRIBED" },
      ],
    });
    const res = await api().post("/api/v1/blocklist/restore").set(t.auth).send({ contactId: c.id });
    expect(res.status).toBe(200);
    expect(res.body.data.keptDomains).toEqual([{ value: "soft.com", reason: "UNSUBSCRIBED" }]);
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toMatchObject({ status: "NEW", fitScore: 60, verifyResult: null });
    expect(await prisma.blocklistEntry.count({ where: { entryType: "EMAIL", value: "x@soft.com" } })).toBe(0);
  });

  it("never restores a spam complaint", async () => {
    const t = await createTenant();
    const c = await makeContact(t.orgId, { email: "angry@x.com", emailNormalized: "angry@x.com", status: "UNSUBSCRIBED" });
    await prisma.blocklistEntry.create({ data: { organizationId: t.orgId, entryType: "EMAIL", value: "angry@x.com", reason: "COMPLAINED" } });
    const res = await api().post("/api/v1/blocklist/restore").set(t.auth).send({ contactId: c.id });
    expect(res.status).toBe(422);
  });

  it("imports a plain list and a lead CSV", async () => {
    const t = await createTenant();
    const plain = await api().post("/api/v1/blocklist/import").set(t.auth).send({ text: "one@a.com, two@b.com\nbanned.io" });
    expect(plain.body.data).toMatchObject({ mode: "list", rules: 3 });
    const csv = await api().post("/api/v1/blocklist/import").set(t.auth).send({ text: "email,name,company\nceo@target.com,Cee Oh,Target\n", blockWholeCompany: true });
    expect(csv.body.data).toMatchObject({ mode: "leads", rules: 1, records: 1 });
    expect(await prisma.blocklistEntry.findFirst({ where: { value: "target.com", entryType: "DOMAIN" } })).not.toBeNull();
    const exported = await api().get("/api/v1/blocklist/export").set(t.auth);
    expect(exported.text).toContain("banned.io");
  });

  it("lets only managers delete rules", async () => {
    const t = await createTenant();
    const { addMember } = await import("./helpers.js");
    const m = await addMember(t, "MEMBER");
    const rule = await prisma.blocklistEntry.create({ data: { organizationId: t.orgId, entryType: "EMAIL", value: "z@z.com" } });
    await api().delete(`/api/v1/blocklist/${rule.id}`).set(m.auth).expect(403);
    await api().delete(`/api/v1/blocklist/${rule.id}`).set(t.auth).expect(200);
  });
});
