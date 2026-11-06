import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, createTenant, makePoolMailbox, resetDb, transport, type TestTenant } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setTxtResolver } from "../src/domain/pool/auth.js";
import { secretStore } from "../src/integrations/secrets.js";
import { webhookSignature } from "../src/integrations/inboxkit.js";
import { runSync } from "../src/domain/pool/inboxkit/sync.js";
import { placeDue, scheduleFor } from "../src/domain/pool/inboxkit/orders.js";
import { retireMailbox } from "../src/domain/pool/lifecycle.js";
import { capForWarmupDay } from "../src/domain/pool/lifecycle.js";
import { pipeline } from "../src/domain/pool/inboxkit/view.js";

/**
 * "Add new domains" through InboxKit, end to end against a fake InboxKit: setup, the suggestion, the price check, the
 * confirmed order placed in batches within the pool's limits, a wallet that runs dry, a name InboxKit turns down, a
 * placement with no answer, then each domain from InboxKit's setup through its warmup to the ladder, and a retired
 * mailbox cancelled so it stops being billed. InboxKit is never called for real.
 */

const KEY = "ik_live_0123456789abcdefghij";
const DAY = 86_400_000;
const DKIM = `v=DKIM1; k=rsa; p=${generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }).toString("base64")}`;
const CONTACT = { first_name: "Zainab", last_name: "Irshad", email: "ops@ekhata.ai", phone: "+92 300 1234567", organization: "Ekhata", address_line1: "1 Main Boulevard", city: "Lahore", state: "Punjab", country: "PK", postal_code: "54000" };

type Box = { uid: string; email: string; domain: string; status: string; appPassword: string };
type Sub = { status: string; startedAt: string | null; health: string; score: number; inboxRate: number; day: number };

/** An in-memory InboxKit that answers the calls Aperture makes. */
class FakeInboxKit {
  workspaces = [{ uid: "ws_aperture", name: "Aperture pool" }];
  wallet = 1000;
  domainPrice = 12;
  mailboxPrice: number | null = 3;
  taken = new Set<string>();
  domains = new Map<string, { uid: string; name: string; status: string }>();
  boxes = new Map<string, Box>();
  subs = new Map<string, Sub>();
  orders: { contact_details: Record<string, string>; domains: { name: string; redirect_url: string; mailboxes: { email: string; first_name: string; last_name: string; platform: string }[] }[]; warmup_addon_enabled: boolean }[] = [];
  cancelled: string[] = [];
  warmupCancelled: string[] = [];
  warmupAdded: string[] = [];
  webhook: { uid: string; url: string } | null = null;
  /** Domains InboxKit has taken but doesn't list yet. */
  hidden = new Set<string>();
  /** Overrides the answer to POST /orders. */
  onOrder: ((body: FakeInboxKit["orders"][number]) => { status: number; body: unknown } | "drop") | null = null;
  calls: { method: string; path: string; workspace: string | null }[] = [];
  private n = 0;

  /** InboxKit finishes building a domain and its mailboxes, and warmup starts at `startedAt`. */
  finish(name: string, startedAt: Date | null = new Date(), health = "excellent", inboxRate = 96) {
    const d = this.domains.get(name)!;
    d.status = "active";
    for (const b of this.boxes.values()) {
      if (b.domain !== name) continue;
      b.status = "active";
      this.subs.set(b.uid, { status: startedAt ? "active" : "pending_activation", startedAt: startedAt?.toISOString() ?? null, health, score: 91, inboxRate, day: 3 });
    }
  }

