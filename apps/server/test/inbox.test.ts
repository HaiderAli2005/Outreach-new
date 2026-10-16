import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, makePoolMailbox, resetDb, transport } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { recordMessage } from "../src/domain/messages.js";

async function conversation(orgId: string, data: Record<string, unknown>, messages: ("IN" | "OUT")[]) {
  const c = await makeContact(orgId, { status: "REPLIED", assignedMailboxId: (await makePoolMailbox()).id, ...data });
  let t = Date.now() - messages.length * 60_000;
  for (const m of messages) {
    await recordMessage(prisma, { organizationId: orgId, contactId: c.id, direction: m === "IN" ? "INBOUND" : "OUTBOUND", via: m === "OUT" ? "sequence" : "email", body: `${m} message`, emailMessageId: m === "IN" ? `<in-${t}@prospect.com>` : null, createdAt: new Date((t += 60_000)) });
  }
  return prisma.contact.findUniqueOrThrow({ where: { id: c.id } });
}

describe("inbox", () => {
  beforeEach(resetDb);

  it("counts needs-reply only for live lead-class threads waiting on us", async () => {
    const t = await createTenant();
    await conversation(t.orgId, { replyClass: "hot" }, ["OUT", "IN"]);
    await conversation(t.orgId, { replyClass: null }, ["OUT", "IN"]);
    await conversation(t.orgId, { replyClass: "away" }, ["OUT", "IN"]);
    await conversation(t.orgId, { replyClass: "question" }, ["OUT", "IN", "OUT"]);
    await conversation(t.orgId, { replyClass: "hot", status: "UNSUBSCRIBED" }, ["OUT", "IN"]);
    await conversation(t.orgId, { replyClass: "hot", handledAt: new Date() }, ["OUT", "IN"]);
    await makeContact(t.orgId, { status: "CONTACTED" });

    const res = await api().get("/api/v1/inbox?filter=needs").set(t.auth);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(2);
    expect(res.body.meta.counts.needs).toBe(2);
    expect(res.body.meta.counts.replied).toBe(2);
    const nav = await api().get("/api/v1/dashboard/nav-counts").set(t.auth);
    expect(nav.body.data.inboxAwaiting).toBe(2);
    const all = await api().get("/api/v1/inbox").set(t.auth);
    expect(all.body.meta.total).toBe(6);
  });

  it("marks a thread handled, and a new inbound brings it back", async () => {
    const t = await createTenant();
    const c = await conversation(t.orgId, { replyClass: "hot" }, ["OUT", "IN"]);
    await api().post(`/api/v1/inbox/${c.id}/handled`).set(t.auth).expect(200);
    expect((await api().get("/api/v1/inbox?filter=needs").set(t.auth)).body.meta.total).toBe(0);
    const { recordInboundReply } = await import("../src/domain/replyIngest.js");
    await recordInboundReply({ orgId: t.orgId, contact: await prisma.contact.findUniqueOrThrow({ where: { id: c.id } }), body: "Following up on this", alert: false });
    expect((await api().get("/api/v1/inbox?filter=needs").set(t.auth)).body.meta.total).toBe(1);
  });

  it("removes a person by email only and keeps colleagues reachable", async () => {
    const t = await createTenant();
    const c = await conversation(t.orgId, { email: "ann@acme.com", emailNormalized: "ann@acme.com", companyDomain: "acme.com", replyClass: "hot" }, ["OUT", "IN"]);
    const colleague = await makeContact(t.orgId, { email: "bob@acme.com", emailNormalized: "bob@acme.com", companyDomain: "acme.com" });
    await api().delete(`/api/v1/inbox/${c.id}`).set(t.auth).expect(200);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).neverAuto).toBe(true);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: colleague.id } })).status).toBe("NEW");
    expect(await prisma.blocklistEntry.findFirst({ where: { organizationId: t.orgId, entryType: "EMAIL", value: "ann@acme.com", reason: "REMOVED" } })).not.toBeNull();
    expect(await prisma.blocklistEntry.count({ where: { organizationId: t.orgId, entryType: "DOMAIN" } })).toBe(0);
  });

  it("closes a deal by suppressing the whole company and the agent", async () => {
    const t = await createTenant();
    const c = await conversation(t.orgId, { email: "cto@won.com", emailNormalized: "cto@won.com", companyDomain: "won.com", replyClass: "hot" }, ["OUT", "IN"]);
    const colleague = await makeContact(t.orgId, { email: "ops@won.com", emailNormalized: "ops@won.com", companyDomain: "won.com" });
    await prisma.contact.update({ where: { id: c.id }, data: { aiDraft: "x" } });
    await api().post(`/api/v1/inbox/${c.id}/deal-closed`).set(t.auth).expect(200);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: colleague.id } })).status).toBe("BLOCKLISTED");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).aiDraft).toBeNull();
    expect(await prisma.blocklistEntry.findFirst({ where: { value: "won.com", reason: "DEAL_CLOSED" } })).not.toBeNull();
  });

  it("refuses to email someone who opted out", async () => {
    const t = await createTenant();
    const c = await conversation(t.orgId, { status: "UNSUBSCRIBED" }, ["OUT", "IN"]);
    const res = await api().post(`/api/v1/inbox/${c.id}/reply`).set(t.auth).send({ body: "Hi again" });
    expect(res.status).toBe(409);
    expect(transport.sent).toHaveLength(0);
  });

  it("sends a human reply through the thread, hands the conversation over and records it", async () => {
    const t = await createTenant();
    const c = await conversation(t.orgId, { replyClass: "hot", aiDraft: "draft", replyUrgent: true }, ["OUT", "IN"]);
    const res = await api().post(`/api/v1/inbox/${c.id}/reply`).set(t.auth).send({ body: "Tuesday works. Here is the link https://cal.com/test/intro" });
    expect(res.status).toBe(200);
    const sent = transport.sent.at(-1)!;
    expect(sent.from).toBe(c.assignedMailboxId ? (await prisma.mailbox.findUniqueOrThrow({ where: { id: c.assignedMailboxId } })).address : "");
    expect(sent.message.inReplyTo).toMatch(/^<in-\d+@prospect\.com>$/);
    expect(sent.message.text).toContain("Tuesday works");
    const after = await prisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.autoReplyStatus).toBe("MANUAL");
    expect(after.aiDraft).toBeNull();
    expect(after.replyUrgent).toBe(false);
    expect(after.linkSentAt).not.toBeNull();
    expect(after.lastMessageDirection).toBe("OUTBOUND");
    expect((await api().get("/api/v1/inbox?filter=needs").set(t.auth)).body.meta.total).toBe(0);
  });

  it("validates reply bodies", async () => {
    const t = await createTenant();
    const c = await conversation(t.orgId, {}, ["OUT", "IN"]);
    const res = await api().post(`/api/v1/inbox/${c.id}/reply`).set(t.auth).send({ body: "   " });
    expect(res.status).toBe(400);
  });
});
