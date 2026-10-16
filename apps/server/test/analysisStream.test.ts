import { beforeEach, describe, expect, it } from "vitest";
import { api, createTenant, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { features } from "../src/config/env.js";
import { setAiClient, type AiClient } from "../src/integrations/ai.js";
import { setSiteReader } from "../src/integrations/site.js";
import { setApolloFactory, type ApolloApi, type ApolloPerson } from "../src/integrations/apollo.js";
import { interruptActiveRuns, waitForRun } from "../src/modules/analyses/analyses.service.js";

type Ev = { type: string; seq: number; step?: string; item?: Record<string, unknown>; code?: string; outcome?: string; [k: string]: unknown };

const ANALYSIS = {
  brand_detail: {
    company_name: "Northwind",
    one_liner: "Invoicing for UK marketing agencies",
    offerings: ["Invoicing", "Payment reminders"],
    business_model: "B2B",
    customer_types: ["Marketing agencies"],
    geographies: ["United Kingdom"],
    proof: [{ text: "Used by 200 agencies", source: "https://northwind.io/customers" }],
    differentiators: [{ text: "Sends invoices and reminders", source: "/services" }],
    competitors: ["rival.com"],
    language: "en",
    confidence: 0.8,
    evidence: [{ claim: "Invoicing for agencies in the UK", source: "/" }],
  },
  warning: null,
  target_audience: [
    { priority: 1, name: "UK agencies", titles: ["Founder", "Finance Manager"], countries: ["UK"], keywords: ["marketing agency", "pr firm"], keyword_suggestions: ["design studio"], lookalike_domains: ["rival.com", "brightlabs.co.uk"] },
    { priority: 2, name: "Design studios", titles: ["Studio Director"], countries: ["United Kingdom"], keywords: ["design studio", "branding agency"] },
  ],
};

const EMAILS = { emails: [{ subject: "Late invoices", body: "Hi {{first_name}}, quick one about invoices." }, { subject: "x", body: "Following up." }, { subject: "y", body: "Last note." }] };

function fakes() {
  const calls = { ai: 0, apollo: 0 };
  const ai: AiClient = {
    async generateJSON<T>(prompt: string) {
      calls.ai++;
      return (prompt.startsWith("Write a four step cold email sequence") ? EMAILS : ANALYSIS) as T;
    },
    async generateText() {
      return "text";
    },
  };
  const person = (first: string, last: string, org: string, domain: string): ApolloPerson => ({
    first_name: first,
    last_name: last,
    title: "Founder",
    country: "United Kingdom",
    email: `${first.toLowerCase()}@${domain}`,
    email_status: "verified",
    organization: { name: org, primary_domain: domain, country: "United Kingdom", estimated_num_employees: 30 },
  });
  const apollo: ApolloApi = {
    async searchPeople(filters) {
      calls.apollo++;
      if (filters.contact_email_status) return { people: [], totalEntries: 400 };
      return {
        people: [person("Sam", "Price", "Acme", "acme.co.uk"), person("Jo", "Reed", "Acme", "acme.co.uk"), person("Ali", "Khan", "Brightlabs", "brightlabs.co.uk"), person("Rae", "Moss", "Rival", "rival.com")],
        totalEntries: 1200,
      };
    },
    async bulkEnrich() {
      return [];
    },
  };
  setAiClient(ai);
  setApolloFactory(async () => apollo);
  setSiteReader(async (_d, hooks) => {
    const pages = [
      { path: "/", title: "Northwind", text: "Invoicing for agencies in the UK, compared with rival.com", logos: ["Brightlabs"] },
      { path: "/services", title: "Services", text: "We send invoices and reminders" },
      { path: "/customers", title: "Customers", text: "Used by 200 agencies" },
    ];
    hooks?.onRead?.("/");
    hooks?.onPage?.(pages[0]);
    hooks?.onRead?.("/services");
    hooks?.onPage?.(pages[1]);
    hooks?.onRead?.("/customers");
    hooks?.onPage?.(pages[2]);
    return { home: { title: "Northwind", description: null, lang: "en" }, pages };
  });
  return calls;
}

function parse(text: string): Ev[] {
  return text
    .split("\n\n")
    .map((b) => b.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)) as Ev)
    .filter((e) => e.type !== "heartbeat");
}

