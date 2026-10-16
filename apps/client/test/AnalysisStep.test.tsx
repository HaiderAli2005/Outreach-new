import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnalysisStep, sizeLabel, sizeRange } from "@/components/onboarding/AnalysisStep";
import type { BuyerGroup } from "@/lib/types";
import { json, onboardingState } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

afterEach(() => vi.unstubAllGlobals());

const group = (over: Partial<BuyerGroup>): BuyerGroup => ({
  id: "seg_1",
  priority: 1,
  name: "UK agencies",
  description: "Small UK marketing agencies",
  why: "They chase late invoices",
  goals: ["Get paid on time"],
  pains: ["Late payments"],
  objections: ["We use spreadsheets"],
  titles: ["Founder", "Managing Director"],
  includeSimilarTitles: true,
  seniorities: ["founder", "c_suite"],
  sizes: ["11,50", "5001,"],
  regions: ["United Kingdom"],
  keywords: ["marketing agency"],
  keywordSuggestions: ["design studio"],
  revenueRange: { min: null, max: null },
  technologies: [],
  signals: { hiringForTitles: [], headcountGrowthPctMin: null, recentlyFunded: false },
  lookalikeDomains: [],
  excludeDomains: ["northwind.io"],
  on: true,
  ...over,
});

const analysis = {
  promptVersion: "analysis-prompt-v1",
  source: "site" as const,
  confidence: 0.82,
  lowConfidence: false,
  warning: "Sells mostly to consumers",
  repairsMade: [],
  brandDetail: {
    company_name: "Northwind",
    one_liner: "Invoicing for agencies",
    offerings: ["Invoicing", "Reminders"],
    business_model: "B2B" as const,
    customer_types: ["Agencies"],
    customer_size_hint: null,
    geographies: ["United Kingdom"],
    price_level: "From £49 a month",
    proof: [{ text: "Used by 200 agencies", source: "/customers" }],
    differentiators: [{ text: "Automatic reminders", source: "https://northwind.io/services" }],
    named_customers: ["Brightlabs"],
    buyer_titles_seen: [],
    competitors: [],
    language: "en",
    brand_voice: "",
    confidence: 0.82,
    evidence: [],
  },
};

