import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, fakeAi, makeCampaign, makeContact, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient } from "../src/integrations/ai.js";
import { personalizeContact } from "../src/domain/personalize.js";
import { getSettings } from "../src/domain/settings.js";

const FIRST = `Hi {{first_name}},

Teams like {{company}} tend to spend Friday afternoons stitching client numbers together from five different tools. By the time the report goes out, the numbers are already a week old and nobody trusts them.

I'm {{sender_first_name}} from Northwind. We pull every client's numbers into one weekly report that writes itself, so the account team spends that afternoon on the clients instead of the spreadsheet.

Agencies using it cut their reporting time by more than half in the first month. Happy to build a short sample report for {{company}} from public data, with no obligation either way.

Would a sample for one of your clients be useful?`;

const seq = (first = FIRST, subject = "Client reporting time") => ({
  touches: [
    { subject, body: first },
    { subject: null, body: "Hi {{first_name}},\n\nA different angle: most teams lose the hours in chasing data, not writing. Is that true for {{company}}?" },
    { subject: null, body: "Hi {{first_name}},\n\nOne smaller idea: I can send a one-page outline of how the report would look for {{company}}." },
    { subject: null, body: "Hi {{first_name}},\n\nI'll leave it here. If reporting becomes a priority later, just reply and I'll pick it up." },
  ],
});

const group = (id: string, name: string, on = true) => ({
  id, priority: 1, name, description: `${name} buyers`, why: "", goals: [], pains: ["slow reporting"], objections: [], titles: ["Head of Operations"],
  includeSimilarTitles: true, seniorities: [], sizes: ["11,50"], regions: ["United Kingdom"], keywords: ["marketing agency"], keywordSuggestions: [],
  revenueRange: { min: null, max: null }, technologies: [], signals: { hiringForTitles: [], headcountGrowthPctMin: null, recentlyFunded: false },
  lookalikeDomains: [], excludeDomains: [], on,
});

async function launchedTenant() {
  const t = await createTenant();
  await prisma.onboarding.create({
    data: {
      organizationId: t.orgId, domain: "northwind.io", brand: "Northwind", icp: {}, launchedAt: new Date(), analyzedAt: new Date(),
      facts: [{ key: "sell", value: "Automated client reporting for agencies" }, { key: "who", value: "Operations leads at marketing agencies" }, { key: "where", value: "United Kingdom" }],
      groups: [group("g1", "Agency ops"), group("g2", "Agency founders")],
      analysis: { brandDetail: { evidence: [{ claim: "Used by 40 agencies", source: "https://northwind.io/customers" }] } },
      preview: [
        { tab: "Intro", day: "Day 0", subject: "Client reporting time", body: FIRST.split("{{sender_first_name}}").join("Maya"), sender: "Maya" },
        { tab: "Follow up", day: "Day 3", subject: "Re: Client reporting time", body: seq().touches[1].body },
        { tab: "Another angle", day: "Day 7", subject: "Re: Client reporting time", body: seq().touches[2].body },
        { tab: "Last note", day: "Day 14", subject: "Re: Client reporting time", body: seq().touches[3].body },
      ],
    },
  });
  const campaign = await makeCampaign(t.orgId);
  await prisma.campaign.update({ where: { id: campaign.id }, data: { audiences: [{ id: "g1", name: "Agency ops", filters: {}, page: 4, saturatedAt: null }, { id: "g2", name: "Agency founders", filters: {}, page: 2, saturatedAt: null }] } });
  return { ...t, campaignId: campaign.id };
}

