import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb, transport, type TestTenant } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { secretStore } from "../src/integrations/secrets.js";
import { parseMailboxCsv } from "../src/domain/pool/csvImport.js";

async function admin(): Promise<TestTenant> {
  const a = await createTenant();
  await prisma.user.update({ where: { id: a.userId }, data: { isPlatformAdmin: true } });
  return a;
}

// The way a supplier's sheet usually looks once downloaded as CSV: its own header names and order, an app password
// in groups of four, and one account without a first name.
const SHEET = [
  "Domain,Email Address,First Name,Last Name,Password,App Password",
  "bytepath.com,Madison@bytepath.com,Madison,Reed,Acct-Pass-1,abcd efgh ijkl mnop",
  "bytepath.com,daniel@bytepath.com,Daniel,Cole,Acct-Pass-2,qrst uvwx yzab cdef",
  "lift-prism.org,sarah.khan@lift-prism.org,,,Only-Account-Pass,",
  "lift-prism.org,,,,nobody,",
  "lift-prism.org,daniel@bytepath.com,Daniel,Cole,dup,",
].join("\n");

describe("CSV of warmed mailboxes", () => {
  beforeEach(resetDb);

  it("reads any sheet layout, prefers the app password, and fills a missing name from the address", () => {
    const p = parseMailboxCsv(SHEET, "google");
    expect(p.columns).toMatchObject({ address: "Email Address", appPassword: "App Password", password: "Password", firstName: "First Name" });
    expect(p.rows.map((r) => [r.line, r.address, r.firstName, r.password, r.smtpHost, r.smtpPort, r.imapHost])).toEqual([
      [2, "madison@bytepath.com", "Madison", "abcdefghijklmnop", "smtp.gmail.com", 465, "imap.gmail.com"],
      [3, "daniel@bytepath.com", "Daniel", "qrstuvwxyzabcdef", "smtp.gmail.com", 465, "imap.gmail.com"],
      [4, "sarah.khan@lift-prism.org", "Sarah", "Only-Account-Pass", "smtp.gmail.com", 465, "imap.gmail.com"],
    ]);
    expect(p.problems).toEqual([
      { line: 5, address: null, message: "No email on this row" },
      { line: 6, address: "daniel@bytepath.com", message: "Listed twice in the file. The first row is used" },
    ]);
    expect(parseMailboxCsv("email,password\nalex@m.io,x", "microsoft").rows[0]).toMatchObject({ smtpHost: "smtp.office365.com", smtpPort: 587, imapHost: "outlook.office365.com" });
    expect(() => parseMailboxCsv("name,phone\nA,1", "google")).toThrow(/No email column/);
    expect(() => parseMailboxCsv("email,name\na@b.io,A", "google")).toThrow(/No password column/);
  });

  it("shows what it will add first, adds only on confirm, keeps passwords out of every reply, and is safe to upload twice", async () => {
    const a = await admin();
    const preview = await api().post("/api/v1/admin/domains/import").set(a.auth).send({ csv: SHEET }).expect(200);
    expect(preview.body.data).toMatchObject({ done: false, totals: { mailboxes: 3, toAdd: 3, domains: 2, newDomains: 2, skipped: 0, failed: 0 } });
    expect(await prisma.sendingDomain.count()).toBe(0);
    for (const secret of ["abcd", "Acct-Pass", "Only-Account-Pass"]) expect(JSON.stringify(preview.body)).not.toContain(secret);

    const res = await api().post("/api/v1/admin/domains/import").set(a.auth).send({ csv: SHEET, commit: true }).expect(200);
    expect(res.body.data).toMatchObject({ done: true, totals: { toAdd: 3, signedIn: 3 } });
    expect(JSON.stringify(res.body)).not.toContain("abcd");
    const domains = await prisma.sendingDomain.findMany({ orderBy: { name: "asc" }, include: { mailboxes: { orderBy: { address: "asc" } } } });
    expect(domains.map((d) => [d.name, d.prewarmed, d.organizationId, d.mailboxes.map((m) => m.address)])).toEqual([
      ["bytepath.com", true, null, ["daniel@bytepath.com", "madison@bytepath.com"]],
      ["lift-prism.org", true, null, ["sarah.khan@lift-prism.org"]],
    ]);
    const m = domains[0].mailboxes[1];
    expect(JSON.parse((await secretStore().get(m.credentialRef!))!)).toEqual({ u: "madison@bytepath.com", p: "abcdefghijklmnop" });
    expect(JSON.stringify(domains)).not.toContain("abcd");

    // The same file again adds nothing.
    const again = await api().post("/api/v1/admin/domains/import").set(a.auth).send({ csv: SHEET, commit: true }).expect(200);
    expect(again.body.data.totals).toMatchObject({ toAdd: 0, skipped: 3 });
    expect(await prisma.mailbox.count()).toBe(3);

    // A new row for a domain already in the pool joins that domain.
    const more = await api().post("/api/v1/admin/domains/import").set(a.auth).send({ csv: "email,app password\nhannah@lift-prism.org,wxyz wxyz wxyz wxyz", commit: true }).expect(200);
    expect(more.body.data.domains[0]).toMatchObject({ name: "lift-prism.org", exists: true, added: [{ address: "hannah@lift-prism.org", ok: true }] });
  });

  it("refuses a domain with more than 3 mailboxes, keeps the rest, and reports a mailbox that can't sign in", async () => {
    const a = await admin();
    transport.signInOk = false;
    const csv = ["email,password", "ava@four.io,p", "ben@four.io,p", "cara@four.io,p", "dina@four.io,p", "emma@ok.io,p"].join("\n");
    const res = await api().post("/api/v1/admin/domains/import").set(a.auth).send({ csv, commit: true }).expect(200);
    const [four, ok] = res.body.data.domains;
    expect(four).toMatchObject({ name: "four.io", error: expect.stringMatching(/at most 3/), add: [] });
    expect(ok).toMatchObject({ name: "ok.io", added: [{ address: "emma@ok.io", ok: false, error: expect.stringMatching(/535/) }] });
    expect(await prisma.sendingDomain.findMany({ select: { name: true } })).toEqual([{ name: "ok.io" }]);
    expect((await prisma.mailbox.findFirstOrThrow()).status).toBe("ERROR");
  });

  it("adds 2-Step Verification mailboxes for Google sign-in, with no password column and no password kept", async () => {
    const a = await admin();
    const csv = ["Sr no,First Name,Last Name,Email Address,Password", "1,Karim,Mansour,karim@getrankhouse.com,Account-Pass-1", "2,Ziad,Nasser,ziad@getrankhouse.com,Account-Pass-2"].join("\n");
    const res = await api().post("/api/v1/admin/domains/import").set(a.auth).send({ csv, auth: "google", commit: true }).expect(200);
    expect(res.body.data).toMatchObject({ auth: "google", done: true, totals: { toAdd: 2 } });
    const boxes = await prisma.mailbox.findMany({ orderBy: { address: "asc" } });
    expect(boxes.map((m) => [m.address, m.provider, m.smtpHost, m.imapHost])).toEqual([
      ["karim@getrankhouse.com", "google-workspace", "smtp.gmail.com", "imap.gmail.com"],
      ["ziad@getrankhouse.com", "google-workspace", "smtp.gmail.com", "imap.gmail.com"],
    ]);
    for (const m of boxes) expect((await secretStore().get(m.credentialRef!)) ?? "").not.toContain("Account-Pass");
    // Without a password column it still reads.
    expect(parseMailboxCsv("email,first name\nkarim@x.io,Karim", "google", "google").rows).toHaveLength(1);
    expect(() => parseMailboxCsv("email\nkarim@x.io", "microsoft", "google")).toThrow(/only for Google/);
  });

  it("is for platform admins only", async () => {
    const customer = await createTenant();
    await api().post("/api/v1/admin/domains/import").set(customer.auth).send({ csv: SHEET }).expect(403);
  });
});
