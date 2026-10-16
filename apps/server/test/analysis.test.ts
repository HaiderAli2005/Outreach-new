import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setAiClient, type AiClient, type AiOptions } from "../src/integrations/ai.js";
import { setSiteReader } from "../src/integrations/site.js";
import { setApolloFactory } from "../src/integrations/apollo.js";
import { logosFrom } from "../src/integrations/site.js";
import { ANALYSIS_SYSTEM, analysisUserPrompt } from "../src/modules/onboarding/analysisPrompt.js";
import { validateAnalysis } from "../src/modules/onboarding/analysisValidate.js";
import { extractSignals } from "../src/modules/onboarding/signals.js";

function audience(over: Record<string, unknown> = {}) {
  return {
    id: "seg_1",
    priority: 1,
    name: "UK agencies",
    description: "Small UK marketing agencies",
    why_they_buy: "They chase late invoices",
    goals: ["Get paid on time"],
    pain_points: ["Late payments", "Manual reminders"],
    objections: ["We use spreadsheets"],
    titles: ["Founder", "Managing Director", "Finance Manager"],
    include_similar_titles: true,
    seniorities: ["founder", "owner", "manager"],
    company_sizes: ["11,50"],
    countries: ["United Kingdom"],
    keywords: ["marketing agency"],
    revenue_range: { min: null, max: null },
    technologies: [],
    signals: { hiring_for_titles: [], headcount_growth_pct_min: null, recently_funded: false },
    lookalike_domains: [],
    exclude_domains: ["northwind.io"],
    email_status: ["verified"],
    ...over,
  };
}

function modelOutput(over: { brand?: Record<string, unknown>; audiences?: unknown[]; warning?: string | null } = {}) {
  return {
    brand_detail: {
      company_name: "Northwind",
      one_liner: "Invoicing software for UK marketing agencies",
      offerings: ["Invoicing", "Payment reminders"],
      business_model: "B2B",
      customer_types: ["Marketing agencies"],
      customer_size_hint: null,
      geographies: ["United Kingdom"],
      price_level: null,
      proof: [{ text: "Used by 200 agencies", source: "/customers" }],
      differentiators: [{ text: "Automatic payment reminders", source: "/" }],
      named_customers: ["Brightlabs"],
      buyer_titles_seen: ["Managing Director"],
      competitors: [],
      language: "en",
      brand_voice: "We get agencies paid. No chasing.",
      confidence: 0.8,
      evidence: [{ claim: "Built for agencies", source: "/customers" }],
      ...over.brand,
    },
    warning: over.warning ?? null,
    target_audience: over.audiences ?? [
      audience(),
      audience({ id: "seg_2", priority: 2, name: "Design studios", titles: ["Studio Director", "Operations Manager", "Owner"] }),
      audience({ id: "seg_3", priority: 3, name: "PR firms", titles: ["Head of Finance", "Partner", "Office Manager"] }),
    ],
  };
}

function recordingAi(outputs: (Record<string, unknown> | null)[]) {
  const calls: { prompt: string; opts?: AiOptions }[] = [];
  const client: AiClient = {
    async generateJSON<T>(prompt: string, opts?: AiOptions) {
      calls.push({ prompt, opts });
      const next = outputs.length > 1 ? outputs.shift()! : outputs[0];
      return next as T;
    },
    async generateText() {
      return "";
    },
  };
  return { client, calls };
}

const site = () =>
  setSiteReader(async () => ({
    home: { title: "Northwind", description: null, lang: "en" },
    pages: [
      { path: "/", title: "Northwind", text: "Invoicing for agencies with automatic payment reminders. Plans from £49 a month. Call +44 20 7946 0000.", logos: ["Brightlabs", "Harbor & Co"] },
      { path: "/customers", title: "Customers", text: '"We get paid in half the time." Jane Doe, Managing Director at Brightlabs. Invoicing built for agencies, used by 200 agencies across the UK.' },
    ],
  }));

