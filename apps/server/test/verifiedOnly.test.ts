import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setMailSender } from "../src/integrations/mailer.js";
import { setAiClient } from "../src/integrations/ai.js";

describe("only confirmed emails start paid work", () => {
  beforeEach(async () => {
    await resetDb();
    // Email sending on: people can confirm, so confirmation is required.
    setMailSender(async () => true);
    setAiClient({ generateJSON: async () => null, generateText: async () => "" });
  });
  afterEach(() => {
    setMailSender(null);
    setAiClient(undefined);
  });

  it("refuses the analysis, the sample emails and the market count until the email is confirmed", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" }).expect(200);
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(403);
    expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    await api().post("/api/v1/onboarding/answers").set(t.auth).send({ sell: "x", who: "y", regions: ["United Kingdom"] }).expect(403);
    await api().post("/api/v1/onboarding/preview").set(t.auth).expect(403);
    await api().get("/api/v1/onboarding/market").set(t.auth).expect(403);
    expect(await prisma.analysisRun.count({ where: { organizationId: t.orgId } })).toBe(0);
  });

  it("lets a confirmed user start the analysis", async () => {
    const t = await createTenant({ subscribed: false });
    await prisma.user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" }).expect(200);
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth);
    expect(res.status).not.toBe(403);
  });
});
