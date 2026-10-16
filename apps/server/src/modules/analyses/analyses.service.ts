import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { notFound } from "../../lib/errors.js";
import { features } from "../../config/env.js";
import { getAi, requireAi } from "../../integrations/ai.js";
import { sourceFor } from "../onboarding/grounding.js";
import { analyzeCore, aiErrorReason, market, preview, type BuyerGroup } from "../onboarding/onboarding.service.js";
import { normalizeDomain, type Analysis } from "../onboarding/analysisValidate.js";
import { EventWriter, STEP_KEYS, keepAlive, runBus, sseHeaders, sseWrite, type StepKey } from "./events.js";

export const STEP_LABELS: Record<StepKey, string> = {
  fetch: "Reading your website",
  extract: "Picking up signals from your site",
  analyse: "Understanding what you sell and who buys it",
  validate: "Checking your audiences against the search rules",
  size: "Sizing your market",
  write: "Writing your sample emails",
};

/** A running job touches its run this often, so any server can tell a live run from one a restart cut off. */
export const HEARTBEAT_MS = 5_000;
/** A run not owned by this process with no heartbeat or event for this long is treated as interrupted. */
export const STALE_MS = 20_000;
const LIVE_COMPANIES = 8;
const LIVE_PEOPLE = 6;

const jobs = new Map<string, Promise<void>>();
/** The event writer of each run this process is working on, so shutdown can end them in order. */
const owned = new Map<string, { ev: EventWriter; step: () => StepKey }>();

/** Resolves when a run started in this process has finished. For tests and graceful shutdown. */
export function waitForRun(runId: string): Promise<void> {
  return jobs.get(runId) ?? Promise.resolve();
}

export type RunView = { id: string; status: "RUNNING" | "DONE" | "FAILED"; lastSeq: number; createdAt: Date; domain: string };

export async function latestRun(orgId: string, domain: string): Promise<RunView | null> {
  const run = await prisma.analysisRun.findFirst({ where: { organizationId: orgId, domain }, orderBy: { createdAt: "desc" } });
  if (!run) return null;
  return { id: run.id, status: run.status, lastSeq: run.lastSeq, createdAt: run.createdAt, domain: run.domain };
}

async function isStale(runId: string): Promise<boolean> {
  if (jobs.has(runId)) return false;
  const last = await prisma.analysisEvent.findFirst({ where: { analysisId: runId }, orderBy: { seq: "desc" }, select: { createdAt: true } });
  const run = await prisma.analysisRun.findUnique({ where: { id: runId }, select: { createdAt: true, updatedAt: true } });
  const at = Math.max(last?.createdAt.getTime() ?? 0, run?.updatedAt.getTime() ?? 0, run?.createdAt.getTime() ?? 0);
  return Date.now() - at > STALE_MS;
}

/** On shutdown: ends the runs this process owns, so the next page load starts a fresh one straight away. */
export async function interruptActiveRuns(): Promise<void> {
  await Promise.all(
    [...owned.entries()].map(async ([runId, { ev, step }]) => {
      owned.delete(runId);
      ev.emit({ type: "run.error", step: step(), code: "interrupted", message: "The analysis stopped before it finished. Run it again.", recoverable: true });
      await ev.flush();
      await prisma.analysisRun
        .updateMany({ where: { id: runId, status: "RUNNING" }, data: { status: "FAILED", lastSeq: ev.lastSeq, error: "interrupted", finishedAt: new Date() } })
        .catch((err) => logger.warn({ err, runId }, "could not end run on shutdown"));
      runBus.emit(runId);
    }),
  );
}

async function markInterrupted(runId: string): Promise<void> {
  const run = await prisma.analysisRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== "RUNNING") return;
  const last = await prisma.analysisEvent.findFirst({ where: { analysisId: runId }, orderBy: { seq: "desc" } });
  const step = ((last?.payload as { step?: StepKey } | null)?.step ?? "fetch") as StepKey;
  const seq = (last?.seq ?? 0) + 1;
  await prisma.analysisEvent.create({
    data: { analysisId: runId, seq, type: "run.error", payload: { type: "run.error", step, code: "interrupted", message: "The analysis stopped before it finished. Run it again.", recoverable: true } },
  });
  await prisma.analysisRun.update({ where: { id: runId }, data: { status: "FAILED", lastSeq: seq, error: "interrupted", finishedAt: new Date() } });
  runBus.emit(runId);
}

/**
 * Starts a streamed analysis, or returns the one already running for this domain.
 * A reload never starts a second job, so it never spends a second provider call.
 */
