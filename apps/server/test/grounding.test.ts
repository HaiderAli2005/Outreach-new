import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { isReasoningModel, requestParams, setAiClient, type AiClient, type AiOptions } from "../src/integrations/ai.js";
import { groundAnalysis, numbersIn, pageFor, indexPages, sourceFor, supportedBy } from "../src/modules/onboarding/grounding.js";
import { customerWarning, validateAnalysis } from "../src/modules/onboarding/analysisValidate.js";
import { ANALYSIS_SCHEMA } from "../src/modules/onboarding/analysisPrompt.js";
import { cleanEmail, emailProblems } from "../src/modules/onboarding/onboarding.service.js";

const pages = [
  { url: "/", text: "Northwind. Invoicing software for marketing agencies in the United Kingdom. Plans from £49 a month." },
  { url: "/customers", text: "Used by 1,200 agencies. Brightlabs cut late payments by 38%. Compare us with Invoicely (invoicely.com)." },
];

function analysis(over: Record<string, unknown> = {}) {
  return validateAnalysis(
    {
      brand_detail: {
        company_name: "Northwind",
        one_liner: "Invoicing software for marketing agencies",
        offerings: ["Invoicing software", "Payroll"],
        customer_types: ["Marketing agencies"],
        geographies: ["United Kingdom"],
        price_level: "From £49 a month",
        proof: [
          { text: "Used by 1,200 agencies", source: "https://northwind.io/customers/" },
          { text: "Brightlabs cut late payments by 38%", source: "/customers" },
          { text: "Brightlabs cut late payments by 45%", source: "/customers" },
          { text: "Winner of the 2024 Fintech award", source: "/awards" },
        ],
        differentiators: [{ text: "Works offline", source: "/" }],
        named_customers: ["Brightlabs", "Acme Corp"],
        buyer_titles_seen: ["Finance Director"],
        competitors: ["invoicely.com", "xero.com"],
        language: "en",
        confidence: 0.85,
        evidence: [{ claim: "Invoicing software for marketing agencies", source: "/" }],
        ...over,
      },
      target_audience: [
        { name: "UK agencies", titles: ["Founder", "Finance Manager", "Managing Director"], countries: ["United Kingdom"], keywords: ["marketing agency"], lookalike_domains: ["brightlabs.com", "madeup.io"] },
      ],
    },
    "northwind.io",
    "en",
  ).analysis;
}

describe("grounding", () => {
  it("keeps what the pages say and removes what they don't", () => {
    const { analysis: a, repairs } = groundAnalysis(analysis(), pages, { country: null, language: "en", currency: "GBP", named_customers: [], testimonial_titles: [] }, "northwind.io");
    const bd = a.brand_detail;
    expect(bd.proof).toEqual([
      { text: "Used by 1,200 agencies", source: "/customers" },
      { text: "Brightlabs cut late payments by 38%", source: "/customers" },
    ]);
    expect(bd.differentiators).toEqual([]);
    expect(bd.offerings).toEqual(["Invoicing software"]);
    expect(bd.named_customers).toEqual(["Brightlabs"]);
    expect(bd.buyer_titles_seen).toEqual([]);
    expect(bd.competitors).toEqual(["invoicely.com"]);
    expect(bd.price_level).toBe("From £49 a month");
    expect(a.target_audience[0].lookalike_domains).toEqual(["brightlabs.com"]);
    // Guessed competitors are no longer shown but still kept out of the lead search.
    expect(a.target_audience[0].exclude_domains).toEqual(expect.arrayContaining(["xero.com", "invoicely.com"]));
    expect(repairs).toEqual(
      expect.arrayContaining([
        'grounding.proof: dropped "Brightlabs cut late payments by 45%" (not supported by /customers)',
        'grounding.proof: dropped "Winner of the 2024 Fintech award" (source /awards was not read)',
        'grounding.competitors: xero.com hidden (not named on the site, still excluded from searches)',
      ]),
    );
  });

  it("removes prices and numbers the site never published", () => {
    const { analysis: a } = groundAnalysis(analysis({ price_level: "From £99 a month", one_liner: "Invoicing for 5,000 marketing agencies", customer_size_hint: "10 to 50 staff" }), pages, null, "northwind.io");
    expect(a.brand_detail.price_level).toBeNull();
    expect(a.brand_detail.customer_size_hint).toBeNull();
    expect(a.brand_detail.one_liner).not.toMatch(/5,?000/);
  });

  it("lowers confidence when most claims are unsupported, so the user is asked instead", () => {
    const thin = analysis({ proof: [{ text: "Trusted by 10,000 teams", source: "/" }, { text: "SOC 2 certified", source: "/" }, { text: "Rated 4.9 stars", source: "/reviews" }], offerings: ["Payroll", "HR software"], differentiators: [] });
    const { analysis: a } = groundAnalysis(thin, pages, null, "northwind.io");
    expect(a.brand_detail.confidence).toBe(0.7);
  });

  it("matches sources written as full URLs or bare paths, and checks numbers without separators", () => {
    const idx = indexPages(pages);
    expect(pageFor("https://www.northwind.io/customers/?x=1", idx, "northwind.io")?.url).toBe("/customers");
    expect(pageFor("customers", idx, "northwind.io")?.url).toBe("/customers");
    expect(pageFor("https://rival.com/customers", idx, "northwind.io")).toBeNull();
    expect(numbersIn("1,200 agencies, 38% faster, £49.")).toEqual(["1200", "38", "49"]);
    expect(supportedBy("Used by 1200 agencies", idx[1])).toBe(true);
    expect(supportedBy("Used by 1300 agencies", idx[1])).toBe(false);
    expect(sourceFor("Marketing agencies", [{ claim: "Invoicing software for marketing agencies", source: "/" }])).toBe("/");
    expect(sourceFor("United Kingdom", [{ claim: "Invoicing software for marketing agencies", source: "/" }])).toBeNull();
  });
});

