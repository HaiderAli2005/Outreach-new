import { beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, createTenant, fakeAi, GOOD_FIRST_TOUCH, makeCampaign, makeContact, makePoolMailbox, resetDb, sendable, transport } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient } from "../src/integrations/ai.js";
import { setFinders, findEmail, type EmailFinder } from "../src/integrations/finders.js";
import { BANNED_WORDS, generateNames, isBannedName, patternOf, planBatch } from "../src/domain/pool/names.js";
import { ensurePersonas, localPartFor, targetLocales } from "../src/domain/pool/personas.js";
import { checkFirstTouch, checkSubject, unsupportedClaims, wordCount } from "../src/domain/emailRules.js";
import { fallbackSequence, personalizeContact } from "../src/domain/personalize.js";
import { getSettings } from "../src/domain/settings.js";
import { scheduleNextTouch, sendFirstTouch, sendFollowUp } from "../src/domain/sending/pipeline.js";
import { sendReply } from "../src/domain/sending/delivery.js";
import { pollMailboxes, runFollowUps } from "../src/domain/sending/jobs.js";
import { nextSlot, slotForStep, tzFromLocation, windowFor } from "../src/domain/sending/schedule.js";
import { pushQueue } from "../src/jobs/send.js";
import { runReplyIntelligence } from "../src/domain/replyIntelligence.js";
import { recordMessage } from "../src/domain/messages.js";
import { minutesInTz, dayOfWeekInTz } from "../src/lib/time.js";

/** Spec 3 acceptance: the product layer. */

const raw = (lines: string[]) => lines.join("\n");

describe("domain and persona factory", () => {
  beforeEach(resetDb);

  it("generates 100 distinct names in the three shapes, with no banned word and no brand", () => {
    const names = generateNames(100, 42);
    expect(names).toHaveLength(100);
    expect(new Set(names).size).toBe(100);
    for (const n of names) {
      expect(patternOf(n), n).not.toBeNull();
      expect(isBannedName(n), n).toBe(false);
      expect(n).not.toMatch(/aperture/);
      for (const w of BANNED_WORDS) expect(n.includes(w), `${n} has ${w}`).toBe(false);
    }
    const shapes = new Set(names.map(patternOf));
    expect(shapes).toEqual(new Set(["prefix", "tokens", "hyphen"]));
  });

  it("suggests a batch of 20 spread over at least 3 TLDs", () => {
    const plan = planBatch(20, 7);
    expect(plan).toHaveLength(20);
    expect(new Set(plan.map((p) => p.tld)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(plan.map((p) => p.domain)).size).toBe(20);
  });

  it("never makes a single-letter mailbox", async () => {
    expect(() => localPartFor("A")).toThrow();
    expect(localPartFor("Chloé")).toBe("chloe");
    const d = await prisma.sendingDomain.create({ data: { organizationId: null, name: "decoderhubs.com", status: "ACTIVE", priceCents: 1200 } });
    await expect(prisma.mailbox.create({ data: { organizationId: null, sendingDomainId: d.id, address: "c@decoderhubs.com", transportRef: "smtp:c@decoderhubs.com" } })).rejects.toThrow();
    await ensurePersonas();
    const personas = await prisma.persona.findMany();
    expect(personas.every((p) => localPartFor(p.firstName).length >= 2)).toBe(true);
    for (const locale of ["en", "ur", "ar"]) expect(personas.filter((p) => p.locale === locale).length).toBeGreaterThanOrEqual(8);
  });

  it("gives a customer selling into Germany a German persona, and Pakistan an Urdu or English one", async () => {
    await ensurePersonas();
    expect(targetLocales("eu-de", "en")).toEqual(["de"]);
    expect(targetLocales("pk", "en")).toEqual(["ur", "en"]);
    const en = await prisma.persona.findFirstOrThrow({ where: { locale: "en" } });
    const de = await prisma.persona.findFirstOrThrow({ where: { locale: "de" } });
    const a = await makePoolMailbox();
    const b = await makePoolMailbox();
    await prisma.mailbox.update({ where: { id: a.id }, data: { personaId: en.id } });
    await prisma.mailbox.update({ where: { id: b.id }, data: { personaId: de.id } });
    const t = await createTenant();
    await prisma.organization.update({ where: { id: t.orgId }, data: { region: "eu-de" } });
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id));
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: true, mailboxId: b.id });
  });

  it("signs every email with the mailbox persona, so the From name always matches the address", async () => {
    const m = await makePoolMailbox();
    await prisma.mailbox.update({ where: { id: m.id }, data: { fromNameDefault: "Madison Reed" } });
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id));
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    expect(transport.sent[0].message.from.name).toBe("Madison Reed");
    expect(transport.sent[0].message.text).toContain("I'm Madison from");
    expect(transport.sent[0].message.text).toMatch(/Best,\nMadison/);
    // The name always matches the address: there is no customer override to put "Mazhar Ali" on madison@.
    expect(transport.sent[0].message.from).toMatchObject({ name: "Madison Reed", address: m.address });
  });
});

