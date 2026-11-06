import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb, transport, type TestTenant } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { checkDomainDns, setTxtResolver } from "../src/domain/pool/auth.js";
import { evaluateDomainHealth } from "../src/domain/pool/lifecycle.js";
import { checkReorderTrigger } from "../src/domain/pool/metrics.js";
import { cronMatches } from "../src/lib/cron.js";
import { JOBS } from "../src/jobs/registry.js";

const DKIM = `v=DKIM1; k=rsa; p=${generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }).toString("base64")}`;

/** DNS for the given domains: SPF, DKIM on the "google" selector and DMARC all present. */
function dnsFor(...names: string[]) {
  setTxtResolver(async (q) => {
    for (const n of names) {
      if (q === n) return [["v=spf1 include:_spf.google.com ~all"]];
      if (q === `_dmarc.${n}`) return [["v=DMARC1; p=none"]];
      if (q === `google._domainkey.${n}`) return [[DKIM]];
    }
    return [];
  });
}

const box = (address: string, firstName: string, extra: Record<string, unknown> = {}) => ({
  address,
  firstName,
  lastName: "Reed",
  password: "app-password-123",
  smtpHost: "smtp.gmail.com",
  smtpPort: 587,
  imapHost: "imap.gmail.com",
  imapPort: 993,
  ...extra,
});

async function admin(): Promise<TestTenant> {
  const a = await createTenant();
  await prisma.user.update({ where: { id: a.userId }, data: { isPlatformAdmin: true } });
  return a;
}