describe("Setup", () => {
  beforeEach(resetDb);

  it("Business profile starts from the analysis, saves as the one record, and the writer reads it", async () => {
    const t = await launchedTenant();
    const view = (await api().get("/api/v1/setup/profile").set(t.auth).expect(200)).body.data;
    expect(view).toMatchObject({ sell: "Automated client reporting for agencies", who: "Operations leads at marketing agencies", where: "United Kingdom" });
    expect(view.proofPoints).toEqual([{ claim: "Used by 40 agencies", source: "https://northwind.io/customers" }]);
    await api().put("/api/v1/setup/profile").set(t.auth).send({ ...view, sell: "" }).expect(422);
    const body = { company: "Northwind", sell: "Weekly client reports that write themselves", who: "Heads of operations at agencies with 10 to 50 staff", where: "UK and Ireland", offerings: ["Weekly client report"], differentiators: ["No setup"], tone: "Plain, dry, no hype", proofPoints: view.proofPoints };
    const saved = (await api().put("/api/v1/setup/profile").set(t.auth).send(body).expect(200)).body.data;
    expect(saved).toMatchObject({ sell: body.sell, tone: body.tone, who: body.who });
    expect((await getSettings(t.orgId)).valueProp).toBe(body.sell);

    let prompt = "";
    setAiClient(fakeAi((p) => ((prompt = p), null)));
    const contact = await makeContact(t.orgId, { campaignId: t.campaignId });
    await personalizeContact(contact, await getSettings(t.orgId), { sequence: seq().touches.map((x, i) => ({ step: i + 1, day: [0, 3, 7, 14][i], ...x })) });
    expect(prompt).toContain("Weekly client reports that write themselves");
    expect(prompt).toContain("HOW WE SOUND: Plain, dry, no hype");
    expect(prompt).toContain("WHO WE SELL TO: Heads of operations at agencies with 10 to 50 staff");
    expect(prompt).toContain("THE APPROVED SEQUENCE");
  });

  it("Email sequence shows the setup sequence, enforces the template rules on save, and keeps it for the writer", async () => {
    const t = await launchedTenant();
    const view = (await api().get("/api/v1/setup/sequence").set(t.auth).expect(200)).body.data;
    expect(view.touches.map((x: { day: number }) => x.day)).toEqual([0, 3, 7, 14]);
    expect(view.touches[0].body).toContain("I'm {{sender_first_name}} from Northwind");
    expect(view.touches[1].subject).toBeNull();

    const bad = async (payload: object, match: RegExp) => {
      const r = await api().put("/api/v1/setup/sequence").set(t.auth).send(payload).expect(422);
      expect(r.body.error.details.errors.map((e: { message: string }) => e.message).join(" | ")).toMatch(match);
    };
    await bad(seq(FIRST, "Grow your agency"), /verb/);
    await bad(seq(FIRST, "Reports"), /2 to 4/);
    await bad(seq(FIRST.replace("Would a sample for one of your clients be useful?", "Would a sample help? Or not?")), /More than one question/);
    await bad(seq(FIRST.replace(/\n\nAgencies using it/, " Agencies using it")), /3 paragraphs; it needs 4/);
    await bad(seq("Hi {{first_name}},\n\nShort.\n\nToo short.\n\nStill short.\n\nIs it?"), /under 90/);

    const saved = (await api().put("/api/v1/setup/sequence").set(t.auth).send(seq()).expect(200)).body.data;
    expect(saved.fromSample).toBe(false);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: t.campaignId } });
    expect((campaign.sequence as { subject: string | null }[])[0].subject).toBe("Client reporting time");
  });

  it("Targeting shows the audiences, warns about people already queued, and drops them only when asked", async () => {
    const t = await launchedTenant();
    for (let i = 0; i < 3; i++) await makeContact(t.orgId, { campaignId: t.campaignId, audienceId: "g2", status: "NEW" });
    await makeContact(t.orgId, { campaignId: t.campaignId, audienceId: "g1", status: "QUEUED" });
    const view = (await api().get("/api/v1/setup/targeting").set(t.auth).expect(200)).body.data;
    expect(view.groups.map((g: { id: string; queued: number }) => [g.id, g.queued])).toEqual([["g1", 1], ["g2", 3]]);
    const edits = view.groups.map((g: { id: string; on: boolean; titles: string[]; keywords: string[]; sizes: string[]; regions: string[] }) => ({ id: g.id, on: g.on, titles: g.titles, keywords: g.keywords, sizes: g.sizes, regions: g.regions }));

    // Switching an audience off affects the three people waiting from it.
    edits[1].on = false;
    const impact = (await api().post("/api/v1/setup/targeting/check").set(t.auth).send({ groups: edits }).expect(200)).body.data;
    expect(impact).toMatchObject({ queued: 3, affected: [{ id: "g2", name: "Agency founders", queued: 3, off: true }] });
    // Unchanged audiences are not touched.
    expect(impact.affected.some((a: { id: string }) => a.id === "g1")).toBe(false);

    edits[1].on = true;
    edits[1].titles = ["Founder", "Managing Director"];
    const saved = (await api().put("/api/v1/setup/targeting").set(t.auth).send({ groups: edits, dropQueued: true }).expect(200)).body.data;
    expect(saved.dropped).toBe(3);
    expect(saved.groups[1].titles).toEqual(["Founder", "Managing Director"]);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: t.campaignId } });
    const aud = campaign.audiences as { id: string; page: number }[];
    // The unchanged audience keeps its place in the results; the changed one starts again.
    expect(aud.map((a) => [a.id, a.page])).toEqual([["g1", 4], ["g2", 1]]);
    expect(await prisma.contact.count({ where: { organizationId: t.orgId, status: "REJECTED" } })).toBe(3);
    expect(await prisma.contact.count({ where: { organizationId: t.orgId, audienceId: "g1", status: "QUEUED" } })).toBe(1);

    edits.forEach((e: { on: boolean }) => (e.on = false));
    await api().put("/api/v1/setup/targeting").set(t.auth).send({ groups: edits }).expect(400);
  });
});
