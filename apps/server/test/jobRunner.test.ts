import { beforeEach, describe, expect, it } from "vitest";
import { createTenant, makeCampaign, makeContact, resetDb, sendable } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { forEachOrg } from "../src/jobs/runner.js";
import { runFirstTouchesJob } from "../src/jobs/send.js";

describe("background jobs across workspaces", () => {
  beforeEach(resetDb);

  it("one workspace that hangs never holds up the others", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const c = await createTenant();
    const done: string[] = [];
    const started = Date.now();
    const out = await forEachOrg(
      "test",
      { id: { in: [a.orgId, b.orgId, c.orgId] } },
      async (id) => {
        if (id === a.orgId) await new Promise(() => undefined); // never finishes
        done.push(id);
      },
      { concurrency: 2, perOrgMs: 300 },
    );
    expect(done.sort()).toEqual([b.orgId, c.orgId].sort());
    expect(out.find((r) => r.orgId === a.orgId)).toMatchObject({ ok: false });
    expect(Date.now() - started).toBeLessThan(3000);
    const log = await prisma.systemLog.findFirstOrThrow({ where: { organizationId: a.orgId, source: "test" } });
    expect(log.message).toMatch(/moved on to the next workspace/);
  });

  it("says on the System page when emails are late, once a day", async () => {
    const t = await createTenant({ balance: BigInt(10_000) });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true } });
    const campaign = await makeCampaign(t.orgId);
    await makeContact(t.orgId, sendable(campaign.id, { nextTouchAt: new Date(Date.now() - 40 * 60_000) }));
    await runFirstTouchesJob();
    await runFirstTouchesJob();
    const logs = await prisma.systemLog.findMany({ where: { organizationId: t.orgId, message: { startsWith: "Emails are late" } } });
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toMatch(/1 were due more than 15 minutes ago/);
  });
});