describe("analysis step", () => {
  it("shows the warning, what was found with sources, and audiences in priority order", () => {
    mockServer({});
    const base = onboardingState().onboarding!;
    const state = onboardingState({
      aiAvailable: true,
      onboarding: {
        ...base,
        analyzedAt: new Date().toISOString(),
        facts: [{ key: "company", label: "Company name", value: "Northwind", source: "from your site" }],
        groups: [group({ id: "seg_2", priority: 2, name: "Design studios", titles: ["Studio Director"] }), group({})],
        analysis,
      },
    });
    renderWithStore(<AnalysisStep state={state} market={undefined} setNextDisabled={vi.fn()} />);
    expect(screen.getByRole("note")).toHaveTextContent("Sells mostly to consumers");
    // Sources read as a page on their own site, without the model's confidence score.
    expect(screen.queryByText(/Confidence/)).not.toBeInTheDocument();
    expect(screen.getByText("Automatic reminders").closest(".fact")).toHaveTextContent("found on /services");
    expect(screen.getByText("Brightlabs")).toBeInTheDocument();
    const cards = screen.getAllByRole("article");
    expect(within(cards[0]).getByRole("heading", { level: 3 })).toHaveTextContent("UK agencies");
    expect(cards[0]).toHaveTextContent("Run first");
    expect(cards[1]).toHaveTextContent("Priority 2");
    expect(cards[0]).toHaveTextContent("Founder, C-suite");
    // Size bands read as one line; touching bands merge.
    expect(cards[0]).toHaveTextContent("11 to 50, 5,001+ employees");
    expect(within(cards[0]).getByRole("heading", { name: "Why they buy" }).nextElementSibling).toHaveTextContent("They chase late invoices");
  });

  const analysed = (groups: BuyerGroup[]) => {
    const base = onboardingState().onboarding!;
    return onboardingState({ aiAvailable: true, onboarding: { ...base, analyzedAt: new Date().toISOString(), facts: [], groups, analysis } });
  };

  it("shows keyword chips with counts, flags keywords that match nothing or barely narrow, and adds a suggestion", async () => {
    const counts = {
      available: true,
      reason: null,
      groupId: "seg_1",
      baseline: 20000,
      keywords: [
        { keyword: "marketing agency", count: 12400, state: "ok" },
        { keyword: "pr firm", count: 0, state: "none" },
        { keyword: "media", count: 15000, state: "broad" },
      ],
    };
    const { calls } = mockServer({
      "GET /onboarding/keywords": () => json({ data: counts }),
      "PATCH /onboarding": (body) => json({ data: analysed([group({ keywords: [...(body as { groups: { keywords: string[] }[] }).groups[0].keywords], keywordSuggestions: [] })]) }),
    });
    renderWithStore(<AnalysisStep state={analysed([group({ keywords: ["marketing agency", "pr firm", "media"] })])} market={undefined} setNextDisabled={vi.fn()} />);
    const card = screen.getByRole("article");
    expect(await within(card).findByText("12.4K")).toBeInTheDocument();
    expect(within(card).getByText("pr firm").closest(".kw")).toHaveClass("none");
    expect(within(card).getByText("media").closest(".kw")).toHaveClass("broad");
    expect(card).toHaveTextContent('"pr firm" matches no companies here.');
    // A broad keyword is a quiet note, not a warning: it still finds the right people.
    expect(card).toHaveTextContent('"media" fits most of this audience already');
    expect(card).toHaveTextContent("Adding a keyword makes this audience bigger.");
    expect(within(card).getByText("marketing agency").closest("details")).toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: "Add design studio" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ groups: [{ id: "seg_1", keywords: ["marketing agency", "pr firm", "media", "design studio"] }] }));
  });

  it("keeps at least one keyword, refuses a sixth and shows the server's reason for a bad keyword", async () => {
    mockServer({
      "GET /onboarding/keywords": () => json({ data: { available: false, reason: "not-connected", groupId: "seg_1", baseline: null, keywords: [] } }),
      "PATCH /onboarding": () => json({ error: { code: "BAD_REQUEST", message: '"billing" describes what you sell, so it would find your competitors, not your customers.' } }, 400),
    });
    const one = renderWithStore(<AnalysisStep state={analysed([group({})])} market={undefined} setNextDisabled={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove marketing agency" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Keep at least one keyword");
    await userEvent.type(screen.getByLabelText("Add a keyword to UK agencies"), "Billing{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent('"billing" describes what you sell');
    one.unmount();

    renderWithStore(<AnalysisStep state={analysed([group({ keywords: ["a", "b", "c", "d", "e"] })])} market={undefined} setNextDisabled={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Add a keyword to UK agencies"), "retail{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("An audience can have up to 5 keywords. Remove one first, or split this audience.");
  });

  it("asks the three questions when the site gave too little to go on", () => {
    mockServer({});
    const base = onboardingState().onboarding!;
    renderWithStore(
      <AnalysisStep state={onboardingState({ aiAvailable: true, onboarding: { ...base, siteReadable: true, analysisError: "low-confidence", analysis: { ...analysis, lowConfidence: true, confidence: 0.3 } } })} market={undefined} setNextDisabled={vi.fn()} />,
    );
    expect(screen.getByText("Not enough on the site")).toBeInTheDocument();
    expect(screen.getByText("Question 1 of 3")).toBeInTheDocument();
    // What the site did say is filled in, so the first answer is already there.
    expect(screen.getByLabelText("What do you sell?")).toHaveValue(analysis.brandDetail.one_liner);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByLabelText("Who buys it?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText("Tell us who buys it.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Who buys it?"), { target: { value: "Shop owners" } });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText("Question 3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "United Arab Emirates" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Build my audience/ })).toBeInTheDocument();
  });

  it("merges touching company size bands", () => {
    expect(sizeRange(["51,200", "11,50", "201,500", "501,1000", "1001,5000"])).toBe("11 to 5,000 employees");
    expect(sizeRange(["1,10", "51,200"])).toBe("1 to 10, 51 to 200 employees");
    expect(sizeRange(["1001,5000", "5001,"])).toBe("1,001+ employees");
  });

  it("labels company sizes", () => {
    expect(sizeLabel("1,10")).toBe("1 to 10");
    expect(sizeLabel("1001,5000")).toBe("1,001 to 5,000");
    expect(sizeLabel("5001,")).toBe("5,001+");
  });
});