describe("analysis prompt v1", () => {
  beforeEach(resetDb);

  it("sends the v1 system and user prompt with pages, code signals and the allowed lists", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    site();
    const ai = recordingAi([modelOutput()]);
    setAiClient(ai.client);
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].opts?.system).toBe(ANALYSIS_SYSTEM);
    const prompt = ai.calls[0].prompt;
    expect(prompt).toContain("DOMAIN: northwind.io");
    expect(prompt).toContain(`TODAY: ${new Date().toISOString().slice(0, 10)}`);
    expect(prompt).toContain('{"url":"/customers","text":"Customers. \\"We get paid in half the time.\\"');
    expect(prompt).toContain('"country":"United Kingdom"');
    expect(prompt).toContain('"currency":"GBP"');
    expect(prompt).toContain('"named_customers":["Brightlabs","Harbor & Co"]');
    expect(prompt).toContain('"testimonial_titles":["Managing Director"]');
    expect(prompt).toContain('WEB RESULTS (lower authority, may describe other companies):\n[]');
    expect(prompt).toContain('["1,10","11,50","51,200","201,500","501,1000","1001,5000","5001,"]');
    expect(prompt).toContain("always includes northwind.io");

    const o = res.body.data.onboarding;
    expect(o.analyzedAt).not.toBeNull();
    expect(o.groups.map((g: { name: string }) => g.name)).toEqual(["UK agencies", "Design studios", "PR firms"]);
    expect(o.groups[0]).toMatchObject({ priority: 1, description: "Small UK marketing agencies", pains: ["Late payments", "Manual reminders"], goals: ["Get paid on time"], seniorities: ["founder", "owner", "manager"], sizes: ["11,50"], excludeDomains: ["northwind.io"] });
    expect(o.analysis.brandDetail).toMatchObject({ company_name: "Northwind", named_customers: ["Brightlabs"], proof: [{ text: "Used by 200 agencies", source: "/customers" }] });
    const stored = await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect((stored.analysis as { signals: { country: string } }).signals.country).toBe("United Kingdom");
  });

  it("retries once when the model returns invalid JSON and records the repair", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    site();
    const ai = recordingAi([null, modelOutput()]);
    setAiClient(ai.client);
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    expect(ai.calls).toHaveLength(2);
    expect(res.body.data.onboarding.analysis.repairsMade[0]).toBe("model output was not valid JSON, retried once");
  });

  it("fails after a second invalid answer instead of inventing one", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    site();
    setAiClient(recordingAi([null]).client);
    await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(502);
    const o = await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(o.analyzedAt).toBeNull();
  });

  it("keeps the audiences as a best guess when confidence is low but usable", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    site();
    setAiClient(recordingAi([modelOutput({ brand: { confidence: 0.3 } })]).client);
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    const o = res.body.data.onboarding;
    expect(o.analyzedAt).not.toBeNull();
    expect(o.analysisError).toBeNull();
    expect(o.analysis).toMatchObject({ lowConfidence: true, confidence: 0.3 });
    expect(o.groups.length).toBeGreaterThan(0);
  });

  it("shows the three questions when confidence is below 0.2, then builds from the answers with the same prompt", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    site();
    const ai = recordingAi([modelOutput({ brand: { confidence: 0.15 } })]);
    setAiClient(ai.client);
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    const o = res.body.data.onboarding;
    expect(o).toMatchObject({ analyzedAt: null, analysisError: "low-confidence", siteReadable: true });
    expect(o.analysis).toMatchObject({ lowConfidence: true, confidence: 0.15 });
    expect(o.groups).toEqual([]);

    const answered = recordingAi([modelOutput({ brand: { confidence: 0.2 }, audiences: [audience({ countries: ["UK", "Germany"] })] })]);
    setAiClient(answered.client);
    const built = await api().post("/api/v1/onboarding/answers").set(t.auth).send({ sell: "Invoicing for agencies", who: "Agency owners", regions: ["United Kingdom"] }).expect(200);
    expect(answered.calls[0].opts?.system).toBe(ANALYSIS_SYSTEM);
    expect(answered.calls[0].prompt).toContain('"url":"user-answers"');
    expect(answered.calls[0].prompt).toContain("Who buys it: Agency owners");
    const b = built.body.data.onboarding;
    expect(b.analyzedAt).not.toBeNull();
    expect(b.analysis).toMatchObject({ source: "answers", lowConfidence: false });
    expect(b.groups[0].regions).toEqual(["United Kingdom"]);
    expect(b.facts.find((f: { key: string }) => f.key === "who")).toMatchObject({ value: "Agency owners", source: "from your answers" });
    expect(b.analysis.repairsMade).toContain("seg_1.countries: limited to the countries you picked");
  });

  it("keeps a consumer business warning and searches Apollo with every audience field", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    site();
    setAiClient(
      recordingAi([
        modelOutput({
          warning: "Sells to consumers; audiences are the shops that stock it",
          audiences: [audience({ technologies: ["Shopify"], revenue_range: { min: 1000000, max: null }, signals: { hiring_for_titles: ["Finance Manager"], headcount_growth_pct_min: null, recently_funded: false }, exclude_domains: ["rival.com"] })],
        }),
      ]).client,
    );
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    expect(res.body.data.onboarding.analysis.warning).toBe("Sells to consumers; audiences are the shops that stock it");
    const calls: Record<string, unknown>[] = [];
    setApolloFactory(async () => ({
      async searchPeople(filters: Record<string, unknown>) {
        calls.push(filters);
        return {
          people: [
            { first_name: "Own", last_name: "Staff", organization: { name: "Northwind", primary_domain: "northwind.io" } },
            { first_name: "Sam", last_name: "Price", organization: { name: "Acme", primary_domain: "acme.co.uk" } },
          ],
          totalEntries: 10,
        };
      },
      async bulkEnrich() {
        return [];
      },
    }));
    const market = await api().get("/api/v1/onboarding/market").set(t.auth).expect(200);
    expect(calls[0]).toMatchObject({
      person_titles: ["Founder", "Managing Director", "Finance Manager"],
      include_similar_titles: true,
      person_seniorities: ["founder", "owner", "manager"],
      organization_num_employees_ranges: ["11,50"],
      person_locations: ["United Kingdom"],
      q_organization_keyword_tags: ["marketing agency"],
      q_organization_job_titles: ["Finance Manager"],
      revenue_range: { min: 1000000 },
    });
    // Guessed technology ids return zero people at Apollo, so they are never sent.
    expect(calls[0]).not.toHaveProperty("currently_using_any_of_technology_uids");
    expect(market.body.data.prospects.map((p: { company: string }) => p.company)).toEqual(["Acme"]);
  });
});