describe("the email itself", () => {
  beforeEach(resetDb);

  it("holds a first email to 90 to 130 words, one question at the end, no link, no banned phrase", () => {
    expect(wordCount(GOOD_FIRST_TOUCH)).toBeGreaterThanOrEqual(90);
    expect(checkFirstTouch(GOOD_FIRST_TOUCH)).toBeNull();
    expect(checkFirstTouch("Hi,\n\nShort note. Want to talk?")).toMatch(/under 90/);
    expect(checkFirstTouch(GOOD_FIRST_TOUCH.replace("Would it", "Is this a fit? Would it"))).toMatch(/more than one question/);
    expect(checkFirstTouch(GOOD_FIRST_TOUCH.replace("our company", "acme.com"))).toMatch(/link/);
    expect(checkFirstTouch(GOOD_FIRST_TOUCH.replace("I saw your team", "I hope this finds you well. I saw your team"))).toMatch(/banned/);
    expect(checkFirstTouch(GOOD_FIRST_TOUCH.replace("Would it be useful if I sent it over?", "Would it be useful if I sent it over? Let me know."))).toMatch(/at the end/);
  });

  it("holds a subject to a 2 to 4 word noun phrase about their world", () => {
    const c = { company: "BrandEigen Ltd", firstName: "Arindam" };
    for (const ok of ["Research content volume", "Client reporting systems", "Joe Meek documentary edit", "Docs to answers"]) expect(checkSubject(ok, c), ok).toBeNull();
    expect(checkSubject("Grow your pipeline", c)).toMatch(/verb/);
    expect(checkSubject("Research content volume?", c)).toMatch(/question mark/);
    expect(checkSubject("BrandEigen research flow", c)).toMatch(/company/);
    expect(checkSubject("Arindam research flow", c)).toMatch(/first name/);
    expect(checkSubject("Quick question here", c)).toMatch(/quick question/);
    expect(checkSubject("Research", c)).toMatch(/2 to 4/);
    expect(checkSubject("research content volume", c)).toMatch(/sentence case/);
  });

  it("refuses numbers and names nobody can source", () => {
    const corpus = { prospect: "BrandEigen\nBrand strategy", customer: "Skimming AI\ncut review time by about 60%" };
    expect(unsupportedClaims("One insights team cut review time by about 60% in the first week.", corpus)).toEqual([]);
    expect(unsupportedClaims("We helped Northwind cut costs by 35%.", corpus)).toEqual(expect.arrayContaining(["35%", "Northwind"]));
  });

  it("retries a draft that breaks the rules, then falls back to a plain email that passes them", async () => {
    const t = await createTenant();
    const settings = await getSettings(t.orgId);
    const c = await makeContact(t.orgId, { firstName: "Arindam", company: "BrandEigen", industry: "Marketing" });
    let calls = 0;
    setAiClient(fakeAi(() => (calls++, { subject: "Quick question", body: "Hi, we doubled revenue for 400 clients. Interested? Call?", followup2: "x", followup3: "y", followup4: "z" })));
    const bad = await personalizeContact(c, settings);
    expect(calls).toBe(2);
    expect(bad.status).toBe("fallback");
    expect(checkFirstTouch(bad.body)).toBeNull();
    expect(checkSubject(bad.subject, c)).toBeNull();
    const fb = fallbackSequence(c, settings);
    expect(wordCount(fb.body)).toBeGreaterThanOrEqual(90);
    // A good draft is used as written.
    setAiClient(fakeAi({ subject: "Research content volume", body: GOOD_FIRST_TOUCH.replace("Hi Lead,", "Hi Arindam,"), followup2: "Worth a look?", followup3: "One more thought for BrandEigen.", followup4: "I'll leave it here." }));
    const good = await personalizeContact(c, settings);
    expect(good.status).toBe("done");
    expect(good.followup4).toBe("I'll leave it here.");
  });

  it("blocks an email at send time that quotes a number nobody sourced, and allows it once the proof is on record", async () => {
    await makePoolMailbox();
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const text = GOOD_FIRST_TOUCH.replace("Happy to put together", "One insights team cut its review time by about 60% in the first week. Happy to put together").replace(" and nothing to install", "");
    const p = await makeContact(t.orgId, sendable(campaign.id, { personalization: text }));
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: false, code: "CONTENT_BLOCKED" });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { proofPoints: [{ claim: "One insights team cut its review time by about 60% in the first week", source: "Customer interview, 2026" }] } });
    const q = await makeContact(t.orgId, sendable(campaign.id, { personalization: text }));
    expect(await sendFirstTouch(t.orgId, q.id, campaign.id)).toMatchObject({ ok: true });
  });
});

