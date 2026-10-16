import { createHash } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import { readMailbox } from "./jobs.js";
import { credsFor, transportFor } from "./transport/index.js";

/**
 * Instant replies. Each sending mailbox gets one connection parked in IMAP IDLE (transport.watch), so the mail server
 * tells us the moment a reply lands and the mailbox is read within a second or two, not at the next 2-minute poll.
 *
 * Correctness stays with the poll: it keeps running as the safety net (a dropped connection costs at most two
 * minutes), and both read through readMailbox(), whose per-mailbox lock means a reply is never handled twice.
 *
 * Scale: one socket per mailbox in this process, capped by MAILBOX_WATCH_MAX (the rest stay on the poll, nothing is
 * lost). Add processes and split the pool with MAILBOX_WATCH_SHARD=i/n. Reads are throttled so a burst of replies
 * can't drain the database pool. A mailbox moved to a transport without watch() (EmailEngine pushes webhooks
 * instead) simply drops out of here.
 */

/** The mailboxes the poll reads: anything that sends or still holds conversations. */
const WATCHED = ["ACTIVE", "WARMING", "REPLIES_ONLY"] as const;
const REFRESH_MS = 60_000;
/** A burst of EXISTS (several replies, or flag changes) becomes one read. */
const DEBOUNCE_MS = 750;
/** The poll was reading this mailbox when mail arrived: look again shortly, its read may have started too early. */
const BUSY_RETRY_MS = 3_000;
const PARALLEL_READS = 3;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** A connection that stayed up this long was healthy, so its drop starts the backoff again from the bottom. */
const HEALTHY_MS = 60_000;

export interface Shard {
  index: number;
  count: number;
}

export interface WatcherOptions {
  max?: number;
  shard?: Shard;
  refreshMs?: number;
  debounceMs?: number;
}

export interface WatcherStatus {
  watching: number;
  connected: number;
  reads: number;
  failedReads: number;
}

export interface MailboxWatcher {
  /** Re-reads which mailboxes to hold: new ones are connected, retired ones let go. Runs every minute on its own. */
  refresh(): Promise<void>;
  status(): WatcherStatus;
  stop(): Promise<void>;
}

/** Which of `count` watcher processes owns a mailbox: stable for its whole life, spread evenly by its id. */
export function shardOf(mailboxId: string, count: number): number {
  return createHash("sha1").update(mailboxId).digest().readUInt32BE(0) % count;
}

export function shardFromEnv(value = env.MAILBOX_WATCH_SHARD): Shard {
  if (!value) return { index: 0, count: 1 };
  const [index, count] = value.split("/").map(Number);
  if (index >= count) throw new Error(`MAILBOX_WATCH_SHARD ${value}: the index must be below the count`);
  return { index, count };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const backoff = (failures: number) => {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));
  // Jitter, so a mail server that drops every connection at once is not hit by all of them again together.
  return Math.round(base * (0.75 + Math.random() * 0.5));
};

interface Entry {
  abort: AbortController;
  connected: boolean;
  dirty: boolean;
  reading: boolean;
  timer: NodeJS.Timeout | null;
  done: Promise<void>;
}