describe("Apollo filters", () => {
  it("drops empty filters, which Apollo rejects with a 422", async () => {
    const { compactFilters } = await import("../src/integrations/apollo.js");
    expect(compactFilters({ person_titles: ["Founder"], organization_num_employees_ranges: [], revenue_range: {}, q: "", x: null })).toEqual({ person_titles: ["Founder"] });
  });
});

describe("code checks on the model output", () => {
  it("repairs what the prompt forbids and records every repair", () => {
    const raw = modelOutput({
      brand: { confidence: 7, language: "English", proof: [{ text: "Great results", source: "" }, { text: "Won an award", source: "/about" }], business_model: "enterprise" },
      audiences: [
        audience({
          priority: 2,
          name: "Second",
          titles: ["Founder", "people who manage finance", "Head of Finance", "A", "B", "C", "D", "E", "F", "G", "H"],
          seniorities: ["Founder", "boss"],
          company_sizes: ["11, 50", "10-50"],
          countries: ["UK", "usa", "uae", "germany"],
          keywords: ["SaaS", "Agency", "fintech", "retail", "logistics", "health"],
          exclude_domains: ["https://www.Rival.com/about"],
          lookalike_domains: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"],
        }),
        audience({ priority: 1, name: "First", titles: ["Founder", "Owner", "CEO"] }),
      ],
    });
    const { analysis, repairs } = validateAnalysis(raw, "northwind.io", "de");
    const bd = analysis.brand_detail;
    expect(bd.confidence).toBe(1);
    expect(bd.language).toBe("en");
    expect(bd.business_model).toBeNull();
    expect(bd.proof).toEqual([{ text: "Won an award", source: "/about" }]);
    const [first, second] = analysis.target_audience;
    expect(first).toMatchObject({ id: "seg_1", priority: 1, name: "First", titles: ["Founder", "Owner", "CEO"] });
    expect(second.titles).toEqual(["Head of Finance", "A", "B", "C", "D", "E", "F", "G"]);
    expect(second.seniorities).toEqual(["founder"]);
    expect(second.company_sizes).toEqual(["11,50"]);
    expect(second.countries).toEqual(["United Kingdom", "United States", "United Arab Emirates"]);
    expect(second.keywords).toEqual(["saas", "agency", "fintech", "retail", "logistics"]);
    expect(second.exclude_domains).toEqual(["northwind.io", "rival.com"]);
    expect(second.lookalike_domains).toHaveLength(5);
    expect(second.email_status).toEqual(["verified"]);
    expect(repairs).toEqual(
      expect.arrayContaining([
        "brand_detail.confidence: 7 clamped to 0..1",
        'proof: dropped "Great results" (no source)',
        'target_audience[0].titles: removed duplicate "Founder"',
        'target_audience[0].titles: removed description "people who manage finance"',
        'target_audience[0].titles: trimmed "H" (more than 8)',
        'target_audience[0].seniorities: dropped "boss" (not in allowed list)',
        'target_audience[0].company_sizes: dropped "10-50" (not in allowed list)',
        'target_audience[0].countries: "UK" -> "United Kingdom"',
        "target_audience[0].countries: trimmed to 3",
        "target_audience[0].keywords: trimmed to 5",
        "target_audience[0].exclude_domains: added northwind.io",
        "target_audience: only 2 usable audience(s), expected 3 to 6",
      ]),
    );
  });

  it("keeps at most 6 audiences", () => {
    const many = Array.from({ length: 8 }, (_, i) => audience({ priority: i + 1, name: `Segment ${i + 1}`, titles: [`Title ${i + 1}`] }));
    const { analysis, repairs } = validateAnalysis(modelOutput({ audiences: many }), "northwind.io", null);
    expect(analysis.target_audience).toHaveLength(6);
    expect(repairs).toContain("target_audience: 8 returned, kept the first 6 by priority");
  });

  it("keeps only keywords that describe the buyer's kind of company", () => {
    const raw = modelOutput({
      brand: { company_name: "eKhata", offerings: ["Accounting software", "Inventory management", "Manufacturing and production tracking"] },
      audiences: [
        audience({ name: "Wholesalers", keywords: ["Wholesale", "distribution", "inventory management", "Retail", "small business"] }),
        audience({ priority: 2, name: "Shops", titles: ["Store Manager"], keywords: ["retail", "billing", "inventory", "operations", "ekhata partners"] }),
        audience({ priority: 3, name: "Accountants", titles: ["Senior Accountant"], keywords: ["accounting", "accounting firm", "tax consultancy", "manufacturing", "companies that need better books"] }),
      ],
    });
    const { analysis, repairs } = validateAnalysis(raw, "ekhata.ai", null);
    const [a, b, c] = analysis.target_audience;
    expect(a.keywords).toEqual(["wholesale", "distribution", "retail"]);
    expect(b.keywords).toEqual(["retail"]);
    expect(c.keywords).toEqual(["accounting firm", "tax consultancy", "manufacturing"]);
    expect(repairs).toEqual(
      expect.arrayContaining([
        'target_audience[0].keywords: removed "inventory management" (what the company sells, matches competitors not customers)',
        'target_audience[0].keywords: removed "small business" (too generic)',
        'target_audience[1].keywords: removed "billing" (what the company sells, matches competitors not customers)',
        'target_audience[1].keywords: removed "inventory" (what the company sells, matches competitors not customers)',
        'target_audience[1].keywords: removed "operations" (a job function, belongs in titles)',
        'target_audience[1].keywords: removed "ekhata partners" (the company\'s own name)',
        "target_audience[1].keywords: only 1 usable, expected 2 to 5",
        'target_audience[2].keywords: removed "accounting" (what the company sells, matches competitors not customers)',
        'target_audience[2].keywords: removed "companies that need better books" (more than 3 words, not a kind of company)',
      ]),
    );
  });

  it("puts the keyword rules in the prompt", () => {
    const p = analysisUserPrompt({ domain: "acme.com", today: "2026-09-25", pages: [], signals: { country: null, language: null, currency: null, named_customers: [], testimonial_titles: [] }, searchResults: [] });
    expect(p).toContain("### HOW TO WRITE KEYWORDS");
    expect(p).toContain('Ask: "what kind of\n  business is this audience?" not "what does acme.com sell?".');
    expect(p).toContain("- No keyword names what acme.com sells, a job function, or a generic word");
  });

  it("removes bare seniority words as titles, fixes lowercase titles and fills empty countries", () => {
    const raw = modelOutput({
      audiences: [
        audience({ name: "Owners", titles: ["owner", "founder", "manager", "head", "director"], countries: [] }),
        audience({ priority: 2, name: "Ops", titles: ["head of operations", "HR MANAGER", "vp of sales", "Plant Manager"], countries: [] }),
      ],
    });
    const { analysis, repairs } = validateAnalysis(raw, "northwind.io", null, "Pakistan");
    const [first, second] = analysis.target_audience;
    expect(first.titles).toEqual(["Owner", "Founder"]);
    expect(second.titles).toEqual(["Head of Operations", "HR Manager", "VP of Sales", "Plant Manager"]);
    expect(first.countries).toEqual(["Pakistan"]);
    expect(repairs).toEqual(
      expect.arrayContaining([
        'target_audience[0].titles: removed "manager" (a seniority, not a job title)',
        'target_audience[0].titles: removed "head" (a seniority, not a job title)',
        'target_audience[0].titles: removed "director" (a seniority, not a job title)',
        'target_audience[0].titles: "owner" -> "Owner"',
        'target_audience[1].titles: "head of operations" -> "Head of Operations"',
        "target_audience[0].countries: empty, set to Pakistan (site signals)",
      ]),
    );
    const noSignal = validateAnalysis(modelOutput({ audiences: [audience({ countries: [] })] }), "northwind.io", null, null);
    expect(noSignal.analysis.target_audience[0].countries).toEqual(noSignal.analysis.brand_detail.geographies.slice(0, 3));
  });
});