export async function startAnalysisRun(orgId: string): Promise<RunView> {
  const o = await prisma.onboarding.findUnique({ where: { organizationId: orgId } });
  if (!o) throw notFound("Setup");
  requireAi();
  const current = await latestRun(orgId, o.domain);
  if (current?.status === "RUNNING") {
    if (!(await isStale(current.id))) return current;
    await markInterrupted(current.id);
  }
  const run = await prisma.analysisRun.create({ data: { organizationId: orgId, domain: o.domain } });
  const beat = setInterval(() => {
    prisma.analysisRun.updateMany({ where: { id: run.id, status: "RUNNING" }, data: { updatedAt: new Date() } }).catch(() => undefined);
  }, HEARTBEAT_MS);
  beat.unref();
  const job = runJob(run.id, orgId, o.domain)
    .catch((err) => logger.error({ err, runId: run.id }, "analysis run crashed"))
    .finally(() => {
      clearInterval(beat);
      jobs.delete(run.id);
    });
  jobs.set(run.id, job);
  return { id: run.id, status: run.status, lastSeq: 0, createdAt: run.createdAt, domain: run.domain };
}

const words = (text: string) => (text.match(/\S+/g) ?? []).length;

function pathOf(source: string, domain: string): string {
  try {
    const u = new URL(source);
    return normalizeDomain(u.hostname) === normalizeDomain(domain) ? u.pathname || "/" : source;
  } catch {
    return source || "/";
  }
}

/** A small hint the interface turns into an icon. Presentation only. */
export function audienceIcon(name: string, keywords: string[] = []): string {
  const t = `${name} ${keywords.join(" ")}`.toLowerCase();
  if (/retail|shop|store|ecommerce|e-commerce|grocery|kirana/.test(t)) return "store";
  if (/manufactur|factory|production|plant|industrial/.test(t)) return "factory";
  if (/account|finance|tax|bookkeep|audit|bank|fintech/.test(t)) return "finance";
  if (/wholesale|distribut|logistic|freight|import|export|trading|dealer|supply/.test(t)) return "logistics";
  if (/agency|marketing|growth|media|advertis/.test(t)) return "agency";
  if (/clinic|health|dental|medical|pharma|care/.test(t)) return "health";
  if (/saas|software|engineering|tech|ai\b|product/.test(t)) return "tech";
  if (/founder|owner|ceo|executive|leader/.test(t)) return "founder";
  return "people";
}

function factItems(a: Analysis, domain: string): { text: string; source: string }[] {
  const bd = a.brand_detail;
  // A fact names a page only when checked evidence from that page says it; otherwise it is a summary of the site.
  const from = (text: string) => {
    const src = sourceFor(text, bd.evidence);
    return src ? pathOf(src, domain) : "from your site";
  };
  const out: { text: string; source: string }[] = [];
  if (bd.company_name) out.push({ text: `Company: ${bd.company_name}`, source: "from your site" });
  if (bd.one_liner) out.push({ text: bd.one_liner, source: from(bd.one_liner) });
  for (const x of bd.offerings) out.push({ text: `Offers ${x}`, source: from(x) });
  if (bd.customer_types.length) out.push({ text: `Sells to ${bd.customer_types.join(", ")}`, source: from(bd.customer_types.join(" ")) });
  if (bd.geographies.length) out.push({ text: `Operates in ${bd.geographies.join(", ")}`, source: from(bd.geographies.join(" ")) });
  if (bd.price_level) out.push({ text: `Pricing: ${bd.price_level}`, source: from(bd.price_level) });
  for (const p of bd.proof) out.push({ text: p.text, source: pathOf(p.source, domain) });
  for (const d of bd.differentiators) out.push({ text: d.text, source: pathOf(d.source, domain) });
  if (bd.competitors.length) out.push({ text: `Competes with ${bd.competitors.join(", ")}`, source: "from your site" });
  return out;
}

export function parseRepair(r: string): { field: string; from: string | null; to: string | null; note: string } {
  const i = r.indexOf(": ");
  const field = i > 0 ? r.slice(0, i) : "";
  const rest = i > 0 ? r.slice(i + 2) : r;
  const arrow = rest.match(/^"(.*)" -> "(.*)"$/);
  if (arrow) return { field, from: arrow[1], to: arrow[2], note: "" };
  const quoted = rest.match(/"(.*?)"/);
  return { field, from: quoted ? quoted[1] : null, to: null, note: rest };
}

