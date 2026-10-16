import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, fund, makeCapacity, resetDb, fakeAi, transport } from "./helpers.js";
import { debitCorrection } from "../src/domain/credits/index.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient } from "../src/integrations/ai.js";
import { setSiteReader } from "../src/integrations/site.js";
import { setApolloFactory } from "../src/integrations/apollo.js";
import { features } from "../src/config/env.js";

describe("onboarding", () => {
  beforeEach(resetDb);

  it("starts setup from a domain and validates it", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "not a domain" }).expect(400);
    const res = await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "HTTPS://www.Northwind.io/pricing" });
    expect(res.body.data.onboarding).toMatchObject({ domain: "northwind.io", brand: "Northwind" });
  });

  it("reports AI as unavailable instead of inventing an analysis", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth);
    expect(res.status).toBe(503);
  });

  it("reports an unreadable site so the user can answer questions instead", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    setAiClient(fakeAi({}));
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    expect(res.body.data.onboarding).toMatchObject({ siteReadable: false, analyzedAt: null });
    const built = await api().post("/api/v1/onboarding/answers").set(t.auth).send({ sell: "Next-day pallet delivery", who: "Operations managers at online retailers", regions: [] });
    expect(built.status).toBe(400);
    setAiClient(null);
    const ok = await api().post("/api/v1/onboarding/answers").set(t.auth).send({ sell: "Next-day pallet delivery", who: "Operations managers at online retailers", regions: ["United Kingdom"] }).expect(200);
    const o = ok.body.data.onboarding;
    expect(o.facts.find((f: { key: string }) => f.key === "sell")).toMatchObject({ value: "Next-day pallet delivery", source: "from your answers" });
    expect(o.groups).toHaveLength(1);
    expect(o.groups[0]).toMatchObject({ titles: ["Operations manager"], regions: ["United Kingdom"], on: true });
    expect(o.icp.titles).toEqual(["Operations manager"]);
  });

  it("stores facts with their real source page, buyer groups and a brand profile, and drops what the site doesn't say", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    setSiteReader(async () => ({
      home: { title: "Northwind | Invoicing", description: null },
      pages: [
        { path: "/", title: "Northwind", text: "Invoicing software for marketing agencies." },
        { path: "/services", title: "Services", text: "We send invoices and payment reminders. Used by 200 agencies." },
      ],
    }));
    setAiClient(
      fakeAi({
        brand_detail: {
          company_name: "Northwind",
          one_liner: "Invoicing software for marketing agencies",
          offerings: ["Invoicing", "Payment reminders", "Payroll"],
          business_model: "B2B",
          customer_types: ["Marketing agencies"],
          geographies: ["United Kingdom"],
          proof: [
            { text: "Used by 200 agencies", source: "https://northwind.io/services" },
            { text: "Trusted by 5,000 firms", source: "/services" },
            { text: "Rated 4.9 on G2", source: "/reviews" },
          ],
          differentiators: [],
          named_customers: ["Brightlabs"],
          competitors: ["rival.com"],
          language: "en",
          confidence: 0.8,
          evidence: [
            { claim: "Invoicing software for marketing agencies", source: "/" },
            { claim: "Sends payment reminders", source: "/services" },
          ],
        },
        warning: null,
        target_audience: [
          { id: "seg_1", priority: 1, name: "Marketing agencies", description: "Small UK agencies", why_they_buy: "They bill many clients.", pain_points: ["Late payments"], titles: ["Founder", "Managing Director", "Finance Manager"], seniorities: ["founder", "owner"], company_sizes: ["11,50", "bogus"], countries: ["UK"], keywords: ["Marketing Agency"], exclude_domains: [] },
          { name: "", titles: ["x"] },
        ],
      }),
    );
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    const o = res.body.data.onboarding;
    // Sources point at the page that says it; what no page says is labelled as a summary of the site.
    expect(o.facts.map((f: { key: string; source: string }) => [f.key, f.source])).toEqual([["company", "from your site"], ["sell", "/"], ["who", "/"], ["where", "from your site"], ["proof", "/services"]]);
    const bd = o.analysis.brandDetail;
    expect(bd.proof).toEqual([{ text: "Used by 200 agencies", source: "/services" }]);
    expect(bd.offerings).toEqual(["Invoicing", "Payment reminders"]);
    expect(bd.named_customers).toEqual([]);
    expect(bd.competitors).toEqual([]);
    expect(o.groups[0].excludeDomains).toEqual(expect.arrayContaining(["northwind.io", "rival.com"]));
    expect(o.analysis.repairsMade).toEqual(
      expect.arrayContaining([
        'grounding.proof: dropped "Trusted by 5,000 firms" (not supported by /services)',
        'grounding.proof: dropped "Rated 4.9 on G2" (source /reviews was not read)',
        'grounding.offerings: removed "Payroll" (not in the site\'s words)',
        'grounding.named_customers: removed "Brightlabs" (not on the site)',
      ]),
    );
    expect(o.groups).toHaveLength(1);
    expect(o.icp).toEqual({ industries: ["marketing agency"], titles: ["Founder", "Managing Director", "Finance Manager"], sizes: ["11,50"], regions: ["United Kingdom"] });
    expect(o.analysis).toMatchObject({ promptVersion: "analysis-prompt-v2", confidence: 0.8, lowConfidence: false });
    expect(o.analysis.repairsMade).toEqual(expect.arrayContaining(['target_audience[0].company_sizes: dropped "bogus" (not in allowed list)', "target_audience[1]: dropped (no name)"]));
    const s = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(s.valueProp).toBe("Invoicing software for marketing agencies");
    const off = await api().patch("/api/v1/onboarding").set(t.auth).send({ groups: [{ id: "seg_1", on: false }], facts: [{ key: "company", value: "Northwind Ltd" }] }).expect(200);
    expect(off.body.data.onboarding.icp.titles).toEqual([]);
    expect(off.body.data.onboarding.brand).toBe("Northwind Ltd");
  });

  it("lets the user edit an audience's keywords under the prompt rules and counts each keyword", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    setSiteReader(async () => ({ home: { title: "Northwind", description: null }, pages: [{ path: "/", title: "Northwind", text: "Invoicing for wholesalers" }] }));
    setAiClient(
      fakeAi({
        brand_detail: { company_name: "Northwind", one_liner: "Invoicing for wholesalers", offerings: ["Invoicing", "Payment reminders"], language: "en", confidence: 0.8 },
        warning: null,
        target_audience: [
          { name: "Wholesalers", titles: ["Owner", "Finance Manager"], countries: ["United Kingdom"], keywords: ["wholesale", "distribution"], keyword_suggestions: ["Retail", "invoicing", "wholesale"] },
        ],
      }),
    );
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    expect(res.body.data.onboarding.groups[0]).toMatchObject({ id: "seg_1", keywords: ["wholesale", "distribution"], keywordSuggestions: ["retail"] });

    const patch = (keywords: string[]) => api().patch("/api/v1/onboarding").set(t.auth).send({ groups: [{ id: "seg_1", keywords }] });
    expect((await patch(["wholesale", "invoicing software"]).expect(400)).body.error.message).toBe('"invoicing software" describes what you sell, so it would find your competitors, not your customers.');
    expect((await patch(["wholesale", "sales"]).expect(400)).body.error.message).toMatch(/job function/);
    expect((await patch(["a", "b", "c", "d", "e", "f"]).expect(400)).body.error.message).toBe("An audience can have up to 5 keywords. Remove one first, or split this audience.");
    expect((await patch([]).expect(400)).body.error.message).toMatch(/at least one keyword/);
    const ok = await patch(["wholesale", " Retail "]).expect(200);
    const g = ok.body.data.onboarding.groups[0];
    expect(g).toMatchObject({ keywords: ["wholesale", "retail"], keywordSuggestions: ["distribution"], on: true });
    expect(ok.body.data.onboarding.icp.industries).toEqual(["wholesale", "retail"]);

    const off = await api().get("/api/v1/onboarding/keywords?group=seg_1").set(t.auth).expect(200);
    expect(off.body.data).toMatchObject({ available: false, reason: "not-connected", keywords: [{ keyword: "wholesale", count: null, state: null }, { keyword: "retail", count: null, state: null }] });

    const calls: Record<string, unknown>[] = [];
    setApolloFactory(async () => ({
      async searchPeople(filters: Record<string, unknown>) {
        calls.push(filters);
        const tag = (filters.q_organization_keyword_tags as string[] | undefined)?.[0];
        return { people: [], totalEntries: tag === undefined ? 1000 : tag === "wholesale" ? 800 : 0 };
      },
      async bulkEnrich() {
        return [];
      },
    }));
    const counted = await api().get("/api/v1/onboarding/keywords?group=seg_1").set(t.auth).expect(200);
    expect(counted.body.data).toMatchObject({
      available: true,
      baseline: 1000,
      keywords: [{ keyword: "wholesale", count: 800, state: "broad" }, { keyword: "retail", count: 0, state: "none" }],
    });
    expect(calls[0]).toMatchObject({ person_titles: ["Owner", "Finance Manager"], person_locations: ["United Kingdom"] });
    expect(calls[0].q_organization_keyword_tags).toBeUndefined();
    await api().get("/api/v1/onboarding/keywords?group=seg_1").set(t.auth).expect(200);
    expect(calls).toHaveLength(3);
    await api().get("/api/v1/onboarding/keywords?group=nope").set(t.auth).expect(404);
    setApolloFactory(null);
  });

  it("sizes the market from lead search without inventing numbers", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    await api().post("/api/v1/onboarding/answers").set(t.auth).send({ sell: "Pallet delivery", who: "Operations managers", regions: ["United Kingdom"] }).expect(200);
    const none = await api().get("/api/v1/onboarding/market").set(t.auth).expect(200);
    expect(none.body.data).toMatchObject({ available: false, reason: "not-connected", people: null });
    const calls: Record<string, unknown>[] = [];
    setApolloFactory(async () => ({
      async searchPeople(filters: Record<string, unknown>) {
        calls.push(filters);
        return filters.contact_email_status
          ? { people: [], totalEntries: 300 }
          : { people: [{ first_name: "Sam", last_name: "Price", title: "Head of Operations", country: "United Kingdom", organization: { name: "Acme", estimated_num_employees: 40 } }], totalEntries: 1200 };
      },
      async bulkEnrich() {
        return [];
      },
    }));
    const res = await api().get("/api/v1/onboarding/market").set(t.auth).expect(200);
    expect(res.body.data).toMatchObject({ available: true, people: 1200, verified: 300 });
    expect(res.body.data.prospects[0]).toMatchObject({ firstName: "Sam", lastInitial: "P", company: "Acme" });
    expect(res.body.data.sample.bySize).toEqual([["11–50 staff", 1]]);
    await api().get("/api/v1/onboarding/market").set(t.auth).expect(200);
    expect(calls).toHaveLength(2);
  });

  it("never shows the customer domains, inboxes or a plan during setup", async () => {
    const t = await createTenant({ subscribed: false });
    const res = await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty("domains");
    expect(res.body.data).not.toHaveProperty("mailboxes");
    expect(res.body.data).not.toHaveProperty("subscription");
    expect(res.body.data).toMatchObject({ funded: false, credits: { balance: "$0.00", pricePerEmail: "$0.04" } });
    expect(res.body.data.credits).not.toHaveProperty("priceFirstEmail");
    await api().get("/api/v1/onboarding/domains/ideas").set(t.auth).expect(404);
    await api().put("/api/v1/onboarding/domains").set(t.auth).send({ domains: [{ name: "getnorthwind.com", inboxes: 3 }] }).expect(404);
  });

  it("launches only once credits are added, on the shared pool, in the customer's region", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    await prisma.onboarding.update({ where: { organizationId: t.orgId }, data: { summary: "x", icp: { industries: ["SaaS"], titles: ["CEO"], sizes: ["11 to 50"], regions: ["United Kingdom"] } } });
    await makeCapacity(1000);
    // 800 emails a day is stored as the daily budget: 800 x $0.04 = $32.
    await api().patch("/api/v1/onboarding").set(t.auth).send({ emailsPerDay: 800 }).expect(200);
    expect((await api().get("/api/v1/onboarding").set(t.auth)).body.data.emailsPerDay).toBe(800);
    const noCard = await api().post("/api/v1/onboarding/launch").set(t.auth).expect(402);
    expect(noCard.body.error.message).toMatch(/Add a card/);
    await fund(t.orgId, 25_000n);
    const res = await api().post("/api/v1/onboarding/launch").set(t.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.provisioned).toBeUndefined();
    expect(res.body.data.missing.join(" ")).not.toMatch(/mailbox/i);
    const campaign = await prisma.campaign.findFirstOrThrow({ where: { organizationId: t.orgId } });
    expect(campaign).toMatchObject({ status: "ACTIVE" });
    expect((campaign.apolloFilters as { person_titles: string[] }).person_titles).toEqual(["CEO"]);
    // Launching sends nothing by itself: the first emails go out from the shared pool on the next send run.
    expect(transport.sent).toHaveLength(0);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: t.orgId } })).region).toBe("uk");
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(settings).toMatchObject({ autopilotEnabled: true, dailyBudgetDecicents: 32_000n, dailySourceTarget: 200 });
    void features;
  });

  it("offers the whole range of emails a day whatever the pool holds, and never recommends the maximum", async () => {
    const t = await createTenant();
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    // No pool capacity at all: the customer still chooses freely. The pool is ours to size, never theirs to wait for.
    const v = (await api().get("/api/v1/onboarding/volume").set(t.auth).expect(200)).body.data;
    expect(v).toMatchObject({ ready: true, min: 100, max: 5000, step: 50, liveOn: null });
    expect(v.presets.some((p: { disabled: boolean }) => p.disabled)).toBe(false);
    expect(v.recommended).toBe(1000);
    expect(v.recommended).toBeLessThan(v.max);
    // Every stop is priced by the server: 500 a day is $20 a day, 125 new people, $440 a month.
    expect(v.stops.find((x: { emails: number }) => x.emails === 500)).toEqual({ emails: 500, perDay: "$20", perDayDeciCents: "20000", people: 125, perMonth: "$440" });
    await api().patch("/api/v1/onboarding").set(t.auth).send({ emailsPerDay: 5050 }).expect(400);
    await api().patch("/api/v1/onboarding").set(t.auth).send({ emailsPerDay: 525 }).expect(400);
    await api().patch("/api/v1/onboarding").set(t.auth).send({ emailsPerDay: 2500 }).expect(200);
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).dailyBudgetDecicents).toBe(100_000n);
  });

  it("refuses to launch at a $0 budget or an empty balance, each with its own message; a short pool is the team's alert", async () => {
    const t = await createTenant();
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    await prisma.onboarding.update({ where: { organizationId: t.orgId }, data: { summary: "x" } });
    const launch = () => api().post("/api/v1/onboarding/launch").set(t.auth);
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { dailyBudgetDecicents: 0n } });
    expect((await launch().expect(422)).body.error.message).toMatch(/daily budget is \$0/);
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { dailyBudgetDecicents: 20_000n } });
    const { balanceOf, credit } = await import("../src/domain/credits/index.js");
    const had = await balanceOf(t.orgId);
    await debitCorrection(t.orgId, had, "test");
    expect((await launch().expect(402)).body.error.message).toMatch(/balance is empty/);
    expect(await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } })).toMatchObject({ launchedAt: null });
    // With money and no pool capacity the campaign starts, and the team is told the pool is short.
    await credit(t.orgId, "BONUS", 10_000n, { ref: "test:refill", note: "test" });
    await launch().expect(200);
    const alert = await prisma.systemLog.findFirst({ where: { source: "capacity" } });
    expect(alert?.message).toMatch(/Pool short/);
  });

  it("Skip for now creates the campaign without starting it and gives no free credit", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    await prisma.onboarding.update({ where: { organizationId: t.orgId }, data: { summary: "x" } });
    await api().post("/api/v1/onboarding/skip-card").set(t.auth).expect(200);
    expect(await prisma.campaign.count({ where: { organizationId: t.orgId } })).toBe(1);
    expect(await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } })).toMatchObject({ autopilotEnabled: false });
    expect(await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } })).toMatchObject({ launchedAt: null });
    expect(await prisma.creditLedger.count({ where: { organizationId: t.orgId } })).toBe(0);
  });

  it("launches one search per audience, finds volume / 4 people a day, and never emails the customer or a competitor", async () => {
    const t = await createTenant();
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    await prisma.onboarding.update({
      where: { organizationId: t.orgId },
      data: {
        summary: "Invoicing for agencies",
        analysis: { brandDetail: { competitors: ["invoicely.com"] } },
        groups: [
          { id: "a", name: "Agency founders", titles: ["Founder"], regions: ["United Kingdom"], excludeDomains: ["northwind.io", "xero.com"], on: true },
          { id: "b", name: "SaaS finance leads", titles: ["Finance Director"], keywords: ["saas"], on: true },
          { id: "c", name: "Switched off", titles: ["CFO"], on: false },
        ],
      },
    });
    await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { dailyBudgetDecicents: 24_000n } });
    await makeCapacity(600);
    const res = await api().post("/api/v1/onboarding/launch").set(t.auth);
    expect(res.status).toBe(200);
    const campaign = await prisma.campaign.findFirstOrThrow({ where: { organizationId: t.orgId } });
    const audiences = campaign.audiences as { id: string; filters: { person_titles?: string[]; q_organization_keyword_tags?: string[] } }[];
    expect(audiences.map((a) => a.id)).toEqual(["a", "b"]);
    expect(audiences[0].filters.person_titles).toEqual(["Founder"]);
    expect(audiences[0].filters.q_organization_keyword_tags).toEqual([]);
    expect(audiences[1].filters.person_titles).toEqual(["Finance Director"]);
    const settings = await prisma.orgSettings.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(settings.dailyBudgetDecicents).toBe(24_000n);
    expect(settings.dailySourceTarget).toBe(150);
    const blocked = await prisma.blocklistEntry.findMany({ where: { organizationId: t.orgId, entryType: "DOMAIN" }, orderBy: { value: "asc" } });
    expect(blocked.map((b) => [b.value, b.reason])).toEqual([
      ["invoicely.com", "COMPETITOR"],
      ["northwind.io", "CUSTOMER"],
      ["xero.com", "COMPETITOR"],
    ]);
  });
});