describe("signals found by code", () => {
  it("reads country, language, currency, customer logos and testimonial titles", () => {
    const html = `<section><h2>Trusted by teams at</h2><img src="a.png" alt="Brightlabs logo"><img alt="logo"><img alt="Harbor &amp; Co"></section>`;
    expect(logosFrom(html)).toEqual(["Brightlabs", "Harbor & Co"]);
    const s = extractSignals("northwind.de", { title: null, description: null, lang: "de" }, [
      { path: "/", title: null, text: "Ab 49 € pro Monat. Anna Schmidt, Head of Operations at Acme GmbH", logos: ["Acme"] },
    ]);
    expect(s).toEqual({ country: "Germany", language: "de", currency: "EUR", named_customers: ["Acme"], testimonial_titles: ["Head of Operations"] });
    const none = extractSignals("northwind.io", null, [{ path: "/", title: null, text: "We help teams." }]);
    expect(none).toEqual({ country: null, language: null, currency: null, named_customers: [], testimonial_titles: [] });
  });

  it("builds the user prompt from the template", () => {
    const p = analysisUserPrompt({ domain: "acme.com", today: "2026-09-24", pages: [], signals: { country: null, language: null, currency: null, named_customers: [], testimonial_titles: [] }, searchResults: [] });
    expect(p.startsWith("Analyse this company.\n\nDOMAIN: acme.com\nTODAY: 2026-09-24")).toBe(true);
    expect(p).toContain("### BEFORE YOU ANSWER, CHECK");
    expect(p).toContain("- acme.com appears in every `exclude_domains`");
    expect(p).not.toContain("{{");
  });
});

