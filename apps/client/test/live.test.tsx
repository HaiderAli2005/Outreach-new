import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyRun, parseSse, runReducer, useRunStream, type RunEvent, type RunState } from "@/components/onboarding/live/run";
import { EmailsPanel, LiveAnalysis } from "@/components/onboarding/live/LiveAnalysis";
import { Rail, LiveLog } from "@/components/onboarding/live/Rail";
import { DockProvider, Typewriter } from "@/components/onboarding/live/motion";
import { railCards } from "@/components/onboarding/live/cards";
import { onboardingState } from "./fixtures";
import { renderWithStore } from "./render";

afterEach(() => vi.unstubAllGlobals());

const events: RunEvent[] = [
  { seq: 1, type: "run.start", analysisId: "r1", domain: "northwind.io", steps: ["fetch", "extract", "analyse", "validate", "size", "write"] },
  { seq: 2, type: "step.start", step: "fetch", label: "Reading your website" },
  { seq: 3, type: "step.log", step: "fetch", text: "reading your homepage", state: "running" },
  { seq: 4, type: "item.found", step: "fetch", item: { kind: "page", url: "/", words: 120 } },
  { seq: 5, type: "step.log", step: "fetch", text: "reading your homepage", state: "done" },
  { seq: 6, type: "step.done", step: "fetch", summary: { pages: 1 } },
  { seq: 7, type: "step.start", step: "analyse", label: "Understanding" },
  { seq: 8, type: "item.found", step: "analyse", item: { kind: "fact", text: "Invoicing for agencies", source: "/services" } },
  { seq: 9, type: "item.found", step: "analyse", item: { kind: "audience", id: "seg_1", name: "UK agencies", icon: "agency" } },
  { seq: 10, type: "item.found", step: "analyse", item: { kind: "keyword", audienceId: "seg_1", word: "marketing agency" } },
  { seq: 11, type: "item.found", step: "analyse", item: { kind: "keyword", audienceId: "seg_1", word: "pr firm", suggestion: true } },
  { seq: 12, type: "item.found", step: "size", item: { kind: "count", audienceId: "seg_1", total: 1200, reachable: 400, companiesInSample: 2, companiesTotal: null } },
  { seq: 13, type: "item.found", step: "size", item: { kind: "person", audienceId: "seg_1", firstName: "Sam", lastNameMasked: "P***", title: "Founder", company: "Acme", country: "United Kingdom", hasEmail: true } },
  { seq: 14, type: "item.found", step: "write", item: { kind: "draft", step: 1, subject: "Late invoices", bodyChunk: "Hi there" } },
];

const fold = (list: RunEvent[]) => list.reduce(runReducer, emptyRun);

describe("run stream", () => {
  it("parses Server-Sent Events and keeps a partial block for the next chunk", () => {
    const { events: out, rest } = parseSse('id: 1\ndata: {"type":"run.done","seq":1}\n\ndata: {"type":"heart');
    expect(out).toEqual([{ type: "run.done", seq: 1 }]);
    expect(rest).toBe('data: {"type":"heart');
    expect(parseSse(`${rest}beat"}\n\n`).events).toEqual([{ type: "heartbeat" }]);
  });

  it("builds the run from events, merges a finished log line and ignores replayed events", () => {
    const s = fold([...events, ...events.slice(0, 6)]);
    expect(s.lastSeq).toBe(14);
    expect(s.stepState).toMatchObject({ fetch: "done", analyse: "running", write: "waiting" });
    expect(s.logs).toEqual([{ step: "fetch", text: "reading your homepage", state: "done" }]);
    expect(s.pages).toEqual([{ kind: "page", url: "/", words: 120 }]);
    expect(s.audiences[0]).toMatchObject({ id: "seg_1", keywords: ["marketing agency"], suggestions: ["pr firm"], count: { total: 1200, reachable: 400 } });
    expect(s.people[0].lastNameMasked).toBe("P***");
    expect(s.drafts).toEqual([{ step: 1, subject: "Late invoices", body: "Hi there", tab: undefined, day: undefined }]);
    const failed = runReducer(s, { seq: 15, type: "run.error", step: "analyse", code: "ai-failed", message: "No credit left", recoverable: true });
    expect(failed.error).toEqual({ step: "analyse", code: "ai-failed", message: "No credit left", recoverable: true });
  });

  it("follows the stream with the auth header, then resumes from the last event after a drop", async () => {
    const enc = new TextEncoder();
    const body = (chunks: string[]) =>
      new ReadableStream({
        start(c) {
          for (const x of chunks) c.enqueue(enc.encode(x));
          c.close();
        },
      });
    const urls: string[] = [];
    const heads: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push(url);
        heads.push(new Headers(init.headers).get("authorization"));
        if (urls.length === 1) return new Response(body(['data: {"seq":1,"type":"run.start","steps":["fetch"]}\n\n', 'data: {"seq":2,"type":"step.start","step":"fetch","label":"Reading"}\n\n']), { status: 200 });
        return new Response(body(['data: {"seq":3,"type":"step.done","step":"fetch","summary":{}}\n\ndata: {"seq":4,"type":"run.done"}\n\n']), { status: 200 });
      }),
    );
    let latest: RunState = emptyRun;
    function Probe() {
      latest = useRunStream("/analyses/r1/stream").run;
      return null;
    }
    const { store } = renderWithStore(<Probe />);
    void store;
    await waitFor(() => expect(latest.done).toBe(true), { timeout: 4000 });
    expect(urls[0]).toBe("/api/v1/analyses/r1/stream?from=0");
    expect(urls[1]).toBe("/api/v1/analyses/r1/stream?from=2");
    expect(latest.stepState.fetch).toBe("done");
  });
});