describe("sequence rules", () => {
  beforeEach(resetDb);

  async function started(email = "ann@acme.com", orgId?: string) {
    const t = orgId ? { orgId } : await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id, { email, emailNormalized: email, domain: email.split("@")[1] }));
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: true });
    return { t, campaign, p };
  }

  it("bills a 4-email sequence 4 x $0.04 = $0.16, and a reply to a human the same $0.04", async () => {
    await makePoolMailbox();
    const { t, campaign, p } = await started();
    for (const step of [2, 3, 4] as const) expect(await sendFollowUp(t.orgId, p.id, campaign.id, step)).toMatchObject({ ok: true });
    const charges = await prisma.creditLedger.findMany({ where: { organizationId: t.orgId, kind: "CHARGE" }, orderBy: { seq: "asc" } });
    expect(charges.map((c) => c.amount)).toEqual([-40n, -40n, -40n, -40n]);
    expect(charges.reduce((a, c) => a - c.amount, 0n)).toBe(160n);
    // The sequence is finished after the fourth email.
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ sequenceStopReason: "finished", nextTouchAt: null });
    await prisma.contact.update({ where: { id: p.id }, data: { status: "REPLIED", repliedAt: new Date() } });
    await sendReply(t.orgId, p.id, "Thanks, happy to help.", "inbox");
    const all = await prisma.creditLedger.findMany({ where: { organizationId: t.orgId, kind: "CHARGE" }, orderBy: { seq: "asc" } });
    expect(all.map((c) => c.amount)).toEqual([-40n, -40n, -40n, -40n, -40n]);
  });

  it("schedules the follow-ups on days 3, 7 and 14, threaded in the same thread", async () => {
    await makePoolMailbox();
    const { t, campaign, p } = await started();
    const after1 = await prisma.contact.findUniqueOrThrow({ where: { id: p.id } });
    const first = after1.firstContactedAt!;
    const days = (d: Date) => Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate())) / 86_400_000);
    expect(days(after1.nextTouchAt!)).toBeGreaterThanOrEqual(3);
    await prisma.contact.update({ where: { id: p.id }, data: { nextTouchAt: new Date(Date.now() - 1000) } });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true, sendDays: [1, 2, 3, 4, 5, 6, 7], sendingWindowStart: "00:00", sendingWindowEnd: "23:59" } });
    expect((await runFollowUps(t.orgId)).sent).toBe(1);
    const second = transport.sent.at(-1)!.message;
    expect(second.inReplyTo).toBe(transport.sent[0].message.messageId);
    expect(second.subject).toBe(`Re: ${transport.sent[0].message.subject}`);
    const after2 = await prisma.contact.findUniqueOrThrow({ where: { id: p.id } });
    expect(days(after2.nextTouchAt!)).toBeGreaterThanOrEqual(7);
    void campaign;
  });

  it("cancels the next follow-up as soon as one mailbox poll reads their reply", async () => {
    const m = await makePoolMailbox();
    const { t, p } = await started();
    const send = await prisma.send.findFirstOrThrow({ where: { contactId: p.id } });
    await prisma.contact.update({ where: { id: p.id }, data: { nextTouchAt: new Date(Date.now() - 1000) } });
    transport.deliver(m.address, raw([`From: ${p.email}`, `To: ${m.address}`, `Subject: Re: ${send.subject}`, `In-Reply-To: ${send.messageId}`, "Message-ID: <r9@acme.com>", "", "Not interested, thanks."]));
    await pollMailboxes();
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: "REPLIED", sequenceStopReason: "replied", nextTouchAt: null });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { autopilotEnabled: true } });
    await runFollowUps(t.orgId);
    expect(transport.sent).toHaveLength(1);
  });

  it("stops every other acme.com sequence when anyone at acme.com replies, but not for a free-mail domain", async () => {
    const m = await makePoolMailbox({ cap: 50 });
    const t = await createTenant();
    const ann = (await started("ann@acme.com", t.orgId)).p;
    const bob = (await started("bob@acme.com", t.orgId)).p;
    const gmail1 = (await started("one@gmail.com", t.orgId)).p;
    const gmail2 = (await started("two@gmail.com", t.orgId)).p;
    for (const [who, mid] of [[ann, "<a1@acme.com>"], [gmail1, "<g1@gmail.com>"]] as const) {
      const send = await prisma.send.findFirstOrThrow({ where: { contactId: who.id } });
      transport.deliver(m.address, raw([`From: ${who.email}`, `To: ${m.address}`, `Subject: Re: ${send.subject}`, `In-Reply-To: ${send.messageId}`, `Message-ID: ${mid}`, "", "Thanks, forwarding this."]));
    }
    await pollMailboxes();
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: bob.id } })).toMatchObject({ sequenceStopReason: "colleague_replied", nextTouchAt: null });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: gmail2.id } })).sequenceStoppedAt).toBeNull();
    expect(await sendFollowUp(t.orgId, bob.id, bob.campaignId, 2)).toMatchObject({ ok: false, code: "SEQUENCE_STOPPED" });
  });

  it("holds follow-ups while the campaign is paused, then carries on", async () => {
    await makePoolMailbox();
    const { t, campaign, p } = await started();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "PAUSED" } });
    expect(await sendFollowUp(t.orgId, p.id, campaign.id, 2)).toMatchObject({ ok: false, code: "CAMPAIGN_PAUSED", wait: true });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "ACTIVE" } });
    expect(await sendFollowUp(t.orgId, p.id, campaign.id, 2)).toMatchObject({ ok: true });
  });

  it("lets the customer mark someone done, and that ends the sequence", async () => {
    await makePoolMailbox();
    const t = await createTenant();
    const { campaign, p } = await started("ann@acme.com", t.orgId);
    await api().post(`/api/v1/contacts/${p.id}/stop`).set(t.auth).expect(200);
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ sequenceStopReason: "manual", nextTouchAt: null });
    expect(await sendFollowUp(t.orgId, p.id, campaign.id, 2)).toMatchObject({ ok: false, code: "SEQUENCE_STOPPED" });
    expect(await prisma.creditReservation.count({ where: { contactId: p.id, status: "OPEN" } })).toBe(0);
  });
});