  handle = async (input: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : {};
    const headers = init?.headers ?? {};
    this.calls.push({ method, path, workspace: headers["X-Workspace-Id"] ?? null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (headers.Authorization !== `Bearer ${KEY}`) return json(401, { error: true, message: "Invalid API Key" });
    switch (`${method} ${path}`) {
      case "GET /workspaces/list":
        return json(200, { error: false, workspaces: this.workspaces });
      case "POST /workspaces/webhook":
        this.webhook = { uid: body.uid, url: body.webhook_url };
        return json(200, { error: false, message: "ok" });
      case "GET /account":
        return json(200, { credits_remaining: this.wallet, cost_per_google_mailbox: this.mailboxPrice, cost_per_ms_outlook_mailbox: this.mailboxPrice, admin_email: "ops@ekhata.ai" });
      case "GET /warmup/pricing":
        return json(200, { error: false, price_per_mailbox: 3, currency: "USD" });
      case "GET /domains/available": {
        const d = url.searchParams.get("domain")!;
        const free = !this.taken.has(d) && !this.domains.has(d);
        return json(200, { error: false, available: free, banned: false, registration_price: this.domainPrice, renewal_price: this.domainPrice });
      }
      case "POST /orders": {
        if (this.onOrder) {
          const r = this.onOrder(body);
          if (r === "drop") throw new TypeError("fetch failed: socket hang up");
          if (r.status !== 201) return json(r.status, r.body);
        }
        const cost = body.domains.length * this.domainPrice + body.domains.reduce((a: number, d: { mailboxes: unknown[] }) => a + d.mailboxes.length * (3 + (body.warmup_addon_enabled ? 3 : 0)), 0);
        if (cost > this.wallet) return json(402, [{ status: "error", message: "Insufficient wallet credit balance", total_cost: cost, available_credits: this.wallet }]);
        this.wallet -= cost;
        this.orders.push(body);
        const out = [];
        for (const d of body.domains) {
          if (this.taken.has(d.name)) {
            out.push({ order_id: "ord_x", status: "error", domain: d.name, message: `Domain ${d.name} is not available`, available: false, banned: false });
            continue;
          }
          this.domains.set(d.name, { uid: `dom_${++this.n}`, name: d.name, status: "registration_in_progress" });
          for (const m of d.mailboxes) this.boxes.set(m.email, { uid: `mbx_${++this.n}`, email: m.email, domain: d.name, status: "configuring_workspace", appPassword: `app-pass-${this.n}` });
          out.push({ order_id: "ord_1", status: `${d.name} queued`, domain: d.name, platform: "GOOGLE", mailboxes: d.mailboxes.map((m: { email: string }) => m.email), warmup_addon_enabled: true });
        }
        return json(201, out);
      }
      case "POST /domains/list":
        return json(200, { error: false, domains: [...this.domains.values()].filter((d) => !this.hidden.has(d.name)).map((d) => ({ ...d, nameserver_match_status: "matched" })), pages: 1, current_page: 1 });
      case "POST /mailboxes/list":
        return json(200, { error: false, mailboxes: [...this.boxes.values()].filter((b) => !this.hidden.has(b.domain)).map((b) => ({ uid: b.uid, username: b.email.split("@")[0], domain_name: b.domain, platform: "GOOGLE", status: b.status })), pages: 1 });
      case "GET /mailboxes/show-credentials": {
        const b = [...this.boxes.values()].find((x) => x.uid === url.searchParams.get("uid"));
        if (!b) return json(404, { error: true, message: "Mailbox not found" });
        if (b.status !== "active") return json(400, { error: true, message: "Mailbox is not active yet. Please wait for it to be active." });
        return json(200, { error: false, password: "web-login-pass", secret: "totp", app_password: b.appPassword });
      }
      case "POST /warmup/list":
        return json(200, {
          error: false,
          subscriptions: [...this.subs.entries()].map(([uid, s]) => ({ uid: `ws-${uid}`, status: s.status, mailbox_email: [...this.boxes.values()].find((b) => b.uid === uid)?.email, health_status: s.health, started_at: s.startedAt, cached_stats: { health_score: s.score, inbox_rate: s.inboxRate, warmup_day: s.day }, mailbox: { uid } })),
          pages: 1,
        });
      case "POST /warmup/add":
        this.warmupAdded.push(...body.mailbox_uids);
        for (const uid of body.mailbox_uids) this.subs.set(uid, { status: "pending_activation", startedAt: null, health: "unknown", score: 0, inboxRate: 0, day: 0 });
        return json(201, { error: false, subscriptions: [] });
      case "POST /warmup/cancel":
        this.warmupCancelled.push(...body.mailbox_uids);
        for (const uid of body.mailbox_uids) this.subs.delete(uid);
        return json(200, { error: false, results: { success: [], failed: [] } });
      case "POST /mailboxes/cancel":
        this.cancelled.push(...body.uids);
        return json(200, { error: false, message: "Mailbox scheduled for cancellation" });
      default:
        return json(404, { error: true, message: `no fake for ${method} ${path}` });
    }
  };
}

let ik: FakeInboxKit;

async function admin(): Promise<TestTenant> {
  const a = await createTenant();
  await prisma.user.update({ where: { id: a.userId }, data: { isPlatformAdmin: true } });
  return a;
}

async function setUp(a: TestTenant) {
  await api().put("/api/v1/admin/inboxkit/key").set(a.auth).send({ key: KEY }).expect(200);
  return api().patch("/api/v1/admin/inboxkit/settings").set(a.auth).send({ workspaceUid: "ws_aperture", contact: CONTACT, redirectUrl: "https://ekhata.ai" }).expect(200);
}

/** SPF, DKIM (selector google) and DMARC for every domain. */
const dnsPassesEverywhere = () =>
  setTxtResolver(async (q) => (q.startsWith("_dmarc.") ? [["v=DMARC1; p=none"]] : q.startsWith("google._domainkey.") ? [[DKIM]] : [["v=spf1 include:_spf.google.com ~all"]]));

async function quoteAndConfirm(a: TestTenant, domains: number) {
  const q = await api().post("/api/v1/admin/inboxkit/quote").set(a.auth).send({ domains }).expect(201);
  const c = await api().post(`/api/v1/admin/inboxkit/orders/${q.body.data.id}/confirm`).set(a.auth).send({}).expect(200);
  return { quote: q.body.data, order: c.body.data };
}

beforeEach(async () => {
  await resetDb();
  ik = new FakeInboxKit();
  vi.stubGlobal("fetch", vi.fn(ik.handle));
});
afterEach(() => vi.unstubAllGlobals());

describe("InboxKit setup", () => {
  it("lists what is missing, checks the key before keeping it, never returns it, and points webhooks at Aperture", async () => {
    const a = await admin();
    const before = await api().get("/api/v1/admin/inboxkit").set(a.auth).expect(200);
    expect(before.body.data.key.set).toBe(false);
    expect(before.body.data.blockers[0]).toMatch(/API key/);
    await api().post("/api/v1/admin/inboxkit/quote").set(a.auth).send({ domains: 2 }).expect(422);

    await api().put("/api/v1/admin/inboxkit/key").set(a.auth).send({ key: "ik_wrong_000000000000000" }).expect(400);
    expect(await secretStore().get("inboxkit:api-key")).toBeNull();

    const done = await setUp(a);
    expect(JSON.stringify(done.body)).not.toContain(KEY);
    expect(done.body.data).toMatchObject({ connected: true, wallet: 1000, blockers: [], settings: { workspaceName: "Aperture pool", warmupDays: 28, keepWarmupAfterLive: true } });
    expect(done.body.data.prices).toEqual({ mailboxMonthUsd: 3, warmupMonthUsd: 3, estimated: false });
    expect(ik.webhook).toEqual({ uid: "ws_aperture", url: "http://localhost:4000/api/v1/inboxkit/webhook" });

    await api().patch("/api/v1/admin/inboxkit/settings").set(a.auth).send({ redirectUrl: "http://ekhata.ai" }).expect(400);
    await api().patch("/api/v1/admin/inboxkit/settings").set(a.auth).send({ warmupDays: 7 }).expect(400);
    await api().patch("/api/v1/admin/inboxkit/settings").set(a.auth).send({ workspaceUid: "ws_someone_else" }).expect(400);
  });

  it("works out how many domains to order from the pool's own numbers, and shows every step", async () => {
    const a = await admin();
    await setUp(a);
    // The screenshot case: one customer launched at 100 emails a day, one mailbox sending.
    const customer = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: customer.orgId }, data: { autopilotEnabled: true, dailyBudgetDecicents: 4_000n } });
    await prisma.onboarding.create({ data: { organizationId: customer.orgId, domain: "northwind.io", brand: "Northwind", icp: {}, launchedAt: new Date() } });
    await makePoolMailbox();
    const r = await api().get("/api/v1/admin/inboxkit/plan").set(a.auth).expect(200);
    // 100 / 30 = 4 mailboxes needed, + 20% spare = 1, no burns measured yet, 1 already sending: 4 short = 2 domains.
    expect(r.body.data.maths).toMatchObject({ committedPerDay: 100, neededMailboxes: 4, spareMailboxes: 1, weeklyBurnDomains: 0, burnMailboxes: 0, sendingMailboxes: 1, onTheWayMailboxes: 0, orderedMailboxes: 0, haveMailboxes: 1, shortMailboxes: 4, weeksToSend: 8 });
    expect(r.body.data.suggested).toEqual({ domains: 2, mailboxes: 6 });
    expect(r.body.data.limits).toMatchObject({ perBatch: 5, perDay: 10, placedToday: 0 });

    // Once those 2 are ordered, the same plan says nothing more is needed.
    await quoteAndConfirm(a, 2);
    const after = await api().get("/api/v1/admin/inboxkit/plan").set(a.auth).expect(200);
    expect(after.body.data.maths).toMatchObject({ onTheWayMailboxes: 6, haveMailboxes: 7, shortMailboxes: 0 });
    expect(after.body.data.suggested.domains).toBe(0);
  });

