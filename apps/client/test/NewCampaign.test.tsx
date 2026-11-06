import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NewCampaignPage from "@/app/app/campaigns/new/page";
import { sessionReceived } from "@/store/authSlice";
import { json, session } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/app/campaigns/new", useRouter: () => ({ push, replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

const targeting = { groups: [{ id: "g1", name: "Agency ops", description: "", on: true, titles: [], keywords: [], keywordSuggestions: [], sizes: [], regions: [], matching: null, reachable: null, queued: 0 }], matching: null, reachable: null, countedAt: null, sizeOptions: [], launched: true };

describe("New campaign", () => {
  it("creates an owners campaign from a pasted keyword list and opens it", async () => {
    const { calls } = mockServer({
      "GET /setup/targeting": () => json({ data: targeting }),
      "POST /setup/targeting/audiences": () => json({ data: { id: "c9", name: "Engineering offices" } }),
      "POST /setup/targeting/audiences/preview": () => json({ data: { ready: true, reason: null, count: 1849, people: [{ firstName: "Omar", lastInitial: "S", title: "Founder", company: "Najd Engineering", country: null, hasEmail: true }] } }),
    });
    const { store } = renderWithStore(<NewCampaignPage />);
    store.dispatch(sessionReceived(session));
    await userEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(screen.getByText("Give the campaign a name.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/setup/targeting/audiences")).toBe(false);

    await userEvent.type(screen.getByLabelText("Name"), "Engineering offices");
    const kw = screen.getByLabelText("Add to Industry keywords");
    fireEvent.paste(kw, { clipboardData: { getData: () => "engineering consultancy, architecture, mep design" } });
    await userEvent.type(screen.getByLabelText("Add to Locations"), "Saudi Arabia{Enter}");
    // The card on the right fills in as the form changes, with the live count and real people.
    expect(await screen.findByText("1,849", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("Founder at Najd Engineering")).toBeInTheDocument();
    expect(screen.getAllByText("Engineering offices").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/campaign/c9"));
    expect(calls.find((c) => c.path === "/setup/targeting/audiences")?.body).toEqual({
      name: "Engineering offices",
      description: "",
      why: "",
      keywords: ["engineering consultancy", "architecture", "mep design"],
      sizes: ["1,10", "11,50", "51,200"],
      regions: ["Saudi Arabia"],
      titles: [],
      includeSimilarTitles: false,
      seniorities: ["owner", "founder", "c_suite", "partner"],
      source: "apollo",
      namedOnly: false,
      mapsCities: [],
    });
  });

  it("a job-title campaign needs a title and asks for exact titles by default", async () => {
    const { calls } = mockServer({
      "GET /setup/targeting": () => json({ data: targeting }),
      "POST /setup/targeting/audiences": () => json({ data: { id: "c10", name: "Managers" } }),
    });
    const { store } = renderWithStore(<NewCampaignPage />);
    store.dispatch(sessionReceived(session));
    await userEvent.type(screen.getByLabelText("Name"), "Agency ops");
    expect(await screen.findByText("You already have a campaign with this name.", undefined, { timeout: 100 }).catch(() => null)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(screen.getByText("You already have a campaign with this name.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Managers");
    await userEvent.type(screen.getByLabelText("Add to Industry keywords"), "audit{Enter}");
    await userEvent.type(screen.getByLabelText("Add to Locations"), "Saudi Arabia{Enter}");
    await userEvent.click(screen.getByRole("radio", { name: /People with these job titles/ }));
    await userEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    expect(screen.getByText("Add at least one job title.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Add to Job titles"), "marketing manager{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/setup/targeting/audiences")).toBe(true));
    expect(calls.find((c) => c.path === "/setup/targeting/audiences")?.body).toMatchObject({ titles: ["marketing manager"], includeSimilarTitles: false, seniorities: ["vp", "head", "director", "manager", "senior"] });
  });

  it("a campaign can find businesses on Google Maps, in chosen cities, named people only", async () => {
    const { calls } = mockServer({
      "GET /setup/targeting": () => json({ data: targeting }),
      "POST /setup/targeting/audiences": () => json({ data: { id: "c11", name: "Clinics" } }),
    });
    const { store } = renderWithStore(<NewCampaignPage />);
    store.dispatch(sessionReceived(session));
    expect(screen.queryByLabelText("Add to Cities to search on Google Maps")).toBeNull();
    await userEvent.type(screen.getByLabelText("Name"), "Clinics");
    await userEvent.type(screen.getByLabelText("Add to Industry keywords"), "dental clinic{Enter}");
    await userEvent.type(screen.getByLabelText("Add to Locations"), "Saudi Arabia{Enter}");
    await userEvent.click(screen.getByRole("radio", { name: /Google Maps/ }));
    expect(screen.getByText(/found on Google Maps once the campaign is on/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Add to Cities to search on Google Maps"), "Riyadh{Enter}");
    await userEvent.click(screen.getByRole("switch", { name: "Named people only" }));
    await userEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/setup/targeting/audiences")).toBe(true));
    expect(calls.find((c) => c.path === "/setup/targeting/audiences")?.body).toMatchObject({ source: "maps", namedOnly: true, mapsCities: ["Riyadh"] });
  });
});