const reducedMotion = () =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));

const fullRun: RunEvent[] = [
  { seq: 1, type: "run.start", analysisId: "r1", domain: "northwind.io", steps: ["fetch", "extract", "analyse", "validate", "size", "write"] },
  { seq: 2, type: "step.start", step: "fetch", label: "Reading" },
  { seq: 3, type: "item.found", step: "fetch", item: { kind: "page", url: "/pricing", words: 120 } },
  { seq: 4, type: "step.done", step: "fetch", summary: { pages: 1 } },
  { seq: 5, type: "step.done", step: "extract", summary: {} },
  { seq: 6, type: "item.found", step: "analyse", item: { kind: "audience", id: "seg_1", name: "UK agencies", icon: "agency", why: "They chase late invoices", pains: ["Late payments", "Manual reminders"] } },
  { seq: 7, type: "item.found", step: "analyse", item: { kind: "keyword", audienceId: "seg_1", word: "marketing agency" } },
  { seq: 8, type: "step.done", step: "analyse", summary: { company: "Northwind", oneLiner: "Invoicing for agencies", country: "United Kingdom", language: "en", offerings: ["Invoicing"], proof: [{ text: "Used by 200 agencies", source: "/customers" }] } },
  { seq: 9, type: "step.done", step: "validate", summary: {} },
  { seq: 10, type: "item.found", step: "size", item: { kind: "count", audienceId: "seg_1", total: 1200, reachable: 400, companiesInSample: 0, companiesTotal: null } },
  { seq: 11, type: "item.found", step: "size", item: { kind: "person", audienceId: "seg_1", firstName: "Sam", lastNameMasked: "P***", title: "Founder", company: "Acme", country: null, hasEmail: true } },
  { seq: 12, type: "step.done", step: "size", summary: { available: true, people: 1200, reachable: 400, sampleSize: 1, breakdowns: { byCountry: [], bySize: [], bySeniority: [["Founder or C-level", 1]] } } },
  { seq: 13, type: "item.found", step: "write", item: { kind: "draft", step: 1, subject: "Late invoices at {{company}}", bodyChunk: "Hi {{first_name}}, quick one." } },
  { seq: 14, type: "step.done", step: "write", summary: { available: true } },
  { seq: 15, type: "run.done" },
];

