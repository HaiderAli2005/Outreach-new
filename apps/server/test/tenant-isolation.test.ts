import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { recordMessage } from "../src/domain/messages.js";

describe("tenant isolation", () => {
  beforeEach(resetDb);

  it("never exposes or mutates another organization's data", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const campaign = await makeCampaign(b.orgId);
    const contact = await makeContact(b.orgId, { campaignId: campaign.id, status: "REPLIED" });
    await recordMessage(prisma, { organizationId: b.orgId, contactId: contact.id, direction: "INBOUND", body: "Interested, tell me more" });
    const rule = await prisma.blocklistEntry.create({ data: { organizationId: b.orgId, entryType: "EMAIL", value: "x@y.com" } });
    const batch = await prisma.weeklyBatch.create({ data: { organizationId: b.orgId, weekStart: new Date("2026-10-05"), status: "REVIEW" } });
    const log = await prisma.systemLog.create({ data: { organizationId: b.orgId, level: "ERROR", source: "t", message: "b only" } });

    const reads = [
      `/api/v1/contacts/${contact.id}`,
      `/api/v1/inbox/${contact.id}`,
      `/api/v1/campaigns/${campaign.id}`,
      `/api/v1/campaigns/${campaign.id}/export`,
      `/api/v1/batches/${batch.id}`,
    ];
    for (const path of reads) {
      const res = await api().get(path).set(a.auth);
      expect(res.status, path).toBe(404);
    }
    const writes: [string, string, Record<string, unknown>?][] = [
      ["post", `/api/v1/inbox/${contact.id}/handled`],
      ["post", `/api/v1/inbox/${contact.id}/deal-closed`],
      ["delete", `/api/v1/inbox/${contact.id}`],
      ["patch", `/api/v1/campaigns/${campaign.id}/status`, { status: "PAUSED" }],
      ["delete", `/api/v1/blocklist/${rule.id}`],
      ["post", "/api/v1/blocklist/restore", { contactId: contact.id }],
      ["post", `/api/v1/batches/${batch.id}/approve`, {}],
    ];
    for (const [method, path, body] of writes) {
      const res = await (api() as unknown as Record<string, (p: string) => import("supertest").Test>)[method](path).set(a.auth).send(body ?? {});
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    const list = await api().get("/api/v1/contacts").set(a.auth);
    expect(list.body.meta.total).toBe(0);
    const inbox = await api().get("/api/v1/inbox").set(a.auth);
    expect(inbox.body.meta.total).toBe(0);
    const logs = await api().get("/api/v1/system-logs").set(a.auth);
    expect(logs.body.data.find((l: { id: string }) => l.id === log.id)).toBeUndefined();
    const rules = await api().get("/api/v1/blocklist").set(a.auth);
    expect(rules.body.meta.total).toBe(0);

    const untouched = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(untouched.status).toBe("REPLIED");
    expect(untouched.handledAt).toBeNull();
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("ACTIVE");
    expect(await prisma.blocklistEntry.count({ where: { id: rule.id } })).toBe(1);
  });

  it("refuses to switch into an organization the user is not a member of", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const res = await api().get("/api/v1/dashboard/cockpit").set(a.auth).set("X-Organization-Id", b.orgId);
    expect(res.status).toBe(404);
  });

  it("scopes suppression per organization", async () => {
    const a = await createTenant();
    const b = await createTenant();
    await api().post("/api/v1/blocklist").set(a.auth).send({ value: "shared.com", entryType: "DOMAIN" }).expect(201);
    const csv = "email,first name,company\nann@shared.com,Ann,Shared\n";
    const imported = await api().post("/api/v1/contacts/import").set(b.auth).send({ text: csv });
    expect(imported.body.data.imported).toBe(1);
    const blocked = await api().post("/api/v1/contacts/import").set(a.auth).send({ text: csv });
    expect(blocked.body.data.imported).toBe(0);
    expect(blocked.body.data.blocked).toBe(1);
  });
});