  it("suggests nothing for a pool no customer is using yet", async () => {
    const a = await admin();
    await setUp(a);
    const r = await api().get("/api/v1/admin/inboxkit/plan").set(a.auth).expect(200);
    expect(r.body.data.suggested).toEqual({ domains: 0, mailboxes: 0 });
  });
});

describe("Add new domains", () => {
  it("prices clean, available names with three people on each, and spends nothing until confirmed", async () => {
    const a = await admin();
    await setUp(a);
    const q = await api().post("/api/v1/admin/inboxkit/quote").set(a.auth).send({ domains: 2, region: "pk", locale: "ur" }).expect(201);
    const o = q.body.data;
    expect(o.status).toBe("QUOTED");
    expect(o.items).toHaveLength(2);
    for (const it of o.items) {
      expect(it.domain).toMatch(/^[a-z-]+\.(com|org|co|net|site)$/);
      expect(it.mailboxes).toHaveLength(3);
      expect(new Set(it.mailboxes.map((m: { email: string }) => m.email.split("@")[0])).size).toBe(3);
      for (const m of it.mailboxes) expect(m.email.endsWith(`@${it.domain}`)).toBe(true);
    }
    // 2 domains at $12, 6 mailboxes at $3, warmup at $3 each.
    expect(o.estimate).toMatchObject({ domains: 2, mailboxes: 6, domainsUsd: 24, mailboxMonthUsd: 18, warmupMonthUsd: 18, firstMonthUsd: 60, perMonthUsd: 38, walletUsd: 1000 });
    expect(ik.orders).toHaveLength(0);
    expect(await prisma.sendingDomain.count()).toBe(0);
  });

  it("prices with InboxKit's published price, marked as an estimate, when the account reports none (never $0)", async () => {
    const a = await admin();
    await setUp(a);
    ik.mailboxPrice = null;
    const st = await api().get("/api/v1/admin/inboxkit").set(a.auth).expect(200);
    expect(st.body.data.prices).toEqual({ mailboxMonthUsd: 3, warmupMonthUsd: 3, estimated: true });
    const q = await api().post("/api/v1/admin/inboxkit/quote").set(a.auth).send({ domains: 1 }).expect(201);
    expect(q.body.data.estimate).toMatchObject({ mailboxMonthUsd: 9, unit: { mailboxMonthUsd: 3, estimated: true } });
  });

  it("orders in batches within the pool's limits, with the contact, a forward and warmup on every mailbox", async () => {
    const a = await admin();
    await setUp(a);
    const { order } = await quoteAndConfirm(a, 7);
    // 5 a batch: the first batch goes at once, the other 2 three hours later.
    expect(order).toMatchObject({ status: "SCHEDULED", requested: 7, placed: 5, pending: 2 });
    expect(ik.orders).toHaveLength(1);
    const sent = ik.orders[0];
    expect(sent.warmup_addon_enabled).toBe(true);
    expect(sent.contact_details).toMatchObject({ first_name: "Zainab", country: "PK" });
    expect(sent.domains[0]).toMatchObject({ redirect_url: "https://ekhata.ai" });
    expect(sent.domains[0].mailboxes).toHaveLength(3);
    expect(ik.calls.filter((c) => c.path === "/orders").every((c) => c.workspace === "ws_aperture")).toBe(true);

    const pool = await prisma.sendingDomain.findMany({ include: { mailboxes: true } });
    expect(pool).toHaveLength(5);
    for (const d of pool) {
      expect(d).toMatchObject({ status: "REGISTERED", supplier: "inboxkit", externalWarmup: true, warmupTargetDays: 28, registrar: "inboxkit" });
      expect(d.mailboxes.map((m) => [m.status, m.provider, m.smtpHost, m.credentialRef])).toEqual(Array(3).fill(["CREATING", "inboxkit", "smtp.gmail.com", null]));
    }
    // Not yet: the next batch waits its turn.
    await placeDue(new Date(Date.now() + 60_000));
    expect(ik.orders).toHaveLength(1);
    await placeDue(new Date(Date.now() + 3 * 3_600_000 + 60_000));
    expect(ik.orders).toHaveLength(2);
    const after = await api().get(`/api/v1/admin/inboxkit/orders/${order.id}`).set(a.auth).expect(200);
    expect(after.body.data).toMatchObject({ status: "DONE", placed: 7, pending: 0 });
  });

  it("stops at the daily limit and carries on the next day by itself", async () => {
    const a = await admin();
    await setUp(a);
    await prisma.poolSettings.upsert({ where: { id: "default" }, create: { id: "default", maxBuyPerBatch: 3, maxBuyPerDay: 3 }, update: { maxBuyPerBatch: 3, maxBuyPerDay: 3 } });
    const { order } = await quoteAndConfirm(a, 5);
    expect(order).toMatchObject({ placed: 3, pending: 2 });
    const o = await prisma.supplierOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.nextRunAt!.getTime()).toBeGreaterThan(new Date(new Date().setUTCHours(24, 0, 0, 0)).getTime());
    expect(scheduleFor(5, 3, 0)).toEqual([expect.objectContaining({ domains: 3 }), expect.objectContaining({ domains: 2 })]);
  });

  it("waits for the InboxKit wallet without buying anything, then carries on once it is topped up", async () => {
    const a = await admin();
    await setUp(a);
    ik.wallet = 30;
    const { order } = await quoteAndConfirm(a, 2);
    expect(order).toMatchObject({ status: "WAITING_FOR_FUNDS", placed: 0, pending: 2 });
    expect(order.lastError).toMatch(/wallet has \$30\.00; this batch needs \$60\.00/);
    expect(ik.orders).toHaveLength(0);
    expect(await prisma.systemLog.count({ where: { level: "CRITICAL", message: { contains: "InboxKit order paused" } } })).toBe(1);
    ik.wallet = 500;
    await placeDue(new Date(Date.now() + 3_600_000 + 60_000));
    const after = await prisma.supplierOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(after.status).toBe("DONE");
    expect(after.items.every((i) => i.status === "PLACED")).toBe(true);
  });

  it("puts a fresh name in place of one InboxKit turns down, in the next batch", async () => {
    const a = await admin();
    await setUp(a);
    const q = await api().post("/api/v1/admin/inboxkit/quote").set(a.auth).send({ domains: 2 }).expect(201);
    const doomed = q.body.data.items[0].domain;
    // Taken by someone else between Aperture's last check and the order itself.
    ik.onOrder = () => {
      ik.taken.add(doomed);
      ik.onOrder = null;
      return { status: 201, body: null };
    };
    await api().post(`/api/v1/admin/inboxkit/orders/${q.body.data.id}/confirm`).set(a.auth).send({}).expect(200);
    const mid = await prisma.supplierOrderItem.findMany({ where: { orderId: q.body.data.id } });
    expect(mid.find((i) => i.domainName === doomed)).toMatchObject({ status: "REJECTED" });
    expect(mid.find((i) => i.domainName === doomed)!.message).toMatch(/^Name not usable/);
    expect(mid.filter((i) => i.status === "PENDING")).toHaveLength(1);
    await placeDue(new Date(Date.now() + 3 * 3_600_000 + 60_000));
    const end = await prisma.supplierOrder.findUniqueOrThrow({ where: { id: q.body.data.id }, include: { items: true } });
    expect(end.status).toBe("PARTIAL");
    expect(end.items.filter((i) => i.status === "PLACED")).toHaveLength(2);
    expect(end.items.find((i) => i.message?.startsWith("Replaces"))?.domainName).not.toBe(doomed);
  });

  it("never orders twice when InboxKit gives no answer: the sync adopts the domain once InboxKit shows it", async () => {
    const a = await admin();
    await setUp(a);
    let dropped = 0;
    ik.onOrder = (body) => {
      // InboxKit takes the order, but the answer never arrives.
      ik.onOrder = null;
      void ik.handle("https://api.inboxkit.com/v1/api/orders", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "X-Workspace-Id": "ws_aperture" }, body: JSON.stringify(body) });
      dropped++;
      return "drop";
    };
    const { order } = await quoteAndConfirm(a, 2);
    expect(dropped).toBe(1);
    expect(order).toMatchObject({ placed: 0, pending: 2 });
    expect(ik.orders).toHaveLength(1);
    // Due again in 30 minutes, but the items are PLACING, so nothing is sent again.
    await placeDue(new Date(Date.now() + 31 * 60_000));
    expect(ik.orders).toHaveLength(1);
    await runSync(new Date(Date.now() + 15 * 60_000));
    const after = await prisma.supplierOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(after.items.every((i) => i.status === "PLACED")).toBe(true);
    expect(await prisma.sendingDomain.count({ where: { supplier: "inboxkit" } })).toBe(2);
    expect(ik.orders).toHaveLength(1);
  });

  it("never orders again after no answer, even when InboxKit takes a day to list the domain, and adopts it then", async () => {
    const a = await admin();
    await setUp(a);
    ik.onOrder = (body) => {
      ik.onOrder = null;
      void ik.handle("https://api.inboxkit.com/v1/api/orders", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "X-Workspace-Id": "ws_aperture" }, body: JSON.stringify(body) });
      for (const d of body.domains) ik.hidden.add(d.name);
      return "drop";
    };
    const { order } = await quoteAndConfirm(a, 1);
    const t0 = Date.now();
    for (const h of [1, 3, 12, 25]) {
      await placeDue(new Date(t0 + h * 3_600_000));
      await runSync(new Date(t0 + h * 3_600_000));
    }
    expect(ik.orders).toHaveLength(1);
    const item = await prisma.supplierOrderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(item.status).toBe("REJECTED");
    expect(item.message).toMatch(/^InboxKit never confirmed it/);
    expect(await prisma.systemLog.count({ where: { level: "ERROR", message: { contains: "never confirmed" } } })).toBe(1);
    // InboxKit lists it after all: adopted, still only one order.
    ik.hidden.clear();
    await runSync(new Date(t0 + 30 * 3_600_000));
    expect((await prisma.supplierOrderItem.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("PLACED");
    expect(await prisma.sendingDomain.count({ where: { supplier: "inboxkit" } })).toBe(1);
    expect(ik.orders).toHaveLength(1);
  });

  it("stays cancelled: a batch waiting for the wallet never buys after a cancel", async () => {
    const a = await admin();
    await setUp(a);
    ik.wallet = 10;
    const { order } = await quoteAndConfirm(a, 2);
    expect(order.status).toBe("WAITING_FOR_FUNDS");
    await api().post(`/api/v1/admin/inboxkit/orders/${order.id}/cancel`).set(a.auth).send({}).expect(200);
    ik.wallet = 1000;
    await placeDue(new Date(Date.now() + 2 * 3_600_000));
    await runSync(new Date(Date.now() + 2 * 3_600_000));
    expect(ik.orders).toHaveLength(0);
    expect((await prisma.supplierOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CANCELLED");
  });

  it("won't switch workspace while it is following domains there", async () => {
    const a = await admin();
    await setUp(a);
    await quoteAndConfirm(a, 1);
    ik.workspaces.push({ uid: "ws_other", name: "Other" });
    const r = await api().patch("/api/v1/admin/inboxkit/settings").set(a.auth).send({ workspaceUid: "ws_other" }).expect(400);
    expect(r.body.error.message).toMatch(/still following/);
  });

  it("cancels what isn't ordered yet", async () => {
    const a = await admin();
    await setUp(a);
    const { order } = await quoteAndConfirm(a, 7);
    const c = await api().post(`/api/v1/admin/inboxkit/orders/${order.id}/cancel`).set(a.auth).send({}).expect(200);
    expect(c.body.data).toMatchObject({ status: "CANCELLED", placed: 5, rejected: 2 });
    await placeDue(new Date(Date.now() + 4 * 3_600_000));
    expect(ik.orders).toHaveLength(1);
  });
});