describe("warning", () => {
  it("shows only a customer-facing warning, never the model's notes about its own work", () => {
    expect(customerWarning("You mainly sell to consumers, so these audiences are the shops that stock you.")).toMatch(/consumers/);
    expect(customerWarning("Pricing text contains conflicting starting prices and ambiguous billing labels. Audience countries and company-size filters are prospecting recommendations, not verified customer locations or headcounts.")).toBeNull();
    expect(customerWarning(null)).toBeNull();
  });
});

describe("sample email checks", () => {
  const allowed = "Used by 1,200 agencies. Invoicing software for marketing agencies.";

  it("flags invented numbers and merge tokens we can't fill", () => {
    const problems = emailProblems([{ subject: "late invoices", body: "Hi {{first_name}}, 1,200 agencies use us. We cut payment time by 40% for {{job_title}}." }], allowed);
    expect(problems).toEqual([
      '"40" is not a number the sender published; remove it or use only numbers from the proof',
      "{{job_title}} is not an allowed merge token; use only {{first_name}}, {{company}}, {{sender_first_name}} and {{similar_company}}",
    ]);
    expect(emailProblems([{ subject: "x", body: "Hi {{first_name}}, 1,200 agencies at firms like {{company}} use us." }], allowed)).toEqual([]);
  });

  it("cuts a sentence that still has an invented number", () => {
    expect(cleanEmail("Hi {{first_name}},\nWe helped 1,200 agencies. Payments land 40% faster. Worth a look?", allowed)).toBe("Hi {{first_name}},\nWe helped 1,200 agencies. Worth a look?");
  });
});

describe("AI requests", () => {
  it("uses reasoning settings and a strict schema for new models, temperature for older ones", () => {
    expect(isReasoningModel("gpt-6.1-sol")).toBe(true);
    expect(isReasoningModel("gpt-5.5")).toBe(true);
    expect(isReasoningModel("gpt-4.1")).toBe(false);
    const r = requestParams("hi", { model: "gpt-6.1-sol", maxTokens: 24_000, temperature: 0.2, effort: "medium", schema: ANALYSIS_SCHEMA }, true) as Record<string, unknown>;
    expect(r).toMatchObject({ model: "gpt-6.1-sol", max_completion_tokens: 24_000, reasoning_effort: "medium", response_format: { type: "json_schema", json_schema: { name: "business_analysis", strict: true } } });
    expect(r).not.toHaveProperty("temperature");
    const old = requestParams("hi", { model: "gpt-4.1", maxTokens: 24_000, temperature: 0.2, schema: ANALYSIS_SCHEMA }, true, false) as Record<string, unknown>;
    expect(old).toMatchObject({ model: "gpt-4.1", max_tokens: 16_000, temperature: 0.2, response_format: { type: "json_object" } });
  });

  it("keeps every property required in the strict schema", () => {
    const walk = (node: Record<string, unknown>): void => {
      if (node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"))) {
        const props = Object.keys((node.properties as Record<string, unknown>) ?? {});
        expect(node.additionalProperties).toBe(false);
        expect([...(node.required as string[])].sort()).toEqual(props.sort());
        for (const p of Object.values(node.properties as Record<string, Record<string, unknown>>)) walk(p);
      }
      if (node.items) walk(node.items as Record<string, unknown>);
    };
    walk(ANALYSIS_SCHEMA.schema);
  });
});

describe("sample emails end to end", () => {
  beforeEach(resetDb);

  it("asks once more when a draft invents a number, and ships the fixed draft", async () => {
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    await prisma.onboarding.update({
      where: { organizationId: t.orgId },
      data: {
        summary: "Invoicing software for marketing agencies. Used by 1,200 agencies.",
        analyzedAt: new Date(),
        groups: [{ id: "seg_1", priority: 1, name: "UK agencies", description: "", why: "", goals: [], pains: [], objections: [], titles: ["Founder"], seniorities: [], sizes: [], regions: ["United Kingdom"], keywords: [], keywordSuggestions: [], on: true }],
      },
    });
    const bad = { emails: [{ subject: "late invoices", body: "Hi {{first_name}}, agencies get paid 40% faster with us. Worth a look?" }, { subject: "x", body: "Second." }, { subject: "y", body: "Third." }] };
    const good = { emails: [{ subject: "late invoices", body: "Hi {{first_name}}, 1,200 agencies send invoices with us. Worth a look?" }, { subject: "x", body: "Second." }, { subject: "y", body: "Third." }] };
    const prompts: { prompt: string; opts?: AiOptions }[] = [];
    const outs = [bad, good];
    const ai: AiClient = {
      async generateJSON<T>(prompt: string, opts?: AiOptions) {
        prompts.push({ prompt, opts });
        return outs.shift() as T;
      },
      async generateText() {
        return "";
      },
    };
    setAiClient(ai);
    const res = await api().post("/api/v1/onboarding/preview").set(t.auth).expect(200);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].opts?.schema?.name).toBe("email_sequence");
    expect(prompts[1].prompt).toContain('"40" is not a number the sender published');
    expect(res.body.data.onboarding.preview[0].body).toContain("1,200 agencies");
    expect(res.body.data.onboarding.preview[0].body).not.toContain("40%");
  });
});
