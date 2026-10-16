import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, makeContact, makePoolMailbox, resetDb, transport } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { readMailbox } from "../src/domain/sending/jobs.js";
import { shardOf, startMailboxWatcher, type MailboxWatcher } from "../src/domain/sending/watch.js";
import { inboxChanged } from "../src/domain/sending/inboxEvents.js";
import { setTransport } from "../src/domain/sending/transport/index.js";
import type { MailboxCreds, MailTransport } from "../src/domain/sending/transport/index.js";

const mail = (to: string, subject = "Re: hello") =>
  [`From: Someone <someone@elsewhere.com>`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${Math.random()}@elsewhere.com>`, `Date: ${new Date().toUTCString()}`, "", "Sounds good."].join("\n");

async function until<T>(check: () => Promise<T | null | undefined | false>, ms = 6_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The fake transport with IDLE: `push(address)` is the mail server saying EXISTS on that mailbox's connection. */
function idleTransport(dropFirst = false) {
  const listeners = new Map<string, () => void>();
  const connects: string[] = [];
  const t: MailTransport = {
    id: "smtp",
    send: transport.send.bind(transport),
    verify: transport.verify.bind(transport),
    fetchNew: transport.fetchNew.bind(transport),
    async watch(c: MailboxCreds, onNew: () => void, signal: AbortSignal) {
      connects.push(c.address);
      // The first connection drops straight away, as a flaky network would.
      if (dropFirst && connects.filter((a) => a === c.address).length === 1) return;
      listeners.set(c.address, onNew);
      onNew();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      listeners.delete(c.address);
    },
  };
  return { t, connects, connected: (address: string) => listeners.has(address), push: (address: string) => listeners.get(address)?.() };
}

describe("instant replies", () => {
  let watcher: MailboxWatcher | null = null;
  beforeEach(resetDb);
  afterEach(async () => {
    await watcher?.stop();
    watcher = null;
    setTransport(null);
  });

  it("reads a mailbox only once when the poll and the watcher reach it together", async () => {
    const m = await makePoolMailbox();
    transport.deliver(m.address, mail(m.address));
    const [a, b] = await Promise.all([readMailbox(m.id), readMailbox(m.id)]);
    expect(a.read + b.read).toBe(1);
    expect(await prisma.inboundMessage.count()).toBe(1);
    // And a later read sees nothing new: the last UID moved on.
    expect((await readMailbox(m.id)).read).toBe(0);
  });

  it("reads new mail the moment the mail server signals it, without waiting for the poll", async () => {
    const idle = idleTransport();
    setTransport(idle.t);
    const m = await makePoolMailbox();
    watcher = startMailboxWatcher({ debounceMs: 10, refreshMs: 60_000 });
    await until(async () => idle.connected(m.address));
    // The catch-up read on connect found nothing; now a reply lands.
    transport.deliver(m.address, mail(m.address));
    idle.push(m.address);
    const row = await until(() => prisma.inboundMessage.findFirst());
    expect(row.subject).toBe("Re: hello");
    expect(watcher.status()).toMatchObject({ watching: 1, connected: 1 });
  });

  it("catches up on mail that arrived while it had no connection", async () => {
    const idle = idleTransport();
    setTransport(idle.t);
    const m = await makePoolMailbox();
    transport.deliver(m.address, mail(m.address, "Re: while offline"));
    watcher = startMailboxWatcher({ debounceMs: 10 });
    const row = await until(() => prisma.inboundMessage.findFirst());
    expect(row.subject).toBe("Re: while offline");
  });

  it("reconnects after the connection drops", async () => {
    const idle = idleTransport(true);
    setTransport(idle.t);
    const m = await makePoolMailbox();
    watcher = startMailboxWatcher({ debounceMs: 10 });
    await until(async () => idle.connected(m.address), 8_000);
    expect(idle.connects.filter((a) => a === m.address).length).toBe(2);
  });

  it("lets go of a retired mailbox and leaves mailboxes without IDLE to the poll", async () => {
    const idle = idleTransport();
    setTransport(idle.t);
    const m = await makePoolMailbox();
    watcher = startMailboxWatcher({ debounceMs: 10 });
    await until(async () => idle.connected(m.address));
    await prisma.mailbox.update({ where: { id: m.id }, data: { status: "RETIRED" } });
    await watcher.refresh();
    await until(async () => !idle.connected(m.address));
    expect(watcher.status().watching).toBe(0);

    await watcher.stop();
    setTransport(transport); // the plain fake has no watch(): the poll still reads it, the watcher holds nothing
    await prisma.mailbox.update({ where: { id: m.id }, data: { status: "ACTIVE" } });
    watcher = startMailboxWatcher();
    await watcher.refresh();
    expect(watcher.status().watching).toBe(0);
  });

  it("splits mailboxes across watcher processes so each is held exactly once", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `cm${i.toString(36)}mailbox${i * 7919}`);
    const owners = ids.map((id) => shardOf(id, 3));
    expect(owners.every((o) => o >= 0 && o < 3)).toBe(true);
    expect(ids.map((id) => shardOf(id, 3))).toEqual(owners);
    // Spread evenly enough that no process carries most of the pool.
    for (const s of [0, 1, 2]) expect(owners.filter((o) => o === s).length).toBeGreaterThan(40);
  });
});

describe("live inbox stream", () => {
  beforeEach(resetDb);

  it("tells an open tab the moment a reply arrives, and only its own workspace's", async () => {
    const t = await createTenant();
    const other = await createTenant({ email: "other@example.com" });
    const contact = await makeContact(t.orgId, { firstName: "Hassan", lastName: "Javed", company: "Javed Trading" });
    const otherContact = await makeContact(other.orgId);

    const req = api().get("/api/v1/inbox/stream").set(t.auth);
    const events: { type: string; replies?: number; latest?: { name: string; company: string | null } }[] = [];
    const done = new Promise<void>((resolve, reject) => {
      req
        .buffer(false)
        .parse((res, cb) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buf += chunk;
            const parts = buf.split("\n\n");
            buf = parts.pop() ?? "";
            for (const p of parts) {
              const line = p.split("\n").find((l) => l.startsWith("data: "));
              if (!line) continue;
              const e = JSON.parse(line.slice(6));
              events.push(e);
              if (e.type === "ready") {
                // Another workspace's reply first: this tab must not hear about it.
                void prisma.message
                  .create({ data: { organizationId: other.orgId, contactId: otherContact.id, direction: "INBOUND", body: "not yours" } })
                  .then(() => inboxChanged())
                  .then(() => new Promise((r) => setTimeout(r, 300)))
                  .then(() => prisma.message.create({ data: { organizationId: t.orgId, contactId: contact.id, direction: "INBOUND", body: "yes i am interested" } }))
                  .then(() => inboxChanged())
                  .catch(reject);
              }
              if (e.type === "inbox") {
                (res as unknown as { destroy: () => void }).destroy();
                resolve();
              }
            }
          });
          res.on("error", () => resolve());
          res.on("end", () => cb(null, ""));
        })
        .end(() => resolve());
    });
    const started = Date.now();
    await done;
    const inbox = events.filter((e) => e.type === "inbox");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ replies: 1, latest: { name: "Hassan Javed", company: "Javed Trading" } });
    // Woken by the nudge, not by the 5-second check.
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