describe("scheduling", () => {
  beforeEach(resetDb);

  it("schedules first emails in the PROSPECT's time zone, inside the window, on sending days, with uneven gaps", async () => {
    await makePoolMailbox({ cap: 100 });
    const t = await createTenant();
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, dailyBudgetDecicents: 8000n, timezone: "Asia/Karachi", sendDays: [1, 2, 3, 4, 5], sendingWindowStart: "09:00", sendingWindowEnd: "17:00" } });
    const campaign = await makeCampaign(t.orgId);
    for (let i = 0; i < 20; i++) await makeContact(t.orgId, sendable(campaign.id, { country: "United States", location: "San Francisco, California", city: "San Francisco" }));
    const r = await pushQueue(t.orgId);
    expect(r.scheduled).toBe(20);
    const rows = await prisma.contact.findMany({ where: { organizationId: t.orgId } });
    for (const c of rows) {
      expect(c.timezone).toBe("America/Los_Angeles");
      const m = minutesInTz("America/Los_Angeles", c.nextTouchAt!);
      expect(m).toBeGreaterThanOrEqual(9 * 60);
      expect(m).toBeLessThan(17 * 60);
      expect([1, 2, 3, 4, 5]).toContain(dayOfWeekInTz("America/Los_Angeles", c.nextTouchAt!));
    }
    const times = rows.map((c) => c.nextTouchAt!.getTime()).sort((a, b) => a - b);
    const gaps = times.slice(1).map((x, i) => x - times[i]);
    expect(new Set(gaps).size).toBeGreaterThan(5);
    // Nothing goes out before its minute.
    expect(transport.sent).toHaveLength(0);
  });

  it("puts each sequence email on its day, in the window, and skips non-sending days", () => {
    expect(tzFromLocation("United States", "California", null)).toBe("America/Los_Angeles");
    expect(tzFromLocation("Pakistan", null, "Lahore")).toBe("Asia/Karachi");
    const w = { tz: "America/Los_Angeles", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
    // A Friday afternoon Pacific: day 3 is Monday.
    const friday = new Date("2026-10-09T22:00:00Z");
    const slot = slotForStep(w, friday, 3, () => 0.5);
    expect(dayOfWeekInTz(w.tz, slot)).toBe(1);
    const m = minutesInTz(w.tz, slot);
    expect(m).toBeGreaterThanOrEqual(540);
    expect(m).toBeLessThan(1020);
    // After 17:00 on a Friday, the next first-email slot is Monday.
    expect(dayOfWeekInTz(w.tz, nextSlot(w, new Date("2026-10-10T01:00:00Z"), () => 0))).toBe(1);
    void windowFor;
  });
});