describe("live analysis", () => {
  it("shows only the reading phase first, with page paths and no word counts", () => {
    render(
      <DockProvider>
        <LiveAnalysis domain="northwind.io" run={fold(events.slice(0, 5))} onFinished={vi.fn()} audience={null} brand="Northwind" />
      </DockProvider>,
    );
    expect(document.querySelectorAll(".ph-panel")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Reading your site");
    expect(screen.getByText("northwind.io")).toBeInTheDocument();
    expect(screen.getByLabelText("Pages read").querySelectorAll("li")).toHaveLength(6);
    expect(screen.queryByText(/words/)).not.toBeInTheDocument();
  });

  it("plays one phase at a time, skips the one with no data, keeps the phase in the URL and finishes after the email", async () => {
    reducedMotion();
    const phases: string[] = [];
    const onFinished = vi.fn();
    render(
      <DockProvider>
        <LiveAnalysis domain="northwind.io" run={fold(fullRun)} onFinished={onFinished} onPhase={(p) => phases.push(p)} audience={null} brand="Northwind" />
      </DockProvider>,
    );
    const seen = new Set<number>();
    const check = setInterval(() => seen.add(document.querySelectorAll(".ph-panel").length), 20);
    await waitFor(() => expect(onFinished).toHaveBeenCalled(), { timeout: 15000 });
    clearInterval(check);
    expect([...seen]).toEqual([1]);
    expect(phases).toEqual(["reading", "business", "audiences", "market", "people", "emails"]);
    expect(screen.getByText("Sam P***")).toBeInTheDocument();
    expect(document.querySelector(".em-subj")).toHaveTextContent("Late invoices at Acme");
    expect(document.querySelector(".em-text")).toHaveTextContent("Hi Sam, quick one.");
    expect(document.querySelector(".lead-res")).toHaveTextContent("on file, unlocks at launch");
  }, 20000);

  it("resumes at the phase in the URL instead of replaying from the start", () => {
    reducedMotion();
    render(
      <DockProvider>
        <LiveAnalysis domain="northwind.io" run={fold(fullRun.slice(0, 12))} onFinished={vi.fn()} initialPhase="market" audience={null} brand="Northwind" />
      </DockProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your market");
    expect(document.querySelector(".mk-big")).toHaveTextContent("1,200");
  });

  it("reports an error and hands back to the step so it can offer the three questions", async () => {
    const onFinished = vi.fn();
    const run = runReducer(fold(events.slice(0, 6)), { seq: 7, type: "run.error", step: "fetch", code: "site-unreadable", message: "We couldn't read northwind.io.", recoverable: true });
    render(
      <DockProvider>
        <LiveAnalysis domain="northwind.io" run={run} onFinished={onFinished} audience={null} brand="Northwind" />
      </DockProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't read northwind.io.");
    await waitFor(() => expect(onFinished).toHaveBeenCalled(), { timeout: 3000 });
  });

  it("lets a lead be kept or removed, with an undo", async () => {
    render(
      <EmailsPanel
        leads={[
          { key: "a", firstName: "Sam", lastMasked: "P***", title: "Founder", company: "Acme", hasEmail: true },
          { key: "b", firstName: "Jo", lastMasked: "R***", title: "CEO", company: "Brightlabs", hasEmail: false },
        ]}
        drafts={[{ subject: "Hi {{first_name}}", body: "Body for {{company}}" }]}
        animate={false}
        writing={false}
        brand="Northwind"
       
      />,
    );
    expect(document.querySelector(".em-text")).toHaveTextContent("Body for Acme");
    await userEvent.click(screen.getByRole("button", { name: "Preview the email to Jo R***" }));
    expect(document.querySelector(".em-text")).toHaveTextContent("Body for Brightlabs");
    expect(screen.getAllByText("no email found")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Keep Sam" }));
    expect(screen.getByRole("button", { name: "Keep Sam" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Remove Jo from the preview" }));
    expect(screen.queryByText("Jo R***")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Removed Jo R*** from the preview.");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Jo R***")).toBeInTheDocument();
  });

  it("types at 40 characters a second and reveals the rest after 6 seconds", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
    const done = vi.fn();
    const { container, unmount } = render(<Typewriter text={"x".repeat(400)} onDone={done} />);
    await act(async () => vi.advanceTimersByTime(500));
    const typed = container.querySelector("span > span")!.textContent!.length;
    expect(typed).toBeGreaterThanOrEqual(15);
    expect(typed).toBeLessThanOrEqual(25);
    expect(container.querySelector(".lv-caret")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(6000));
    expect(container.querySelector("span > span")!.textContent).toHaveLength(400);
    expect(done).toHaveBeenCalled();
    unmount();
    vi.useRealTimers();
  });
});

describe("rail", () => {
  it("lists what has been decided, reopens a step on click, and shows the live log and running total", async () => {
    const onOpen = vi.fn();
    render(
      <DockProvider>
        <Rail
          cards={[
            { key: "domain", icon: "globe", title: "Your domain", detail: "northwind.io" },
            { key: "business", icon: "building", title: "Your business", detail: "Northwind · Invoicing", chips: ["United Kingdom", "English"], step: 1 },
            { key: "market", icon: "target", title: "Your market", detail: "1,200 match · 400 reachable", warn: "A niche market.", step: 2 },
            { key: "buyers", icon: "users", title: "Your buyers", detail: "1 audience", step: 2 },
          ]}
          hidden={new Set(["buyers"])}
          active={new Set(["market"])}
          onOpen={onOpen}
          log={{ lines: [{ step: "size", text: "sizing audience 1 of 2", state: "done" }, { step: "size", text: "sizing audience 2 of 2", state: "running" }], stepIndex: 5, stepCount: 6, connection: "live" }}
          total={{ label: "Daily budget", value: "$20/day", note: "$0.04 an email, prepaid." }}
          domain="northwind.io"
        />
      </DockProvider>,
    );
    expect(screen.queryByText("Your buyers")).not.toBeInTheDocument();
    // Decisions sit under the same numbered steps as the top bar.
    const steps = screen.getAllByRole("listitem").filter((li) => li.classList.contains("rc-step"));
    expect(steps.map((li) => li.querySelector(".rc-gh")!.textContent)).toEqual(["Step 1 · DomainStep complete", "Step 3 · AnalysisStep complete", "Step 4 · Free overviewIn progress"]);
    expect(screen.queryByText(/step 5 ·/)).not.toBeInTheDocument();
    // The domain is a record, not a link.
    expect(screen.queryByRole("button", { name: /Your domain/ })).not.toBeInTheDocument();
    // Every finished row ends with its tick.
    const market = screen.getByText("Your market").closest("li")!;
    expect(market).toHaveClass("cur");
    expect(market.querySelector(".rc-row > :last-child .rc-tick")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Your market: 1,200 match · 400 reachable/ }));
    expect(onOpen).toHaveBeenCalledWith(2, "market");
    expect(screen.getByText("A niche market.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show Your business details" }));
    expect(screen.getByText("United Kingdom")).toBeInTheDocument();
    const log = screen.getByLabelText("What is happening now");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveTextContent("Analysis in progress · 5 of 6");
    expect(log).toHaveTextContent("Done: sizing audience 1 of 2");
    expect(log).toHaveTextContent("In progress: sizing audience 2 of 2");
    expect(screen.getByLabelText("Cost")).toHaveTextContent("Daily budget");
  });

  it("holds the detail when expanded: facts with sources, competitors, and audiences you can pick", async () => {
    const onSelect = vi.fn();
    render(
      <DockProvider>
        <Rail
          cards={[
            { key: "domain", icon: "globe", title: "Your domain", detail: "northwind.io" },
            { key: "business", icon: "building", title: "Your business", detail: "Northwind", facts: [{ text: "Used by 200 agencies", source: "/customers" }], competitors: ["rival.com"], step: 1 },
            { key: "buyers", icon: "users", title: "Your buyers", detail: "2 audiences", audiences: [{ id: "seg_1", name: "UK agencies", icon: "megaphone", count: 1200 }, { id: "seg_2", name: "Studios", icon: "users", count: null }], step: 2 },
          ]}
          hidden={new Set()}
          active={new Set()}
          onOpen={vi.fn()}
          log={{ lines: ["a", "b", "c", "d", "e", "f"].map((t) => ({ step: "size", text: t, state: "done" as const })), stepIndex: 5, stepCount: 6, connection: "live" }}
          total={null}
          domain="northwind.io"
          selected="seg_2"
          onSelect={onSelect}
        />
      </DockProvider>,
    );
    expect(screen.getByLabelText("What is happening now").querySelectorAll("li")).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "Show Your business details" }));
    expect(screen.getByText("Used by 200 agencies").closest("li")).toHaveTextContent("found on /customers");
    expect(screen.getByText("rival.com")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show Your buyers details" }));
    expect(screen.getByRole("button", { name: /Studios/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /UK agencies/ }));
    expect(onSelect).toHaveBeenCalledWith("seg_1");
    await userEvent.click(screen.getByRole("button", { name: /Studios/ }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("says when the stream is reconnecting", () => {
    render(<LiveLog log={{ lines: [], stepIndex: 1, stepCount: 6, connection: "reconnecting" }} />);
    expect(screen.getByLabelText("What is happening now")).toHaveTextContent("Reconnecting, nothing is lost");
  });

  it("builds cards from the saved setup, never showing a market count it doesn't have", () => {
    const base = onboardingState().onboarding!;
    const state = onboardingState({
      onboarding: {
        ...base,
        analyzedAt: new Date().toISOString(),
        facts: [{ key: "company", label: "Company name", value: "Northwind", source: "from your site" }],
        groups: [{ ...(base.groups[0] ?? {}), id: "seg_1", priority: 1, name: "Marketing agencies", keywords: ["marketing agency"], on: true } as never],
        preview: [{ tab: "Intro", day: "Day 1", subject: "a", body: "b" }],
      },
    });
    const cards = railCards({ state, run: emptyRun, live: false, market: { available: false, reason: "not-connected", groups: [], people: null, verified: null, sample: { size: 0, byCountry: [], bySize: [], bySeniority: [] }, prospects: [], checkedAt: "" }, draft: null, max: 2, docked: {}, setupDone: false, email: "ali@northwind.io" });
    expect(cards.map((c) => [c.key, c.detail])).toEqual([
      ["domain", state.onboarding!.domain],
      ["account", "ali@northwind.io"],
      ["business", "Northwind"],
      ["buyers", "1 audience"],
      ["market", "Lead search not connected yet"],
      ["sequence", "1 email"],
    ]);
  });

  it("adds sample prospects and the confirmed audiences once the preview is left", () => {
    const base = onboardingState().onboarding!;
    const group = (id: string, on: boolean) => ({ ...(base.groups[0] ?? {}), id, priority: 1, name: `Group ${id}`, keywords: [], on }) as never;
    const state = onboardingState({
      onboarding: { ...base, analyzedAt: new Date().toISOString(), groups: [group("a", true), group("b", true), group("c", true), group("d", false)], preview: [1, 2, 3].map(() => ({ tab: "x", day: "Day 1", subject: "s", body: "b" })) },
    });
    const prospect = { firstName: "Ali", lastInitial: "K", title: "Owner", company: "Hilal", country: "Pakistan", hasEmail: true };
    const market = { available: true, reason: null, groups: [], people: 22240, verified: 14597, sample: { size: 12, byCountry: [], bySize: [], bySeniority: [] }, prospects: Array.from({ length: 12 }, () => prospect), checkedAt: "" };
    const cards = railCards({ state, run: emptyRun, live: false, market, draft: null, max: 3, docked: {}, setupDone: false, email: null });
    expect(cards.map((c) => [c.key, c.detail])).toEqual([
      ["domain", base.domain],
      ["business", base.brand],
      ["buyers", "4 audiences"],
      ["market", "22,240 match · 14,597 reachable"],
      ["prospects", "12 people"],
      ["sequence", "3 emails"],
      ["confirmed", "3 on, 1 off"],
    ]);
  });
});

describe("right-to-left content", () => {
  it("shows an Urdu email right to left even when it starts with a Latin name", () => {
    render(
      <EmailsPanel
        leads={[{ key: "a", firstName: "Usman", lastMasked: "K***", title: "Owner", company: "Metro Mart", hasEmail: true }]}
        drafts={[{ subject: "اسٹاک کا حساب", body: "{{first_name}} صاحب، آپ کی ہر برانچ کا اسٹاک الگ کیوں ہے؟" }]}
        animate={false}
        writing={false}
        brand="eKhata"
       
        language="ur"
      />,
    );
    const body = document.querySelector(".em-body")!;
    expect(body).toHaveAttribute("dir", "rtl");
    expect(body).toHaveAttribute("lang", "ur");
    expect(body).toHaveTextContent("Usman صاحب");
  });

  it("lets the browser pick the direction when the language is not known to be right to left", () => {
    render(<EmailsPanel leads={[]} drafts={[{ subject: "Hello", body: "Hi {{first_name}}" }]} animate={false} writing={false} brand="Northwind" language="en" />);
    expect(document.querySelector(".em-body")).toHaveAttribute("dir", "auto");
  });
});