async function stream(auth: Record<string, string>, id: string, query = "", headers: Record<string, string> = {}, path = `/api/v1/analyses/${id}/stream`) {
  const res = await api().get(`${path}${query}`).set(auth).set(headers).buffer(true).parse((r, cb) => {
    let body = "";
    r.setEncoding("utf8");
    r.on("data", (c: string) => (body += c));
    r.on("end", () => cb(null, body));
  });
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
  return parse(res.body as string);
}

async function snapshot(orgId: string) {
  const o = await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: orgId } });
  const analysis = { ...(o.analysis as Record<string, unknown>), createdAt: null };
  const market = { ...(o.market as Record<string, unknown>), checkedAt: null };
  return { facts: o.facts, groups: o.groups, icp: o.icp, summary: o.summary, analysis, market, preview: o.preview, analyzedAt: !!o.analyzedAt };
}

describe("analysis stream", () => {
  beforeEach(resetDb);

  it("streams every step live and stores exactly what the single request stores", async () => {
    fakes();
    const before = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(before.auth).send({ domain: "northwind.io" }).expect(200);
    await api().post("/api/v1/onboarding/analysis").set(before.auth).expect(200);
    await api().get("/api/v1/onboarding/market").set(before.auth).expect(200);
    await api().post("/api/v1/onboarding/preview").set(before.auth).expect(200);

    const calls = fakes();
    features.analysisStream = true;
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" }).expect(200);
    const started = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    const run = started.body.data.analysisRun;
    expect(started.body.data.analysisStream).toBe(true);
    expect(run).toMatchObject({ status: "RUNNING" });
    const events = await stream(t.auth, run.id);
    await waitForRun(run.id);

    expect(events[0]).toMatchObject({ type: "run.start", analysisId: run.id, domain: "northwind.io", steps: ["fetch", "extract", "analyse", "validate", "size", "write"] });
    expect(events.at(-1)).toMatchObject({ type: "run.done", analysisId: run.id, outcome: "ok" });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.filter((e) => e.type === "step.start").map((e) => e.step)).toEqual(["fetch", "extract", "analyse", "validate", "size", "write"]);
    expect(events.filter((e) => e.type === "step.done").map((e) => e.step)).toEqual(["fetch", "extract", "analyse", "validate", "size", "write"]);
    const items = events.filter((e) => e.type === "item.found").map((e) => e.item!);
    const kinds = new Set(items.map((i) => i.kind));
    expect([...kinds].sort()).toEqual(["audience", "company", "count", "draft", "fact", "keyword", "page", "person", "repair", "signal"]);
    expect(items.filter((i) => i.kind === "page")).toEqual([
      { kind: "page", url: "/", words: 9 },
      { kind: "page", url: "/services", words: 5 },
      { kind: "page", url: "/customers", words: 4 },
    ]);
    expect(items).toContainEqual({ kind: "signal", label: "Language", value: "en", source: "page language" });
    expect(items).toContainEqual({ kind: "signal", label: "Customer logos", value: "Brightlabs", source: "logos on the site" });
    expect(items).toContainEqual({ kind: "fact", text: "Used by 200 agencies", source: "/customers" });
    expect(items).toContainEqual({ kind: "fact", text: "Competes with rival.com", source: "from your site" });
    expect(items).toContainEqual({ kind: "fact", text: "Invoicing for UK marketing agencies", source: "/" });
    expect(items).toContainEqual(expect.objectContaining({ kind: "audience", id: "seg_1", name: "UK agencies", icon: "agency" }));
    expect(items).toContainEqual({ kind: "keyword", audienceId: "seg_1", word: "design studio", suggestion: true });
    expect(items).toContainEqual({ kind: "count", audienceId: "seg_1", total: 1200, reachable: 400, companiesInSample: 2, companiesTotal: null });
    expect(items.filter((i) => i.kind === "company" && i.audienceId === "seg_1").map((i) => i.domain)).toEqual(["acme.co.uk", "brightlabs.co.uk"]);
    const people = items.filter((i) => i.kind === "person");
    expect(people[0]).toEqual({ kind: "person", audienceId: "seg_1", firstName: "Sam", lastNameMasked: "P***", title: "Founder", company: "Acme", country: "United Kingdom", hasEmail: true });
    expect(JSON.stringify(events)).not.toMatch(/@acme\.co\.uk|Price|Reed/);
    const companyAt = events.findIndex((e) => e.item?.kind === "company");
    const personAt = events.findIndex((e) => e.item?.kind === "person");
    expect(companyAt).toBeLessThan(personAt);
    expect(items.filter((i) => i.kind === "draft").map((i) => i.step)).toEqual([1, 2, 3]);
    const logs = events.filter((e) => e.type === "step.log");
    expect(logs).toContainEqual(expect.objectContaining({ step: "size", text: "sizing audience 2 of 2", state: "running" }));
    expect(logs).toContainEqual(expect.objectContaining({ step: "size", text: "sizing audience 2 of 2", state: "done" }));
    const analysed = events.find((e) => e.type === "step.done" && e.step === "analyse");
    expect(analysed).toMatchObject({ summary: { company: "Northwind", competitors: ["rival.com"] } });

    expect(calls).toEqual({ ai: 2, apollo: 4 });
    expect(await snapshot(t.orgId)).toEqual(await snapshot(before.orgId));
    const stored = (await prisma.onboarding.findUniqueOrThrow({ where: { organizationId: t.orgId } })).groups as { lookalikeDomains: string[]; excludeDomains: string[] }[];
    expect(stored[0].lookalikeDomains).toEqual(["brightlabs.co.uk"]);
    expect(stored[0].excludeDomains).toContain("rival.com");
    const state = await api().get("/api/v1/onboarding").set(t.auth).expect(200);
    expect(state.body.data.analysisRun).toMatchObject({ id: run.id, status: "DONE", lastSeq: events.length });
    const market = await api().get("/api/v1/onboarding/market").set(t.auth).expect(200);
    expect(market.body.data.companies.map((c: { name: string }) => c.name)).toEqual(["Acme", "Brightlabs"]);
    expect(market.body.data.groups[0]).toMatchObject({ companiesInSample: 2, companies: null });
    expect(calls.apollo).toBe(4);
  });

  it("replays a finished run from any point and never repeats the work", async () => {
    const calls = fakes();
    features.analysisStream = true;
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    const run = (await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200)).body.data.analysisRun;
    await waitForRun(run.id);
    const spent = { ...calls };
    const all = await stream(t.auth, run.id);
    const later = await stream(t.auth, run.id, "?from=10");
    expect(later).toEqual(all.slice(10));
    const header = await stream(t.auth, run.id, "", { "Last-Event-ID": "20" });
    expect(header).toEqual(all.slice(20));
    expect(calls).toEqual(spent);
    const other = await createTenant({ subscribed: false });
    await api().get(`/api/v1/analyses/${run.id}/stream`).set(other.auth).expect(404);
  });

  it("joins the run already in progress instead of starting a second one", async () => {
    const calls = fakes();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setSiteReader(async () => {
      await gate;
      return { home: { title: "Northwind", description: null }, pages: [{ path: "/", title: "Northwind", text: "Invoicing for agencies" }] };
    });
    features.analysisStream = true;
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    const a = (await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200)).body.data.analysisRun;
    const b = (await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200)).body.data.analysisRun;
    expect(b.id).toBe(a.id);
    release();
    await waitForRun(a.id);
    expect(calls.ai).toBe(2);
    expect(await prisma.analysisRun.count({ where: { organizationId: t.orgId } })).toBe(1);
  });

  it("reports an unreadable site and a failed AI call as recoverable errors", async () => {
    fakes();
    features.analysisStream = true;
    setSiteReader(async () => ({ home: null, pages: [] }));
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    const run = (await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200)).body.data.analysisRun;
    const events = await stream(t.auth, run.id);
    expect(events.at(-1)).toMatchObject({ type: "run.error", step: "fetch", code: "site-unreadable", recoverable: true });
    expect((await api().get("/api/v1/onboarding").set(t.auth)).body.data.onboarding.siteReadable).toBe(false);

    fakes();
    setAiClient({
      async generateJSON() {
        throw Object.assign(new Error("quota"), { status: 429, code: "insufficient_quota" });
      },
      async generateText() {
        return "";
      },
    });
    const again = (await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200)).body.data.analysisRun;
    expect(again.id).not.toBe(run.id);
    const failed = await stream(t.auth, again.id);
    expect(failed.at(-1)).toMatchObject({ type: "run.error", step: "analyse", code: "ai-failed", recoverable: true, message: expect.stringContaining("no credit left") });
    expect(await prisma.analysisRun.findUniqueOrThrow({ where: { id: again.id } })).toMatchObject({ status: "FAILED" });
  });

  it("ends a run that stopped when the server restarted, so a new one can start", async () => {
    fakes();
    features.analysisStream = true;
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    const old = new Date(Date.now() - 10 * 60_000);
    const run = await prisma.analysisRun.create({ data: { organizationId: t.orgId, domain: "northwind.io", createdAt: old, updatedAt: old } });
    await prisma.analysisEvent.create({ data: { analysisId: run.id, seq: 1, type: "step.start", payload: { type: "step.start", step: "analyse", label: "x" }, createdAt: old } });
    const events = await stream(t.auth, run.id);
    expect(events.at(-1)).toMatchObject({ type: "run.error", step: "analyse", code: "interrupted", recoverable: true });
    const next = (await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200)).body.data.analysisRun;
    expect(next.id).not.toBe(run.id);
    await waitForRun(next.id);
  });

  it("leaves a run alone while another server is still beating for it", async () => {
    fakes();
    features.analysisStream = true;
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    const old = new Date(Date.now() - 10 * 60_000);
    // Started long ago, but its heartbeat is fresh: it belongs to a live job elsewhere.
    const run = await prisma.analysisRun.create({ data: { organizationId: t.orgId, domain: "northwind.io", createdAt: old, updatedAt: new Date() } });
    const same = (await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200)).body.data.analysisRun;
    expect(same.id).toBe(run.id);
    expect(await prisma.analysisRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "RUNNING" });
    await prisma.analysisRun.update({ where: { id: run.id }, data: { status: "FAILED" } });
  });

  it("ends the runs it owns when the server shuts down", async () => {
    fakes();
    features.analysisStream = true;
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    const run = (await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200)).body.data.analysisRun;
    await interruptActiveRuns();
    expect(await prisma.analysisRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "FAILED", error: "interrupted" });
    await waitForRun(run.id);
  });

  it("counts companies per audience only when the paid count is switched on", async () => {
    fakes();
    let counted = 0;
    setApolloFactory(async () => ({
      async searchPeople(filters: Record<string, unknown>) {
        return filters.contact_email_status ? { people: [], totalEntries: 10 } : { people: [], totalEntries: 50 };
      },
      async bulkEnrich() {
        return [];
      },
      async countOrganizations(filters: Record<string, unknown>) {
        counted++;
        expect(filters).toMatchObject({ organization_locations: ["United Kingdom"] });
        return 321;
      },
    }));
    features.analysisStream = true;
    features.accurateCompanyCount = true;
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    const run = (await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200)).body.data.analysisRun;
    const events = await stream(t.auth, run.id);
    expect(events.filter((e) => e.item?.kind === "count").map((e) => e.item!.companiesTotal)).toEqual([321, 321]);
    expect(counted).toBe(2);
  });

  it("keeps the single request when the stream is switched off", async () => {
    fakes();
    const t = await createTenant({ subscribed: false });
    await api().post("/api/v1/onboarding/start").set(t.auth).send({ domain: "northwind.io" });
    const res = await api().post("/api/v1/onboarding/analysis").set(t.auth).expect(200);
    expect(res.body.data).toMatchObject({ analysisStream: false, analysisRun: null });
    expect(res.body.data.onboarding.groups).toHaveLength(2);
    expect(await prisma.analysisRun.count()).toBe(0);
  });
});
