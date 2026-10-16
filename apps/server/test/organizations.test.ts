import { beforeEach, describe, expect, it } from "vitest";
import { api, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { signAccessToken } from "../src/modules/auth/tokens.js";

describe("creating an organization", () => {
  beforeEach(resetDb);

  it("lets a signed-in user without a workspace create one with setup started", async () => {
    const user = await prisma.user.create({ data: { email: "solo@example.com", name: "Solo" } });
    const auth = { Authorization: `Bearer ${signAccessToken({ sub: user.id, org: null, role: null, pa: false })}` };
    await api().post("/api/v1/organizations").set(auth).send({ domain: "not a domain" }).expect(400);
    const res = await api().post("/api/v1/organizations").set(auth).send({ domain: "https://www.acme-labs.io" }).expect(201);
    expect(res.body.data).toMatchObject({ name: "Acme Labs", primaryDomain: "acme-labs.io" });
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: user.id } });
    expect(m.role).toBe("OWNER");
    expect(await prisma.onboarding.count({ where: { organizationId: m.organizationId } })).toBe(1);
    expect(await prisma.orgSettings.count({ where: { organizationId: m.organizationId } })).toBe(1);
  });

  it("opens the workspace you already have for a domain instead of making another, even at the limit", async () => {
    const user = await prisma.user.create({ data: { email: "many@example.com", name: "Many" } });
    const auth = { Authorization: `Bearer ${signAccessToken({ sub: user.id, org: null, role: null, pa: false })}` };
    const first = (await api().post("/api/v1/organizations").set(auth).send({ domain: "ekhata.ai" }).expect(201)).body.data;
    for (const d of ["a1.io", "a2.io", "a3.io", "a4.io"]) await api().post("/api/v1/organizations").set(auth).send({ domain: d }).expect(201);
    const again = (await api().post("/api/v1/organizations").set(auth).send({ domain: "https://www.ekhata.ai/" }).expect(201)).body.data;
    expect(again).toMatchObject({ id: first.id, existing: true });
    expect(await prisma.membership.count({ where: { userId: user.id } })).toBe(5);
    const msg = (await api().post("/api/v1/organizations").set(auth).send({ domain: "new-one.io" }).expect(422)).body.error.message;
    expect(msg).toMatch(/already have 5 workspaces/);
  });

  it("deletes a workspace for its owner, which frees a place under the limit", async () => {
    const user = await prisma.user.create({ data: { email: "full@example.com", name: "Full" } });
    const auth = { Authorization: `Bearer ${signAccessToken({ sub: user.id, org: null, role: null, pa: false })}` };
    const ids: string[] = [];
    for (const d of ["b1.io", "b2.io", "b3.io", "b4.io", "b5.io"]) ids.push((await api().post("/api/v1/organizations").set(auth).send({ domain: d }).expect(201)).body.data.id);
    await api().post("/api/v1/organizations").set(auth).send({ domain: "b6.io" }).expect(422);
    const inOrg = { Authorization: `Bearer ${signAccessToken({ sub: user.id, org: ids[1], role: "OWNER", pa: false })}` };
    await api().delete("/api/v1/organizations/current").set(inOrg).send({ confirm: "wrong" }).expect(422);
    await api().delete("/api/v1/organizations/current").set(inOrg).send({ confirm: "b2.io" }).expect(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: ids[1] } })).status).toBe("SUSPENDED");
    // Gone from the account, and a new workspace (even for the same website) can be made.
    const again = (await api().post("/api/v1/organizations").set(auth).send({ domain: "b2.io" }).expect(201)).body.data;
    expect(again.id).not.toBe(ids[1]);
    expect(again.existing).toBe(false);
  });

  it("lets only an owner delete a workspace", async () => {
    const user = await prisma.user.create({ data: { email: "admin@example.com", name: "Admin" } });
    const auth = { Authorization: `Bearer ${signAccessToken({ sub: user.id, org: null, role: null, pa: false })}` };
    const id = (await api().post("/api/v1/organizations").set(auth).send({ domain: "c1.io" }).expect(201)).body.data.id;
    await prisma.membership.updateMany({ where: { organizationId: id }, data: { role: "ADMIN" } });
    const asAdmin = { Authorization: `Bearer ${signAccessToken({ sub: user.id, org: id, role: "ADMIN", pa: false })}` };
    await api().delete("/api/v1/organizations/current").set(asAdmin).send({ confirm: "c1.io" }).expect(403);
  });

  it("requires authentication", async () => {
    await api().post("/api/v1/organizations").send({ name: "x" }).expect(401);
  });
});