export function startMailboxWatcher(opts: WatcherOptions = {}): MailboxWatcher {
  const max = opts.max ?? env.MAILBOX_WATCH_MAX;
  const shard = opts.shard ?? shardFromEnv();
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const entries = new Map<string, Entry>();
  const stats = { reads: 0, failedReads: 0 };
  let stopped = false;
  let overCapLogged = false;

  // A small semaphore: at most PARALLEL_READS mailboxes are read at once, whatever arrives.
  let free = PARALLEL_READS;
  const waiting: (() => void)[] = [];
  const acquire = () => (free > 0 ? (free--, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free++;
  };

  async function flush(id: string, e: Entry): Promise<void> {
    e.timer = null;
    if (e.reading) return;
    e.reading = true;
    try {
      while (e.dirty && !e.abort.signal.aborted) {
        e.dirty = false;
        await acquire();
        let busy = false;
        try {
          const r = await readMailbox(id);
          if (r.ran) stats.reads++;
          else busy = true;
          if (r.read) logger.info({ mailboxId: id, read: r.read }, "watcher: new mail read the moment it arrived");
        } catch (err) {
          stats.failedReads++;
          logger.warn({ mailboxId: id, err: (err as Error).message }, "watcher: reading the mailbox failed, the poll will retry");
        } finally {
          release();
        }
        if (busy) {
          e.dirty = true;
          await sleep(BUSY_RETRY_MS, e.abort.signal);
        }
      }
    } finally {
      e.reading = false;
    }
  }

  function trigger(id: string): void {
    const e = entries.get(id);
    if (!e || e.abort.signal.aborted) return;
    if (!e.connected) logger.info({ mailboxId: id }, "watcher: mailbox connected, waiting for new mail");
    e.connected = true;
    e.dirty = true;
    if (e.timer || e.reading) return;
    e.timer = setTimeout(() => void flush(id, e), debounceMs);
  }

  async function hold(id: string, e: Entry): Promise<void> {
    const signal = e.abort.signal;
    let failures = 0;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        const m = await prisma.mailbox.findUnique({ where: { id } });
        if (!m) return;
        const transport = transportFor(m.transportRef);
        if (!transport.watch) return;
        await transport.watch(await credsFor(m), () => trigger(id), signal);
      } catch (err) {
        if (signal.aborted) return;
        // The first failure of a streak is worth a line; the retries after it are not.
        if (failures === 0) logger.warn({ mailboxId: id, err: (err as Error).message }, "watcher: mailbox connection failed, retrying");
      }
      if (e.connected && !signal.aborted) logger.warn({ mailboxId: id }, "watcher: mailbox connection dropped, reconnecting (the poll covers the gap)");
      e.connected = false;
      if (signal.aborted) return;
      failures = Date.now() - started > HEALTHY_MS ? 1 : failures + 1;
      await sleep(backoff(failures), signal);
    }
  }

  function start(id: string): void {
    const e: Entry = { abort: new AbortController(), connected: false, dirty: false, reading: false, timer: null, done: Promise.resolve() };
    entries.set(id, e);
    e.done = hold(id, e).finally(() => {
      if (entries.get(id) === e && !e.abort.signal.aborted) entries.delete(id);
    });
  }

  function drop(id: string): void {
    const e = entries.get(id);
    if (!e) return;
    e.abort.abort();
    if (e.timer) clearTimeout(e.timer);
    entries.delete(id);
  }

  async function refresh(): Promise<void> {
    if (stopped) return;
    const rows = await prisma.mailbox.findMany({
      where: { status: { in: [...WATCHED] }, credentialRef: { not: null } },
      select: { id: true, transportRef: true },
      orderBy: { createdAt: "asc" },
    });
    const canWatch = (ref: string) => {
      try {
        return !!transportFor(ref).watch;
      } catch {
        return false; // an unknown transport name is the poll's problem to report, not a reason to stop watching the rest
      }
    };
    const mine = rows.filter((r) => (shard.count === 1 || shardOf(r.id, shard.count) === shard.index) && canWatch(r.transportRef));
    if (mine.length > max && !overCapLogged) {
      overCapLogged = true;
      logger.warn({ mailboxes: mine.length, max }, "watcher: more mailboxes than MAILBOX_WATCH_MAX; the rest are read by the 2-minute poll. Add a watcher shard.");
    }
    const want = new Set(mine.slice(0, max).map((r) => r.id));
    for (const id of [...entries.keys()]) if (!want.has(id)) drop(id);
    for (const id of want) if (!entries.has(id)) start(id);
  }

  const first = refresh().catch((err) => logger.error({ err: (err as Error).message }, "watcher: could not list mailboxes"));
  const timer = setInterval(() => void refresh().catch((err) => logger.error({ err: (err as Error).message }, "watcher: could not list mailboxes")), opts.refreshMs ?? REFRESH_MS);
  timer.unref();
  void first.then(() => logger.info({ mailboxes: entries.size, shard: `${shard.index}/${shard.count}` }, "watcher: holding mailboxes in IDLE for instant replies"));

  return {
    refresh,
    status: () => ({ watching: entries.size, connected: [...entries.values()].filter((e) => e.connected).length, ...stats }),
    async stop() {
      stopped = true;
      clearInterval(timer);
      await first;
      const all = [...entries.values()];
      for (const id of [...entries.keys()]) drop(id);
      await Promise.race([Promise.allSettled(all.map((e) => e.done)), new Promise((r) => setTimeout(r, 5_000))]);
    },
  };
}