async function runJob(runId: string, orgId: string, domain: string): Promise<void> {
  const ev = new EventWriter(runId);
  let step = "fetch" as StepKey;
  owned.set(runId, { ev, step: () => step });
  const start = (k: StepKey) => {
    step = k;
    ev.emit({ type: "step.start", step: k, label: STEP_LABELS[k] });
  };
  const log = (text: string, state: "running" | "done" = "running") => ev.emit({ type: "step.log", step, text, state });
  const item = (k: StepKey, it: Record<string, unknown>) => ev.emit({ type: "item.found", step: k, item: it });
  const finish = async (status: "DONE" | "FAILED", error: string | null = null) => {
    owned.delete(runId);
    await ev.flush();
    // A run already ended on shutdown stays ended.
    await prisma.analysisRun.updateMany({ where: { id: runId, status: "RUNNING" }, data: { status, lastSeq: ev.lastSeq, error, finishedAt: new Date() } });
    runBus.emit(runId);
  };

  ev.emit({ type: "run.start", analysisId: runId, domain, steps: [...STEP_KEYS] });
  start("fetch");
  log("reading your homepage");
  const shown = new Set<string>();
  let homeDone = false;
  let result: Awaited<ReturnType<typeof analyzeCore>>;
  try {
    result = await analyzeCore(orgId, {
      site: {
        onRead: (path) => {
          if (path === "/" && !homeDone) {
            homeDone = true;
            log("reading your homepage", "done");
            log("reading your other pages");
          }
        },
        onPage: (p) => {
          if (shown.has(p.path)) return;
          shown.add(p.path);
          item("fetch", { kind: "page", url: p.path, words: words(p.text) });
        },
      },
      pages: (pages) => {
        for (const p of pages) if (!shown.has(p.path)) item("fetch", { kind: "page", url: p.path, words: words(p.text) });
        if (!homeDone) log("reading your homepage", "done");
        else log("reading your other pages", "done");
        ev.emit({ type: "step.done", step: "fetch", summary: { pages: pages.length } });
        if (pages.length) start("extract");
      },
      signals: (s) => {
        log("looking for country, language, prices and customers");
        if (s.country) item("extract", { kind: "signal", label: "Country", value: s.country, source: "domain and contact details" });
        if (s.language) item("extract", { kind: "signal", label: "Language", value: s.language, source: "page language" });
        if (s.currency) item("extract", { kind: "signal", label: "Currency", value: s.currency, source: "prices on the site" });
        if (s.named_customers.length) item("extract", { kind: "signal", label: "Customer logos", value: s.named_customers.join(", "), source: "logos on the site" });
        if (s.testimonial_titles.length) item("extract", { kind: "signal", label: "Buyer titles in testimonials", value: s.testimonial_titles.join(", "), source: "testimonials" });
        log("looking for country, language, prices and customers", "done");
        ev.emit({ type: "step.done", step: "extract", summary: { country: s.country, language: s.language, currency: s.currency } });
        start("analyse");
        log("working out what you sell and who buys it");
      },
      analysed: (r, stored) => {
        log("working out what you sell and who buys it", "done");
        for (const f of factItems(r.analysis, domain)) item("analyse", { kind: "fact", ...f });
        for (const a of r.analysis.target_audience) {
          item("analyse", { kind: "audience", id: a.id, name: a.name, icon: audienceIcon(a.name, a.keywords), description: a.description, why: a.why_they_buy, pains: a.pain_points.slice(0, 4), titles: a.titles, count: null });
          for (const w of a.keywords) item("analyse", { kind: "keyword", audienceId: a.id, word: w });
          for (const w of a.keyword_suggestions) item("analyse", { kind: "keyword", audienceId: a.id, word: w, suggestion: true });
        }
        const bd = r.analysis.brand_detail;
        ev.emit({
          type: "step.done",
          step: "analyse",
          summary: {
            company: bd.company_name,
            oneLiner: bd.one_liner,
            language: bd.language,
            country: bd.geographies[0] ?? null,
            geographies: bd.geographies,
            offerings: bd.offerings,
            proof: [...bd.proof, ...bd.differentiators].slice(0, 4).map((p) => ({ text: p.text, source: pathOf(p.source, domain) })),
            confidence: stored.confidence,
            audiences: r.analysis.target_audience.length,
            competitors: bd.competitors,
            warning: r.analysis.warning,
          },
        });
        start("validate");
        log("checking titles, countries and keywords");
        for (const rep of r.repairs) item("validate", { kind: "repair", ...parseRepair(rep) });
        log("checking titles, countries and keywords", "done");
        ev.emit({ type: "step.done", step: "validate", summary: { repairs: r.repairs.length, lowConfidence: stored.lowConfidence } });
      },
    });
  } catch (err) {
    const message = aiErrorReason(err).replace(/^AI analysis: /, "");
    const e = err as { status?: number; code?: string };
    ev.emit({ type: "run.error", step, code: e.code === "CONFLICT" ? "domain-changed" : step === "analyse" ? "ai-failed" : "failed", message, recoverable: true });
    await finish("FAILED", message.slice(0, 300));
    return;
  }

  if (result.outcome === "unreadable") {
    ev.emit({ type: "run.error", step: "fetch", code: "site-unreadable", message: `We couldn't read ${domain}. Answer three questions instead.`, recoverable: true });
    await finish("FAILED", "site-unreadable");
    return;
  }
  if (result.outcome === "low-confidence") {
    ev.emit({ type: "run.done", analysisId: runId, outcome: "low-confidence" });
    await finish("DONE");
    return;
  }

  start("size");
  let groups = 0;
  const sizing = new Set<number>();
  const view = await market(orgId, false, {
    groupStart: (_g, i, n) => {
      groups = n;
      sizing.add(i);
      log(`sizing audience ${i + 1} of ${n}`);
    },
    groupDone: (r) => {
      groups = r.total;
      if (!sizing.has(r.index)) log(`sizing audience ${r.index + 1} of ${r.total}`);
      item("size", { kind: "count", audienceId: r.group.id, total: r.count, reachable: r.verified, companiesInSample: r.companiesInSample, companiesTotal: r.companiesTotal });
      for (const c of r.companies.slice(0, LIVE_COMPANIES)) item("size", { kind: "company", audienceId: r.group.id, name: c.name, domain: c.domain, country: c.country, employees: c.employees, people: c.people, titles: c.titles });
      for (const p of r.people.slice(0, LIVE_PEOPLE))
        item("size", { kind: "person", audienceId: r.group.id, firstName: p.firstName, lastNameMasked: p.lastInitial ? `${p.lastInitial}***` : "***", title: p.title, company: p.company, country: p.country, hasEmail: p.hasEmail });
      log(`sizing audience ${r.index + 1} of ${r.total}`, "done");
    },
  });
  if (!view.available) log(view.reason === "not-connected" ? "lead search isn't connected, so market size is skipped" : "the lead search didn't answer", "done");
  ev.emit({ type: "step.done", step: "size", summary: { available: view.available, reason: view.reason, people: view.people, reachable: view.verified, audiences: groups, companiesInSample: view.companies.length, sampleSize: view.sample.size, breakdowns: { byCountry: view.sample.byCountry, bySize: view.sample.bySize, bySeniority: view.sample.bySeniority } } });

  start("write");
  if (!getAi()) {
    ev.emit({ type: "step.done", step: "write", summary: { available: false } });
  } else {
    log("writing your 3 sample emails");
    try {
      await preview(orgId, { email: (i, e) => item("write", { kind: "draft", step: i + 1, subject: e.subject, bodyChunk: e.body, tab: e.tab, day: e.day, sender: e.sender }) });
      log("writing your 3 sample emails", "done");
      ev.emit({ type: "step.done", step: "write", summary: { available: true, emails: 3 } });
    } catch (err) {
      log("writing your 3 sample emails", "done");
      ev.emit({ type: "step.done", step: "write", summary: { available: false, error: aiErrorReason(err).replace(/^AI preview: /, "") } });
    }
  }
  ev.emit({ type: "run.done", analysisId: runId, outcome: "ok" });
  await finish("DONE");
}

