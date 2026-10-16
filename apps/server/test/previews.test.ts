import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeCampaign, makeContact, makePoolMailbox, resetDb, sendable } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setVerifierFactory } from "../src/integrations/verifier.js";

/** What the customer reads: drafts with the sender's real first name, and no claim of checking that isn't happening. */

const draft = { personalization: "Hi Lead,\n\nI'm {{sender_first_name}} from Northwind.", followup2: "A short follow-up from {{ sender_first_name }}.", messageSubject: "Hello" };

describe("previews", () => {
  beforeEach(resetDb);

  it("fills the sender's name in the lead drawer: the pinned mailbox, else an active mailbox", async () => {
    const pinned = await makePoolMailbox();
    await prisma.mailbox.update({ where: { id: pinned.id }, data: { firstName: "Ethan" } });
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const a = await makeContact(t.orgId, { ...sendable(campaign.id), ...draft, assignedMailboxId: pinned.id });
    const b = await makeContact(t.orgId, { ...sendable(campaign.id), ...draft });
    const one = (await api().get(`/api/v1/contacts/${a.id}`).set(t.auth).expect(200)).body.data.contact;
    expect(one.personalization).toContain("I'm Ethan from Northwind.");
    const two = (await api().get(`/api/v1/contacts/${b.id}`).set(t.auth).expect(200)).body.data.contact;
    expect(two.personalization).toContain("I'm Ethan from Northwind.");
    expect(two.followup2).toBe("A short follow-up from Ethan.");
    expect(JSON.stringify([one, two])).not.toContain("sender_first_name");
    // Storage keeps the token: the mailbox is chosen at send time.
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: b.id } })).personalization).toContain("{{sender_first_name}}");
  });

  it("fills it on the approve screen, even with no mailbox at all", async () => {
    const t = await createTenant({ approved: false });
    const campaign = await makeCampaign(t.orgId);
    await makeContact(t.orgId, { ...sendable(campaign.id, { approvedAt: null, approvalSource: null }), ...draft });
    const view = (await api().get("/api/v1/launch").set(t.auth).expect(200)).body.data;
    expect(view.people).toHaveLength(1);
    expect(JSON.stringify(view.people)).not.toContain("sender_first_name");
    expect(view.people[0].emails[0].body).toMatch(/^Hi Lead,\n\nI'm \S+ from Northwind\.$/);
  });

  it("says addresses are checked only when a checker is set up, and warns the admin console when it is not", async () => {
    const t = await createTenant();
    await makeCampaign(t.orgId);
    const off = (await api().post("/api/v1/contacts/import").set(t.auth).send({ text: "email\nann@one.com\n" }).expect(200)).body.data.message;
    expect(off).not.toMatch(/are checked/);
    expect(off).toMatch(/not checked/);
    expect((await api().get("/api/v1/dashboard/nav-counts").set(t.auth).expect(200)).body.data.verifying).toBe(false);
    await prisma.user.update({ where: { id: t.userId }, data: { isPlatformAdmin: true } });
    expect((await api().get(`/api/v1/admin/organizations/${t.orgId}`).set(t.auth).expect(200)).body.data.verifying).toBe(false);
    const row = (await api().get("/api/v1/admin/organizations").set(t.auth).expect(200)).body.data.find((r: { id: string }) => r.id === t.orgId);
    expect(row.verifying).toBe(false);

    setVerifierFactory(async () => async () => ({ configured: true, ok: true, bad: false, transient: false, result: "ok", quality: "good" }));
    const on = (await api().post("/api/v1/contacts/import").set(t.auth).send({ text: "email\nbob@two.com\n" }).expect(200)).body.data.message;
    expect(on).toMatch(/addresses are checked before anything sends/);
    expect((await api().get(`/api/v1/admin/organizations/${t.orgId}`).set(t.auth).expect(200)).body.data.verifying).toBe(true);
  });
});