describe("admin: adding pool domains by hand", () => {
  beforeEach(resetDb);

  it("puts a warmed domain live at once when its DNS passes, mailboxes at 30 a day, no password anywhere", async () => {
    const a = await admin();
    dnsFor("decoderhubs.com");
    const res = await api()
      .post("/api/v1/admin/domains")
      .set(a.auth)
      .send({ name: "decoderhubs.com", warmed: true, region: "global", locale: "en", mailboxes: [box("madison@decoderhubs.com", "Madison"), box("daniel@decoderhubs.com", "Daniel")] })
      .expect(201);
    expect(res.body.data.dns).toMatchObject({ spf: true, dkim: true, dmarc: true, moved: "active" });
    expect(JSON.stringify(res.body)).not.toContain("app-password-123");
    const d = await prisma.sendingDomain.findFirstOrThrow({ where: { name: "decoderhubs.com" }, include: { mailboxes: true } });
    expect(d).toMatchObject({ organizationId: null, status: "ACTIVE", prewarmed: true });
    expect(d.mailboxes.map((m) => [m.status, m.sendCapToday, m.provider])).toEqual([
      ["ACTIVE", 30, "manual"],
      ["ACTIVE", 30, "manual"],
    ]);
    expect(JSON.stringify(d.mailboxes)).not.toContain("app-password-123");
    expect(await prisma.persona.findFirst({ where: { firstName: "Madison", locale: "en" } })).toBeTruthy();
    const list = await api().get("/api/v1/admin/domains").set(a.auth).expect(200);
    expect(list.body.data[0]).toMatchObject({ name: "decoderhubs.com", status: "ACTIVE", warmed: true });
    expect(JSON.stringify(list.body)).not.toContain("app-password-123");
  });

  it("holds a warmed domain until its DNS is fixed, then puts it live on Check DNS", async () => {
    const a = await admin();
    const res = await api()
      .post("/api/v1/admin/domains")
      .set(a.auth)
      .send({ name: "bytepath.co", warmed: true, mailboxes: [box("lena@bytepath.co", "Lena")] })
      .expect(201);
    expect(res.body.data.dns).toMatchObject({ spf: false, moved: null });
    const d = await prisma.sendingDomain.findFirstOrThrow({ where: { name: "bytepath.co" } });
    expect(d.status).toBe("REGISTERED");
    expect((await prisma.mailbox.findFirstOrThrow({ where: { sendingDomainId: d.id } })).status).toBe("CONNECTING");
    dnsFor("bytepath.co");
    await api().post(`/api/v1/admin/domains/${d.id}/dns-check`).set(a.auth).expect(200);
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("ACTIVE");
    expect((await prisma.mailbox.findFirstOrThrow({ where: { sendingDomainId: d.id } })).status).toBe("ACTIVE");
  });

  it("checks every DNS record at once, so slow DNS costs one wait, not one per record", async () => {
    let inFlight = 0;
    let most = 0;
    setTxtResolver(async (q) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 150));
      inFlight--;
      return q === "slowdns.com" ? [["v=spf1 ~all"]] : q === "_dmarc.slowdns.com" ? [["v=DMARC1; p=none"]] : q === "s2._domainkey.slowdns.com" ? [[DKIM]] : [];
    });
    const t0 = Date.now();
    const r = await checkDomainDns("slowdns.com", ["default", "google", "s1", "s2", "mail"]);
    expect(Date.now() - t0).toBeLessThan(600);
    expect(most).toBe(7);
    expect(r).toEqual({ spf: true, dkim: true, dmarc: true, selector: "s2" });
  });

  it("ages a new domain 14 days, then starts the 5-a-day ladder", async () => {
    const a = await admin();
    dnsFor("compliancedrift.org");
    await api()
      .post("/api/v1/admin/domains")
      .set(a.auth)
      .send({ name: "compliancedrift.org", warmed: false, mailboxes: [box("ethan@compliancedrift.org", "Ethan")] })
      .expect(201);
    const d = await prisma.sendingDomain.findFirstOrThrow({ where: { name: "compliancedrift.org" } });
    expect(d.status).toBe("AGING");
    expect(d.agingUntil!.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect(d.agingUntil!.getTime()).toBeLessThan(Date.now() + 15 * 86_400_000);
    await evaluateDomainHealth();
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("AGING");
    await prisma.sendingDomain.update({ where: { id: d.id }, data: { agingUntil: new Date(Date.now() - 1000) } });
    await evaluateDomainHealth();
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("WARMING");
    expect(await prisma.mailbox.findFirstOrThrow({ where: { sendingDomainId: d.id } })).toMatchObject({ status: "WARMING", warmupDay: 1, sendCapToday: 5 });
  });

  it("holds back a mailbox that cannot sign in, and lets it in once a new password works", async () => {
    const a = await admin();
    dnsFor("wave-meet.com");
    transport.signInOk = false;
    const res = await api()
      .post("/api/v1/admin/domains")
      .set(a.auth)
      .send({ name: "wave-meet.com", warmed: true, mailboxes: [box("hamza@wave-meet.com", "Hamza")], locale: "ur", region: "pk" })
      .expect(201);
    expect(res.body.data.mailboxes[0]).toMatchObject({ ok: false });
    const m = await prisma.mailbox.findFirstOrThrow({ where: { address: "hamza@wave-meet.com" } });
    expect(m.status).toBe("ERROR");
    expect(m.lastError).toContain("Authentication failed");
    await evaluateDomainHealth();
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("ERROR");
    transport.signInOk = true;
    const t = await api().post(`/api/v1/admin/mailboxes/${m.id}/test`).set(a.auth).send({ password: "the-right-one" }).expect(200);
    expect(t.body.data.ok).toBe(true);
    expect(await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "ACTIVE", lastError: null, timezone: "Asia/Karachi" });
  });

  it("refuses one-letter senders, foreign addresses, a fourth mailbox, a duplicate domain and non-admins", async () => {
    const a = await admin();
    const send = (body: Record<string, unknown>) => api().post("/api/v1/admin/domains").set(a.auth).send({ warmed: true, ...body });
    await send({ name: "liftprism.com", mailboxes: [box("j@liftprism.com", "Jo")] }).expect(400);
    await send({ name: "liftprism.com", mailboxes: [box("jo@other.com", "Jo")] }).expect(400);
    await send({ name: "liftprism.com", mailboxes: ["aa", "bb", "cc", "dd"].map((x) => box(`${x}ron@liftprism.com`, "Aaron")) }).expect(400);
    await send({ name: "liftprism.com", mailboxes: [box("aaron@liftprism.com", "Aaron")] }).expect(201);
    await send({ name: "liftprism.com", mailboxes: [box("grace@liftprism.com", "Grace")] }).expect(409);
    const d = await prisma.sendingDomain.findFirstOrThrow({ where: { name: "liftprism.com" } });
    await api().post(`/api/v1/admin/domains/${d.id}/mailboxes`).set(a.auth).send(box("grace@liftprism.com", "Grace")).expect(201);
    const customer = await createTenant();
    await api().get("/api/v1/admin/domains").set(customer.auth).expect(403);
  });

  it("pauses, sets replies only and retires", async () => {
    const a = await admin();
    dnsFor("meetwavebuzz.com");
    await api().post("/api/v1/admin/domains").set(a.auth).send({ name: "meetwavebuzz.com", warmed: true, mailboxes: [box("noah@meetwavebuzz.com", "Noah"), box("grace@meetwavebuzz.com", "Grace")] }).expect(201);
    const d = await prisma.sendingDomain.findFirstOrThrow({ where: { name: "meetwavebuzz.com" }, include: { mailboxes: { orderBy: { address: "asc" } } } });
    await api().post(`/api/v1/admin/domains/${d.id}/pause`).set(a.auth).send({ reason: "checking a complaint" }).expect(200);
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d.id } })).pauseReason).toBe("checking a complaint");
    await api().post(`/api/v1/admin/mailboxes/${d.mailboxes[0].id}/replies-only`).set(a.auth).expect(200);
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: d.mailboxes[0].id } })).status).toBe("REPLIES_ONLY");
    await api().post(`/api/v1/admin/domains/${d.id}/retire`).set(a.auth).expect(200);
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("RETIRED");
    expect(await prisma.mailbox.count({ where: { sendingDomainId: d.id, status: { not: "RETIRED" } } })).toBe(0);
  });

  it("closes a taken-on restock reminder once enough domains are added", async () => {
    const a = await admin();
    await prisma.sendingDomain.create({ data: { organizationId: null, name: "old-neutral.com", status: "DEGRADED", priceCents: 0, region: "global", createdAt: new Date(Date.now() - 60 * 86_400_000), degradedAt: new Date(Date.now() - 3 * 86_400_000) } });
    await checkReorderTrigger();
    const r = await prisma.poolReorder.findFirstOrThrow();
    const taken = await api().post(`/api/v1/admin/pool/reorders/${r.id}`).set(a.auth).send({ approve: true }).expect(200);
    expect(taken.body.data.suggestions.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < r.domainsToBuy; i++) {
      await api().post("/api/v1/admin/domains").set(a.auth).send({ name: `freshname${i}.com`, warmed: false, mailboxes: [box(`lucas@freshname${i}.com`, "Lucas")] }).expect(201);
    }
    expect((await prisma.poolReorder.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("DONE");
  });
});