/**
 * Server-Sent Events for one run. Replays stored events after `from`, then follows new ones
 * until the run finishes. Reading never starts or repeats any work.
 */
export async function streamRun(req: Request, res: Response, orgId: string, runId: string, from: number): Promise<void> {
  const run = await prisma.analysisRun.findFirst({ where: { id: runId, organizationId: orgId }, select: { id: true } });
  if (!run) throw notFound("Analysis");
  sseHeaders(res);
  let last = from;
  let busy = false;
  let again = false;
  let ended = false;
  const poll = setInterval(() => void pump(), 1000);
  const stop = keepAlive(req, res, () => {
    ended = true;
    clearInterval(poll);
    runBus.off(runId, wake);
  });
  const wake = () => void pump();
  runBus.on(runId, wake);

  async function pump(): Promise<void> {
    if (ended) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        const events = await prisma.analysisEvent.findMany({ where: { analysisId: runId, seq: { gt: last } }, orderBy: { seq: "asc" }, take: 500 });
        for (const e of events) {
          if (ended) return;
          sseWrite(res, { ...(e.payload as object), seq: e.seq }, e.seq);
          last = e.seq;
        }
        if (events.length === 500) again = true;
      } while (again && !ended);
      const r = await prisma.analysisRun.findUnique({ where: { id: runId }, select: { status: true, lastSeq: true } });
      if (r?.status === "RUNNING" && (await isStale(runId))) {
        await markInterrupted(runId);
        again = true;
      } else if (r && r.status !== "RUNNING" && last >= r.lastSeq && !ended) {
        stop();
        res.end();
      }
    } catch (err) {
      logger.warn({ err, runId }, "analysis stream read failed");
    } finally {
      busy = false;
    }
    if (again && !ended) void pump();
  }

  await pump();
}
