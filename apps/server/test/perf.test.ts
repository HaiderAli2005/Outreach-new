import { beforeAll, describe, expect, it } from "vitest";
import { api, createTenant, resetDb, type TestTenant } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";

/**
 * Performance budget, enforced in CI. A paid product is judged by how fast it feels, and the inbox is where
 * customers live:
 *
 *   inbox list usable       < 1.5s   (50 rows a page, on a workspace with 50,000 sends)
 *   a thread opens          < 500ms
 *   the ops console         < 2.0s   (served from the cached aggregates)
 *
 * The seed is written with set-based SQL so the test itself stays quick.
 */
const SENDS = 50_000;
const PEOPLE = 12_500;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

describe("performance budget", () => {
  let t: TestTenant;
  let admin: TestTenant;
  let someone: string;

  beforeAll(async () => {
    await resetDb();
    t = await createTenant();
    admin = await createTenant();
    await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformAdmin: true } });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Contact" (id, "organizationId", email, "emailNormalized", domain, "firstName", "fullName", company, status, "messageCount", "hasInbound",
                              "lastMessageAt", "lastMessageDirection", "lastMessagePreview", "replyClass", intent, "lastContactedAt", "firstContactedAt", "updatedAt")
       SELECT 'perf_c_' || g, $1, 'p' || g || '@co' || (g % 900) || '.com', 'p' || g || '@co' || (g % 900) || '.com', 'co' || (g % 900) || '.com', 'P' || g, 'Person ' || g, 'Company ' || (g % 900),
              (CASE WHEN g % 5 = 0 THEN 'REPLIED' ELSE 'CONTACTED' END)::"ContactStatus", 4, g % 5 = 0,
              now() - (g || ' minutes')::interval, (CASE WHEN g % 5 = 0 THEN 'INBOUND' ELSE 'OUTBOUND' END)::"MessageDirection", 'Preview ' || g,
              CASE WHEN g % 5 = 0 THEN 'hot' END, CASE WHEN g % 5 = 0 THEN 'INTERESTED' END, now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, now()
       FROM generate_series(1, ${PEOPLE}) g`,
      t.orgId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO sends (id, customer_id, prospect_id, is_first_touch, step, status, price_charged, sent_at, message_id, subject)
       SELECT 'perf_s_' || g, $1, 'perf_c_' || (1 + (g % ${PEOPLE})), (g % 4) = 0, 1 + (g % 4), 'SENT', 25, now() - (g || ' seconds')::interval, '<perf' || g || '@pool.test>', 'Research content volume'
       FROM generate_series(1, ${SENDS}) g`,
      t.orgId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Message" (id, "organizationId", "contactId", direction, via, subject, body, "createdAt")
       SELECT 'perf_m_' || g, $1, 'perf_c_' || (1 + (g % ${PEOPLE})), (CASE WHEN g % 4 = 0 THEN 'INBOUND' ELSE 'OUTBOUND' END)::"MessageDirection", 'sequence', 'Research content volume',
              'A message body of ordinary length, written to make the rows realistic in size. ' || g, now() - (g || ' seconds')::interval
       FROM generate_series(1, ${PEOPLE * 4}) g`,
      t.orgId,
    );
    await prisma.$executeRawUnsafe(`ANALYZE "Contact"; `);
    await prisma.$executeRawUnsafe(`ANALYZE sends;`);
    await prisma.$executeRawUnsafe(`ANALYZE "Message";`);
    someone = "perf_c_5";
    // Warm the connection pool and the query plans once, as a running server would be.
    await api().get("/api/v1/inbox").set(t.auth);
  }, 120_000);

  it(`opens the inbox in under 1.5s with ${SENDS.toLocaleString("en-US")} sends`, async () => {
    expect(await prisma.send.count({ where: { organizationId: t.orgId } })).toBe(SENDS);
    const { ms, value } = await timed(() => api().get("/api/v1/inbox").set(t.auth));
    expect(value.status).toBe(200);
    expect(value.body.data).toHaveLength(50);
    expect(ms).toBeLessThan(1500);
    const needs = await timed(() => api().get("/api/v1/inbox?filter=needs").set(t.auth));
    expect(needs.ms).toBeLessThan(1500);
    const next = await timed(() => api().get("/api/v1/inbox?page=2").set(t.auth));
    expect(next.value.body.data).toHaveLength(50);
    expect(next.ms).toBeLessThan(1500);
  });

  it("opens a thread in under 500ms", async () => {
    const { ms, value } = await timed(() => api().get(`/api/v1/inbox/${someone}`).set(t.auth));
    expect(value.status).toBe(200);
    expect(ms).toBeLessThan(500);
  });

  it("serves the ops console in under 2s from its cached aggregates", async () => {
    await api().get("/api/v1/admin/pool?fresh=1").set(admin.auth).expect(200);
    const { ms, value } = await timed(() => api().get("/api/v1/admin/pool").set(admin.auth));
    expect(value.status).toBe(200);
    expect(value.body.data.cachedAt).toBeTruthy();
    expect(ms).toBeLessThan(2000);
  });
});