describe("background jobs on a machine with no scheduler", () => {
  it("matches every registry schedule the way cron does", () => {
    const at = (iso: string) => new Date(iso);
    expect(cronMatches("*/5 * * * *", at("2026-10-12T09:10:00Z"))).toBe(true);
    expect(cronMatches("*/5 * * * *", at("2026-10-12T09:11:00Z"))).toBe(false);
    expect(cronMatches("0 18 * * 1-5", at("2026-10-12T18:00:00Z"))).toBe(true);
    expect(cronMatches("0 18 * * 1-5", at("2026-10-11T18:00:00Z"))).toBe(false);
    expect(cronMatches("0 8 1 * *", at("2026-11-01T08:00:00Z"))).toBe(true);
    expect(cronMatches("0 */2 * * *", at("2026-10-12T14:00:00Z"))).toBe(true);
    expect(cronMatches("0 */2 * * *", at("2026-10-12T15:00:00Z"))).toBe(false);
    expect(cronMatches("40 0 * * 1", at("2026-10-12T00:40:00Z"))).toBe(true);
    // Every job fires at least once in a month of minutes.
    const fired = new Set<string>();
    for (let t = Date.parse("2026-10-01T00:00:00Z"); t < Date.parse("2026-11-01T00:00:00Z"); t += 60_000) {
      for (const [name, j] of Object.entries(JOBS)) if (cronMatches(j.schedule, new Date(t))) fired.add(name);
    }
    expect([...fired].sort()).toEqual(Object.keys(JOBS).sort());
  });
});
