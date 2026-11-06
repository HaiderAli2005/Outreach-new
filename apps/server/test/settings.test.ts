import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb, fakeAi } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient } from "../src/integrations/ai.js";

describe("settings", () => {
  beforeEach(resetDb);

  it("saves the schedule, budget and proof, and has no emails-a-day setting", async () => {
    const t = await createTenant();
    const res = await api()
      .patch("/api/v1/settings")
      .set(t.auth)
      .send({ sendDays: [5, 1, 1, 3], prospectTimezone: "America/Los_Angeles", dailyBudgetDecicents: "20000", proofPoints: [{ claim: "cut review time by about 60%", source: "Acme case study" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toMatchObject({ sendDays: [1, 3, 5], prospectTimezone: "America/Los_Angeles", dailyBudgetDecicents: "20000", dailySourceTarget: 500 });
    expect(res.body.data.settings).not.toHaveProperty("defaultDailySendCap");
    expect(res.body.data.budget).toMatchObject({ budget: "20000", state: "running" });
    await api().patch("/api/v1/settings").set(t.auth).send({ sendDays: [] }).expect(400);
    await api().patch("/api/v1/settings").set(t.auth).send({ sendingWindowStart: "18:00", sendingWindowEnd: "09:00" }).expect(400);
    await api().patch("/api/v1/settings").set(t.auth).send({ defaultDailySendCap: 500 }).expect(400);
    // $0 pauses; otherwise $4 to $200 a day.
    await api().patch("/api/v1/settings").set(t.auth).send({ dailyBudgetDecicents: "3990" }).expect(422);
    await api().patch("/api/v1/settings").set(t.auth).send({ dailyBudgetDecicents: "200010" }).expect(422);
    await api().patch("/api/v1/settings").set(t.auth).send({ dailyBudgetDecicents: "0" }).expect(200);
  });

  it("rejects unknown fields and bad values", async () => {
    const t = await createTenant();
    await api().patch("/api/v1/settings").set(t.auth).send({ isPlatformAdmin: true }).expect(400);
    await api().patch("/api/v1/settings").set(t.auth).send({ timezone: "Mars/Olympus" }).expect(400);
    await api().patch("/api/v1/settings").set(t.auth).send({ meetingLink: "javascript:alert(1)" }).expect(400);
  });

  it("has no automatic reply settings left: replies are drafts until a person sends them", async () => {
    const t = await createTenant();
    await api().patch("/api/v1/settings").set(t.auth).send({ autoReplyEnabled: true }).expect(400);
    await api().patch("/api/v1/settings").set(t.auth).send({ autoReplyMode: "LIVE" }).expect(400);
    await api().post("/api/v1/settings/auto-reply/kill").set(t.auth).expect(404);
    const off = await api().patch("/api/v1/settings").set(t.auth).send({ draftReplies: false });
    expect(off.body.data.settings.draftReplies).toBe(false);
  });

  it("switching to automatic launch needs consent on record", async () => {
    const t = await createTenant({ consent: false });
    await api().patch("/api/v1/settings").set(t.auth).send({ launchMode: "AUTO" }).expect(422);
    await api().post("/api/v1/launch/consent").set(t.auth).send({ confirm: true }).expect(200);
    await api().patch("/api/v1/settings").set(t.auth).send({ launchMode: "AUTO" }).expect(200);
  });

  it("stores integration keys encrypted and only ever returns them masked", async () => {
    const t = await createTenant();
    const res = await api().put("/api/v1/settings/credentials/APOLLO").set(t.auth).send({ value: "apollo-secret-key-1234" });
    expect(res.status).toBe(200);
    const apollo = res.body.data.find((c: { provider: string }) => c.provider === "APOLLO");
    expect(apollo).toMatchObject({ source: "organization", masked: "••••1234" });
    const row = await prisma.integrationCredential.findFirstOrThrow();
    expect(row.ciphertext).not.toContain("apollo-secret");
    const view = await api().get("/api/v1/settings").set(t.auth);
    expect(JSON.stringify(view.body)).not.toContain("apollo-secret-key");
    await api().put("/api/v1/settings/credentials/SLACK_WEBHOOK").set(t.auth).send({ value: "https://evil.example.com/hook" }).expect(400);
  });

  it("stops the engine", async () => {
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true } });
    const res = await api().post("/api/v1/engine/stop").set(t.auth);
    expect(res.body.data).toMatchObject({ stopped: true });
    const s = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(s).toMatchObject({ autopilotEnabled: false });
  });
});