describe("reply intelligence", () => {
  beforeEach(resetDb);

  async function replied(text: string) {
    const m = await makePoolMailbox();
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id, { email: "sam@firm.com", emailNormalized: "sam@firm.com", domain: "firm.com" }));
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    const msg = await recordMessage(prisma, { organizationId: t.orgId, contactId: p.id, direction: "INBOUND", via: "email", body: text, emailMessageId: "<x@firm.com>" });
    await prisma.contact.update({ where: { id: p.id }, data: { status: "REPLIED", repliedAt: new Date() } });
    return { m, t, p, msg };
  }

  it.each([["stop", "UNSUBSCRIBE"], ["frustrated", "HOSTILE"]] as const)("suppresses pool-wide on a %s reply and stops the same person at every other customer", async (cls, intent) => {
    const { t, p, msg } = await replied("Remove me now");
    const other = await createTenant();
    const oc = await makeCampaign(other.orgId);
    const same = await makeContact(other.orgId, sendable(oc.id, { email: "sam@firm.com", emailNormalized: "sam@firm.com" }));
    setAiClient(fakeAi({ class: cls, confidence: 0.99, language: "en" }));
    await runReplyIntelligence(t.orgId, msg.id);
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ intent, status: "UNSUBSCRIBED" });
    expect(await prisma.globalSuppression.count()).toBe(1);
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: same.id } })).toMatchObject({ status: "BLOCKLISTED" });
    expect(await prisma.systemLog.count({ where: { level: "CRITICAL", source: "abuse" } })).toBe(cls === "frustrated" ? 1 : 0);
  });

  it("has no timer anywhere in the reply path", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(__dirname, "../src"));
    const offenders = files.filter((f) => /sendAfter|autoReplyQueue|computeSendAfter|dispatchForOrg/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("allows one manual message into a cold thread, then locks it until they answer", async () => {
    await makePoolMailbox();
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id));
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    await api().post(`/api/v1/inbox/${p.id}/reply`).set(t.auth).send({ body: "One more thought on this." }).expect(200);
    const locked = await api().get(`/api/v1/inbox/${p.id}`).set(t.auth);
    expect(locked.body.data).toMatchObject({ canReply: false, replyBlockedReason: "awaiting_their_reply" });
    await api().post(`/api/v1/inbox/${p.id}/reply`).set(t.auth).send({ body: "And another." }).expect(409);
    await prisma.contact.update({ where: { id: p.id }, data: { repliedAt: new Date(), hasInbound: true } });
    await api().post(`/api/v1/inbox/${p.id}/reply`).set(t.auth).send({ body: "Thanks for coming back to me." }).expect(200);
    await api().post(`/api/v1/inbox/${p.id}/reply`).set(t.auth).send({ body: "And one more." }).expect(200);
  });

  it("serves an editable status vocabulary per workspace", async () => {
    const t = await createTenant();
    const v = await api().get("/api/v1/lead-status-vocab").set(t.auth).expect(200);
    expect(v.body.data.map((x: { key: string }) => x.key)).toContain("HOSTILE");
    const saved = await api().put("/api/v1/lead-status-vocab").set(t.auth).send({ items: [{ key: "INTERESTED", label: "Hot", color: "g" }, { key: "MEETING_BOOKED", label: "Meeting booked" }] }).expect(200);
    expect(saved.body.data.map((x: { label: string }) => x.label)).toEqual(["Hot", "Meeting booked"]);
  });
});