describe("from InboxKit's setup to the ladder", () => {
  it("signs mailboxes in with InboxKit's app password, waits out 28 days of healthy warmup, then starts at 10 a day", async () => {
    const a = await admin();
    await setUp(a);
    dnsPassesEverywhere();
    await quoteAndConfirm(a, 1);
    const d0 = await prisma.sendingDomain.findFirstOrThrow({ include: { mailboxes: true } });

    // InboxKit is still building it: nothing to sign in yet.
    await runSync();
    expect((await prisma.mailbox.findMany()).every((m) => m.status === "CREATING")).toBe(true);

    const t0 = new Date();
    ik.finish(d0.name, t0);
    await runSync(t0);
    const d1 = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d0.id }, include: { mailboxes: true } });
    expect(d1.status).toBe("AGING");
    expect(d1.supplierWarmupAt?.getTime()).toBe(t0.getTime());
    expect(d1.agingUntil?.getTime()).toBe(t0.getTime() + 28 * DAY);
    for (const m of d1.mailboxes) {
      expect(m).toMatchObject({ status: "CONNECTING", lastError: null, supplierWarmupStatus: "active", warmupHealth: "excellent" });
      expect(m.providerId).toMatch(/^mbx_/);
      expect(JSON.parse((await secretStore().get(m.credentialRef!))!)).toEqual({ u: m.address, p: expect.stringMatching(/^app-pass-/) });
    }
    // The pool doesn't count it yet.
    expect(await prisma.mailbox.count({ where: { status: { in: ["ACTIVE", "WARMING"] } } })).toBe(0);

    // Day 20: still warming.
    await runSync(new Date(t0.getTime() + 20 * DAY));
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d0.id } })).status).toBe("AGING");

    // Day 29, healthy: the ladder at day 8, 10 a day.
    await runSync(new Date(t0.getTime() + 29 * DAY));
    const d2 = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d0.id }, include: { mailboxes: true } });
    expect(d2.status).toBe("WARMING");
    expect(d2.mailboxes.map((m) => [m.status, m.warmupDay, m.sendCapToday])).toEqual(Array(3).fill(["WARMING", 8, capForWarmupDay(8)]));
    expect(capForWarmupDay(8)).toBe(10);
    // Warmup stays on (the recommended default).
    expect(ik.warmupCancelled).toHaveLength(0);
    // Admin > Domains shows where it is.
    const board = await api().get("/api/v1/admin/inboxkit/pipeline").set(a.auth).expect(200);
    expect(board.body.data.domains[0]).toMatchObject({ name: d0.name, stage: "ladder", label: "Starting to send" });
    expect(transport.sent).toHaveLength(0);
  });

  it("holds a domain back when InboxKit's warmup health is poor, and says why", async () => {
    const a = await admin();
    await setUp(a);
    dnsPassesEverywhere();
    await quoteAndConfirm(a, 1);
    const d0 = await prisma.sendingDomain.findFirstOrThrow();
    const t0 = new Date();
    ik.finish(d0.name, t0, "warning", 62);
    await runSync(t0);
    await runSync(new Date(t0.getTime() + 29 * DAY));
    const d = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d0.id } });
    expect(d.status).toBe("AGING");
    expect(d.lastError).toMatch(/warmup health is low.*warning, inbox 62%/);
    const board = await pipeline(new Date(t0.getTime() + 29 * DAY));
    expect(board.domains[0]).toMatchObject({ stage: "held", label: "Held back", day: 28, of: 28 });
  });

  it("keeps a mailbox that can't sign in out of sending, and counts warmup only once every mailbox has started", async () => {
    const a = await admin();
    await setUp(a);
    dnsPassesEverywhere();
    await quoteAndConfirm(a, 1);
    const d0 = await prisma.sendingDomain.findFirstOrThrow();
    ik.finish(d0.name, null);
    transport.signInOk = false;
    await runSync();
    const boxes = await prisma.mailbox.findMany();
    expect(boxes.every((m) => m.status === "ERROR" && /535/.test(m.lastError ?? ""))).toBe(true);
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d0.id } })).supplierWarmupAt).toBeNull();
    transport.signInOk = true;
    await runSync();
    expect((await prisma.mailbox.findMany()).every((m) => m.status === "CONNECTING")).toBe(true);
  });

  it("cancels InboxKit warmup once at the ladder when set to, and never books it again", async () => {
    const a = await admin();
    await setUp(a);
    await api().patch("/api/v1/admin/inboxkit/settings").set(a.auth).send({ keepWarmupAfterLive: false }).expect(200);
    dnsPassesEverywhere();
    await quoteAndConfirm(a, 1);
    const d0 = await prisma.sendingDomain.findFirstOrThrow();
    const t0 = new Date();
    ik.finish(d0.name, t0);
    await runSync(t0);
    await runSync(new Date(t0.getTime() + 29 * DAY));
    expect(ik.warmupCancelled).toHaveLength(3);
    for (const h of [1, 2, 48]) await runSync(new Date(t0.getTime() + 29 * DAY + h * 3_600_000));
    expect(ik.warmupAdded).toHaveLength(0);
    expect((await prisma.mailbox.findMany()).every((m) => m.supplierWarmupStatus === "none")).toBe(true);
  });

  it("holds a domain whose InboxKit warmup is paused, however long ago it started", async () => {
    const a = await admin();
    await setUp(a);
    dnsPassesEverywhere();
    await quoteAndConfirm(a, 1);
    const d0 = await prisma.sendingDomain.findFirstOrThrow();
    const t0 = new Date();
    ik.finish(d0.name, t0);
    for (const s of ik.subs.values()) s.status = "paused";
    await runSync(t0);
    await runSync(new Date(t0.getTime() + 40 * DAY));
    const d = await prisma.sendingDomain.findUniqueOrThrow({ where: { id: d0.id } });
    expect(d.status).toBe("AGING");
    expect(d.lastError).toMatch(/warmup isn't running.*paused/);
  });

  it("cancels a retired mailbox at InboxKit once, so it stops being billed", async () => {
    const a = await admin();
    await setUp(a);
    dnsPassesEverywhere();
    await quoteAndConfirm(a, 1);
    const d0 = await prisma.sendingDomain.findFirstOrThrow();
    ik.finish(d0.name, new Date());
    await runSync();
    const m = await prisma.mailbox.findFirstOrThrow();
    await retireMailbox(m, new Date(), "burned and quiet for 30 days");
    // Retired while InboxKit was still building it: no InboxKit id stored yet, found by address instead.
    const early = await prisma.mailbox.findFirstOrThrow({ where: { id: { not: m.id } } });
    await prisma.mailbox.update({ where: { id: early.id }, data: { providerId: null } });
    await retireMailbox(early, new Date(), "retired by an operator");
    expect(await prisma.systemLog.count({ where: { message: { contains: "Its InboxKit plan is cancelled automatically" } } })).toBe(2);
    await runSync();
    await runSync();
    expect(ik.cancelled.sort()).toEqual([m.providerId, ik.boxes.get(early.address)!.uid].sort());
    expect((await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).supplierCancelRequestedAt).not.toBeNull();
  });

  it("stops new people on a sending mailbox InboxKit suspends; its conversations carry on", async () => {
    const a = await admin();
    await setUp(a);
    dnsPassesEverywhere();
    await quoteAndConfirm(a, 1);
    const d0 = await prisma.sendingDomain.findFirstOrThrow();
    const t0 = new Date();
    ik.finish(d0.name, t0);
    await runSync(t0);
    await runSync(new Date(t0.getTime() + 29 * DAY));
    const m = await prisma.mailbox.findFirstOrThrow({ where: { status: "WARMING" } });
    ik.boxes.get(m.address)!.status = "suspended";
    await runSync(new Date(t0.getTime() + 30 * DAY));
    expect(await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "REPLIES_ONLY", degradeReason: "InboxKit reports it suspended" });
  });
});

describe("InboxKit webhooks", () => {
  it("accepts only InboxKit's signature and never trusts or stores the body", async () => {
    const a = await admin();
    await setUp(a);
    const body = { event: "mailbox.status_changed", data: { mailbox: { uid: "mbx_1", email: "x@y.com", password: "plain", app_password: "plain" } } };
    await api().post("/api/v1/inboxkit/webhook").set("X-InboxKit-Event", "mailbox.status_changed").send(body).expect(401);
    await api().post("/api/v1/inboxkit/webhook").set("X-InboxKit-Signature", "sha256=deadbeef").send(body).expect(401);
    await api().post("/api/v1/inboxkit/webhook").set("X-InboxKit-Signature", webhookSignature(KEY)).set("X-InboxKit-Event", "mailbox.status_changed").send(body).expect(200);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(JSON.stringify(await prisma.systemLog.findMany())).not.toContain("plain");
  });
});