describe("why an analysis failed", () => {
  beforeEach(resetDb);

  it("turns OpenAI errors into a reason the user can act on", async () => {
    const { aiErrorReason } = await import("../src/modules/onboarding/onboarding.service.js");
    expect(aiErrorReason({ status: 401 })).toMatch(/rejected the API key/);
    expect(aiErrorReason({ status: 429, code: "insufficient_quota" })).toMatch(/no credit left/);
    expect(aiErrorReason({ status: 429 })).toMatch(/rate limiting/);
    expect(aiErrorReason({ status: 404, code: "model_not_found" })).toMatch(/isn't available on your OpenAI account/);
    expect(aiErrorReason({ message: "Connection error.", cause: { code: "ENOTFOUND" } })).toMatch(/Couldn't reach OpenAI/);
  });

  it("shows the reason on the analysis step and on an answers-only audience", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    site();
    const failing: AiClient = {
      async generateJSON() {
        throw Object.assign(new Error("429 You exceeded your current quota"), { status: 429, code: "insufficient_quota" });
      },
      async generateText() {
        return "";
      },
    };
    setAiClient(failing);
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(502);
    expect(res.body.error.message).toMatch(/no credit left/);
    const stored = await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } });
    expect(stored.analysisError).toMatch(/no credit left/);
    const built = await api().post("/api/v1/onboarding/answers").set(t.auth).send({ sell: "Invoicing", who: "Agency owners", regions: ["United Kingdom"] }).expect(200);
    expect(built.body.data.onboarding.analysisError).toMatch(/^answers-only: .*no credit left/);
    expect(built.body.data.onboarding.groups).toHaveLength(1);
  });
});

describe("reading a page", () => {
  it("keeps the main content and drops navigation, footers and symbol noise", async () => {
    const { bodyText } = await import("../src/integrations/site.js");
    const html = `<html><body><nav>Home Pricing Sign in</nav><header><h1>Payroll for restaurants</h1></header>
      <div>LIVE — ▸ — ▸ — ▸</div><p>We run payroll &amp; tips for 1,200 venues. It&#8217;s quick.</p><footer>© 2026 Terms</footer></body></html>`;
    const text = bodyText(html);
    expect(text).toContain("Payroll for restaurants");
    expect(text).toContain("We run payroll & tips for 1,200 venues. It’s quick.");
    expect(text).not.toMatch(/Sign in|Terms|▸/);
    const withMain = `<nav>Menu</nav><main><p>${"Invoicing for agencies. ".repeat(20)}</p></main><aside>Newsletter signup</aside>`;
    expect(bodyText(withMain)).not.toContain("Newsletter");
  });
});
