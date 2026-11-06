import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { withLock } from "../src/lib/locks.js";

/** Without Redis a lock is a lease row: it never holds a database connection while the job runs. */

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM "JobLease"`;
});

describe("withLock without Redis", () => {
  it("runs a job once at a time and frees the lock when it ends, even when it throws", async () => {
    let release!: () => void;
    const first = withLock("job:a", 60_000, () => new Promise<string>((r) => (release = () => r("done"))));
    await new Promise((r) => setTimeout(r, 50));
    expect(await withLock("job:a", 60_000, async () => "twice")).toEqual({ ran: false });
    expect(await withLock("job:b", 60_000, async () => "other")).toEqual({ ran: true, result: "other" });
    release();
    expect(await first).toEqual({ ran: true, result: "done" });
    expect(await withLock("job:a", 60_000, async () => "again")).toEqual({ ran: true, result: "again" });
    await expect(withLock("job:a", 60_000, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withLock("job:a", 60_000, async () => "after a failure")).toEqual({ ran: true, result: "after a failure" });
  });

  it("takes over a lease left by a process that died", async () => {
    await prisma.$executeRaw`INSERT INTO "JobLease" ("name", "token", "expiresAt") VALUES ('job:dead', 'gone', now() - interval '1 second')`;
    expect(await withLock("job:dead", 60_000, async () => "ran")).toEqual({ ran: true, result: "ran" });
  });

  it("lets twenty jobs hold their locks at once with connections to spare", async () => {
    const gates: (() => void)[] = [];
    const running = Array.from({ length: 20 }, (_, i) => withLock(`job:many-${i}`, 60_000, () => new Promise<number>((r) => gates.push(() => r(i)))));
    for (let i = 0; gates.length < 20 && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
    expect(gates).toHaveLength(20);
    // The pool is still free for the jobs' own queries while every lock is held.
    expect(await prisma.contact.count()).toBeGreaterThanOrEqual(0);
    gates.forEach((g) => g());
    expect((await Promise.all(running)).every((r) => r.ran)).toBe(true);
  });
});
