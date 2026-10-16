import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SequencePage from "@/app/app/setup/sequence/page";
import TargetingPage from "@/app/app/setup/targeting/page";
import BusinessProfilePage from "@/app/app/setup/profile/page";
import { AppShell } from "@/components/shell/AppShell";
import { sessionReceived } from "@/store/authSlice";
import { json, session } from "./fixtures";
import { renderWithStore } from "./render";
import { mockServer } from "./server";

vi.mock("next/navigation", () => ({ usePathname: () => "/app/setup/sequence", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

const touches = [
  { step: 1, day: 0, subject: "Client reporting time", body: "Hi {{first_name}},\n\nOne.\n\nTwo.\n\nThree.\n\nFour?" },
  { step: 2, day: 3, subject: null, body: "Hi {{first_name}},\n\nA different angle?" },
  { step: 3, day: 7, subject: null, body: "Hi {{first_name}},\n\nA smaller offer." },
  { step: 4, day: 14, subject: null, body: "Hi {{first_name}},\n\nI'll leave it here." },
];

describe("Setup", () => {
  it("groups the sidebar into Outreach, Setup and Workspace, with no Campaigns item", async () => {
    mockServer({ "GET /dashboard/nav-counts": () => json({ data: null }) });
    const { store } = renderWithStore(<AppShell>page</AppShell>);
    store.dispatch(sessionReceived(session));
    const labels = (await screen.findAllByRole("link")).map((a) => a.textContent?.trim());
    for (const l of ["Cockpit", "Inbox", "Leads", "Business profile", "Targeting", "Email sequence", "Sending schedule", "Suppress list", "Credits", "Settings", "System"]) expect(labels).toContain(l);
    expect(labels).not.toContain("Campaigns");
    expect(labels).not.toContain("Integrations");
    expect(screen.getByText("Setup")).toBeInTheDocument();
  });

  it("Email sequence shows each touch, counts the rules, and puts the server's rule next to the email it breaks", async () => {
    const { calls } = mockServer({
      "GET /setup/sequence": () => json({ data: { campaignId: "c1", campaignName: "Main", touches, fromSample: false } }),
      "PUT /setup/sequence": () => json({ error: { code: "BUSINESS_RULE", message: "The subject has a verb", details: { errors: [{ step: 1, field: "subject", message: 'The subject has a verb ("grow"), it must be a noun phrase.' }] } } }, 422),
    });
    const { store } = renderWithStore(<SequencePage />);
    store.dispatch(sessionReceived(session));
    const subject = await screen.findByLabelText("Subject");
    expect(screen.getByText("4 paragraphs (4)")).toBeInTheDocument();
    expect(screen.getAllByText(/Re: Client reporting time/)).toHaveLength(3);
    await userEvent.clear(subject);
    await userEvent.type(subject, "Grow your agency");
    await userEvent.click(screen.getByRole("button", { name: "Save sequence" }));
    expect(await screen.findByText(/it must be a noun phrase/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ touches: [{ subject: "Grow your agency" }, { subject: null }, { subject: null }, { subject: null }] });
  });

  it("Targeting warns about people already queued before saving, and removes them only when asked", async () => {
    const group = { id: "g1", name: "Agency ops", description: "", on: true, titles: ["Head of Ops"], keywords: ["agency"], keywordSuggestions: [], sizes: [], regions: ["UK"], matching: 1200, reachable: 800, queued: 5 };
    const { calls } = mockServer({
      "GET /setup/targeting": () => json({ data: { groups: [group, { ...group, id: "g2", name: "Founders", queued: 0 }], matching: 2400, reachable: 1600, countedAt: null, sizeOptions: ["1,10", "11,50"], launched: true } }),
      "POST /setup/targeting/check": () => json({ data: { affected: [{ id: "g1", name: "Agency ops", queued: 5, off: true }], queued: 5 } }),
      "PUT /setup/targeting": () => json({ data: { groups: [], matching: null, reachable: null, countedAt: null, sizeOptions: [], launched: true, dropped: 5 } }),
    });
    const { store } = renderWithStore(<TargetingPage />);
    store.dispatch(sessionReceived(session));
    expect(await screen.findByText("2,400")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Agency ops on" }));
    await userEvent.click(screen.getByRole("button", { name: "Save targeting" }));
    expect(await screen.findByText(/5 people are already queued/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Save and remove them" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ dropQueued: true }));
  });

  it("Business profile says plainly that it is what the AI writes from, and shows the analysis as a starting point", async () => {
    mockServer({
      "GET /setup/profile": () => json({ data: { company: "Northwind", sell: "Client reporting for agencies", who: "Agency ops leads", where: "UK", offerings: [], differentiators: [], tone: "", proofPoints: [], updatedAt: null, suggested: ["sell", "who"] } }),
    });
    const { store } = renderWithStore(<BusinessProfilePage />);
    store.dispatch(sessionReceived(session));
    expect(await screen.findByText(/This is what the AI uses to write every email, so getting it right improves the copy/)).toBeInTheDocument();
    expect(screen.getByText(/Filled from your setup analysis/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled();
  });
});