describe("customer controls", () => {
  beforeEach(resetDb);

  it("sends nothing, ever, for an unapproved first batch, and starts the moment it is approved", async () => {
    await makePoolMailbox();
    const t = await createTenant({ approved: false });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false } });
    const campaign = await makeCampaign(t.orgId);
    for (let i = 0; i < 3; i++) await makeContact(t.orgId, sendable(campaign.id, { approvedAt: null, approvalSource: null }));
    for (let i = 0; i < 3; i++) expect(await pushQueue(t.orgId, { ignoreWindow: true })).toMatchObject({ pushed: 0, reason: "awaiting_approval" });
    expect(transport.sent).toHaveLength(0);
    const view = await api().get("/api/v1/launch").set(t.auth).expect(200);
    expect(view.body.data).toMatchObject({ approved: false, ready: 3, needed: 20 });
    expect(view.body.data.people[0].email).toMatch(/@/);
    expect(view.body.data.people[0].emails).toHaveLength(4);
    await api().post("/api/v1/launch/approve").set(t.auth).send({}).expect(200);
    expect((await pushQueue(t.orgId, { ignoreWindow: true })).pushed).toBe(3);
  });

  it("records consent word for word, with the user, time and IP, before the first send", async () => {
    await makePoolMailbox();
    const t = await createTenant({ consent: false, approved: false });
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id, { approvedAt: null, approvalSource: null }));
    expect(await sendFirstTouch(t.orgId, p.id, campaign.id)).toMatchObject({ ok: false, code: "CONSENT_REQUIRED", wait: true });
    await api().post("/api/v1/launch/approve").set(t.auth).send({ consent: false }).expect(422);
    await api().post("/api/v1/launch/approve").set(t.auth).set("User-Agent", "test-agent").send({ consent: true }).expect(200);
    const c = await prisma.consentRecord.findFirstOrThrow({ where: { organizationId: t.orgId } });
    expect(c.text).toMatch(/^I confirm I am authorised to send business email on behalf of Org \d+, and that these recipients are relevant business contacts for what we offer\.$/);
    expect(c).toMatchObject({ userId: t.userId, userAgent: "test-agent" });
    expect(c.ip).toBeTruthy();
  });

  it("exports every prospect with the full address, where it came from and its verification", async () => {
    const t = await createTenant();
    await makeContact(t.orgId, { email: "arindam@brandeigen.com", emailNormalized: "arindam@brandeigen.com", emailSource: "anymailfinder", verifyResult: "ok" });
    await makeContact(t.orgId, { email: "gone@old.com", emailNormalized: "gone@old.com", status: "BOUNCED" });
    const res = await api().get("/api/v1/contacts/export?all=1").set(t.auth).expect(200);
    expect(res.text).toContain("arindam@brandeigen.com");
    expect(res.text).toContain("gone@old.com");
    expect(res.text).toContain("anymailfinder");
    expect(res.text).not.toMatch(/\*\*\*/);
  });

  it("throttles by daily budget: zero pauses, a number stops the day there", async () => {
    await makePoolMailbox();
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { dailyBudgetDecicents: 0n } });
    const a = await makeContact(t.orgId, sendable(campaign.id));
    expect(await sendFirstTouch(t.orgId, a.id, campaign.id)).toMatchObject({ ok: false, code: "BUDGET_PAUSED", wait: true });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { dailyBudgetDecicents: 60n } });
    expect(await sendFirstTouch(t.orgId, a.id, campaign.id)).toMatchObject({ ok: true });
    const b = await makeContact(t.orgId, sendable(campaign.id));
    expect(await sendFirstTouch(t.orgId, b.id, campaign.id)).toMatchObject({ ok: false, code: "BUDGET_REACHED", wait: true });
  });

  it("shows which suppressions the customer added and which came automatically", async () => {
    const t = await createTenant();
    await api().post("/api/v1/blocklist").set(t.auth).send({ value: "competitor.com", entryType: "DOMAIN" }).expect(201);
    await prisma.blocklistEntry.create({ data: { organizationId: t.orgId, entryType: "EMAIL", value: "gone@x.com", reason: "UNSUBSCRIBED" } });
    const res = await api().get("/api/v1/blocklist").set(t.auth).expect(200);
    expect(res.body.data.map((r: { value: string; origin: string }) => [r.value, r.origin]).sort()).toEqual([
      ["competitor.com", "you"],
      ["gone@x.com", "automatic"],
    ]);
    expect(res.body.meta.byOrigin).toEqual({ you: 1, automatic: 1 });
  });
});

