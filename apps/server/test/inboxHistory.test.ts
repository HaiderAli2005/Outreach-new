import { beforeEach, describe, expect, it } from "vitest";
import { makePoolMailbox, resetDb, transport } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { pollMailbox } from "../src/domain/sending/jobs.js";
import { archiveMailboxHistory } from "../src/domain/sending/inbound.js";
import { detectFootprint, mailHostProvider, nameserverProvider, setNsResolver, setRegistrarLookup } from "../src/domain/pool/auth.js";
import { setTransport, transportFor } from "../src/domain/sending/transport/index.js";

const DAY = 86_400_000;
const mail = (to: string, date: Date, subject = "Welcome to your new inbox") =>
  [`From: Someone <someone@elsewhere.com>`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${Math.random()}@elsewhere.com>`, `Date: ${date.toUTCString()}`, "", "Hello."].join("\n");

describe("a mailbox's old mail", () => {
  beforeEach(resetDb);

  it("files mail written before the mailbox joined as history, and keeps real new mail in the queue", async () => {
    const m = await makePoolMailbox();
    transport.deliver(m.address, mail(m.address, new Date(Date.now() - 20 * DAY), "Agency warmup 1"));
    transport.deliver(m.address, mail(m.address, new Date(Date.now() - 3 * DAY), "Agency warmup 2"));
    transport.deliver(m.address, mail(m.address, new Date(), "Something new"));
    await pollMailbox(await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } }));
    const rows = await prisma.inboundMessage.findMany({ orderBy: { imapUid: "asc" }, select: { subject: true, kind: true, handledAt: true } });
    expect(rows.map((r) => [r.subject, r.kind, !!r.handledAt])).toEqual([
      ["Agency warmup 1", "history", true],
      ["Agency warmup 2", "history", true],
      ["Something new", "unmatched", false],
    ]);
  });

  it("starts reading a new mailbox where it joined, not from its first email ever", async () => {
    const m = await makePoolMailbox();
    let readFrom = -1;
    const real = transportFor(m.transportRef);
    setTransport({ id: "fake", send: real.send.bind(real), verify: real.verify.bind(real), startUid: async () => 527, fetchNew: async (_c, since = 0) => ((readFrom = since), []) });
    await pollMailbox(await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } }));
    expect(readFrom).toBe(527);
    expect(Number((await prisma.mailbox.findUniqueOrThrow({ where: { id: m.id } })).lastImapUid)).toBe(527);
  });

  it("clears old mail that was already in the unmatched queue", async () => {
    const m = await makePoolMailbox();
    const old = new Date(Date.now() - 10 * DAY).toUTCString();
    await prisma.inboundMessage.createMany({
      data: [
        { mailboxId: m.id, imapUid: 1n, kind: "unmatched", fromEmail: "a@x.com", rawHeaders: `From: a@x.com\r\nDate: ${old}\r\nSubject: old` },
        { mailboxId: m.id, imapUid: 2n, kind: "unmatched", fromEmail: "b@x.com", rawHeaders: `From: b@x.com\r\nDate: ${new Date().toUTCString()}\r\nSubject: new` },
        { mailboxId: m.id, imapUid: 3n, kind: "unmatched", fromEmail: "c@x.com", rawHeaders: "From: c@x.com" },
      ],
    });
    expect(await archiveMailboxHistory()).toBe(1);
    expect(await prisma.inboundMessage.count({ where: { kind: "unmatched", handledAt: null } })).toBe(2);
    expect(await archiveMailboxHistory()).toBe(0);
  });
});

describe("footprint detection", () => {
  beforeEach(resetDb);

  it("names the DNS provider and the sending servers, and finds the registrar only when nobody typed one", async () => {
    expect(nameserverProvider(["kate.ns.cloudflare.com.", "rob.ns.cloudflare.com."])).toBe("Cloudflare");
    expect(nameserverProvider(["dns1.registrar-servers.com"])).toBe("Namecheap");
    expect(nameserverProvider(["ns1.example-dns.net"])).toBe("example-dns.net");
    expect(nameserverProvider([])).toBeNull();
    expect(mailHostProvider("smtp.gmail.com")).toBe("Google");
    expect(mailHostProvider("smtp.office365.com")).toBe("Microsoft");
    expect(mailHostProvider("mail.privatesmtp.io")).toBe("privatesmtp.io");

    const m = await makePoolMailbox();
    await prisma.mailbox.update({ where: { id: m.id }, data: { smtpHost: "smtp.gmail.com" } });
    setNsResolver(async () => ["ns1.dns-parking.com"]);
    setRegistrarLookup(async () => "NameCheap, Inc.");
    await detectFootprint(m.sendingDomainId!);
    expect(await prisma.sendingDomain.findUniqueOrThrow({ where: { id: m.sendingDomainId! } })).toMatchObject({ registrar: "NameCheap, Inc.", nameserverSet: "Hostinger", ipPoolId: "Google" });

    await prisma.sendingDomain.update({ where: { id: m.sendingDomainId! }, data: { registrar: "Porkbun" } });
    setRegistrarLookup(async () => "Somebody Else");
    await detectFootprint(m.sendingDomainId!);
    expect((await prisma.sendingDomain.findUniqueOrThrow({ where: { id: m.sendingDomainId! } })).registrar).toBe("Porkbun");
  });
});