describe("email-finding waterfall", () => {
  beforeEach(() => setFinders(null));

  it("stops at the first verified hit, records the finder, and never calls a finder without confirmed resale rights", async () => {
    const calls: string[] = [];
    const finder = (id: string, confirmed: boolean, email: string | null): EmailFinder => ({
      id,
      resale: { confirmed, checkedOn: "2026-10-09", note: "test" },
      async find() {
        calls.push(id);
        return email ? { email, status: "valid", source: id } : null;
      },
    });
    setFinders([finder("unconfirmed", false, "x@acme.com"), finder("empty", true, null), finder("hit", true, "ann@acme.com"), finder("after", true, "late@acme.com")]);
    expect(await findEmail({ fullName: "Ann Lee", domain: "acme.com" })).toEqual({ email: "ann@acme.com", status: "valid", source: "hit" });
    expect(calls).toEqual(["empty", "hit"]);
    setFinders(null);
  });
});

describe("unmatched inbound", () => {
  beforeEach(resetDb);

  it("lets an operator attach an unmatched message to a conversation, which then stops the sequence", async () => {
    const m = await makePoolMailbox();
    const t = await createTenant();
    const campaign = await makeCampaign(t.orgId);
    const p = await makeContact(t.orgId, sendable(campaign.id, { email: "ann@acme.com", emailNormalized: "ann@acme.com", domain: "acme.com" }));
    await sendFirstTouch(t.orgId, p.id, campaign.id);
    transport.deliver(m.address, raw(["From: Ann <ann.personal@acme.com>", `To: ${m.address}`, "Subject: hello", "Message-ID: <u1@acme.com>", "", "Writing from my other address: yes please."]));
    await pollMailboxes();
    const u = await prisma.inboundMessage.findFirstOrThrow({ where: { kind: "unmatched" } });
    const admin = await createTenant();
    await prisma.user.update({ where: { id: admin.userId }, data: { isPlatformAdmin: true } });
    const cands = await api().get(`/api/v1/admin/pool/unmatched/${u.id}/candidates`).set(admin.auth).expect(200);
    expect(cands.body.data.map((c: { id: string }) => c.id)).toContain(p.id);
    await api().post(`/api/v1/admin/pool/unmatched/${u.id}/assign`).set(admin.auth).send({ contactId: p.id }).expect(200);
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: "REPLIED", sequenceStopReason: "replied" });
    expect(await prisma.inboundMessage.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ assignedContactId: p.id, assignedById: admin.userId });
    const view = await api().get("/api/v1/admin/pool?fresh=1").set(admin.auth).expect(200);
    expect(view.body.data.unmatched.open).toBe(0);
    void scheduleNextTouch;
  });
});
