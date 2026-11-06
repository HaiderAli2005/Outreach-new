import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DomainSearch } from "@/components/marketing/DomainSearch";
import { renderWithStore } from "./render";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

type Row = { name: string; domain: string; icon?: string };
/** Fake Clearbit and Brandfetch answers. Each test gets its own words, because answers are remembered per page. */
let site: (d: string) => object = (d) => ({ domain: d, status: "ok", reason: null, message: null, title: null });
const sources = ({ cb = [], bf = [] }: { cb?: Row[]; bf?: Row[] }) =>
  vi.fn(async (url: RequestInfo | URL) => {
    const u = url instanceof Request ? url.url : String(url);
    if (u.includes("/public/site-check?domain=")) return new Response(JSON.stringify({ data: site(decodeURIComponent(u.split("domain=")[1])) }), { headers: { "content-type": "application/json" } });
    if (u.startsWith("https://autocomplete.clearbit.com/v1/companies/suggest?query=")) return new Response(JSON.stringify(cb.map((r) => ({ ...r, logo: null }))));
    if (u.startsWith("https://api.brandfetch.io/v2/search/")) return new Response(JSON.stringify(bf.map((r) => ({ icon: null, ...r }))));
    throw new Error(`unexpected ${u}`);
  });

beforeEach(() => {
  push.mockClear();
  site = (d) => ({ domain: d, status: "ok", reason: null, message: null, title: null });
  vi.stubGlobal("fetch", sources({}));
});
afterEach(() => vi.unstubAllGlobals());

describe("DomainSearch", () => {
  it("asks for a domain when the box is empty", async () => {
    renderWithStore(<DomainSearch id="heroDomain" hero />);
    await userEvent.click(screen.getByRole("button", { name: /analyze/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your company domain");
    expect(push).not.toHaveBeenCalled();
  });

  it("rejects text that isn't a domain", async () => {
    renderWithStore(<DomainSearch id="heroDomain" />);
    await userEvent.type(screen.getByLabelText(/your company domain/i), "not a domain{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("doesn't look like a domain");
    expect(push).not.toHaveBeenCalled();
  });

  it("opens onboarding with the cleaned domain", async () => {
    const onDomain = vi.fn();
    renderWithStore(<DomainSearch id="heroDomain" onDomain={onDomain} />);
    await userEvent.type(screen.getByLabelText(/your company domain/i), "https://www.Northwind.io/about{Enter}");
    expect(push).toHaveBeenLastCalledWith("/onboarding?domain=northwind.io");
    expect(onDomain).toHaveBeenLastCalledWith("northwind.io");
  });

  it("shows the free credit on the hero", () => {
    renderWithStore(<DomainSearch id="heroDomain" hero />);
    expect(screen.getByText("$10 free in credits")).toBeInTheDocument();
  });

  it("suggests companies while typing and opens the one picked", async () => {
    const fetchMock = sources({
      cb: [{ name: "SkiStar", domain: "skistar.com" }],
      bf: [
        { name: "Skistar", domain: "skistar.com", icon: "https://cdn.brandfetch.io/x.webp" },
        { name: "Skistar Shop", domain: "skistarshop.com" },
        { name: "Skistar Shop", domain: "skistarshop-cdn.com" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithStore(<DomainSearch id="heroDomain" hero />);
    await userEvent.type(screen.getByLabelText(/your company domain/i), "skis");
    await screen.findByRole("option", { name: /skistar shop/i });
    // Clearbit's answer comes first; Brandfetch adds the logo and the company Clearbit missed, each company once.
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("SkiStarskistar.com");
    expect(options[0].querySelector("img")?.getAttribute("src")).toBe("https://cdn.brandfetch.io/x.webp");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("query=skis"), expect.anything());
    await userEvent.click(screen.getByRole("option", { name: /skistar shop/i }));
    expect(push).toHaveBeenLastCalledWith("/onboarding?domain=skistarshop.com");
  });

  it("picks the highlighted suggestion with the arrow keys and Enter", async () => {
    vi.stubGlobal("fetch", sources({ cb: [{ name: "Acme", domain: "acme.com" }, { name: "Acme Health", domain: "acmehealth.com" }] }));
    renderWithStore(<DomainSearch id="heroDomain" />);
    await userEvent.type(screen.getByLabelText(/your company domain/i), "acm");
    await screen.findByRole("option", { name: /acme health/i });
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(push).toHaveBeenLastCalledWith("/onboarding?domain=acmehealth.com");
  });

  it("still suggests when one source is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("clearbit") ? new Response("", { status: 503 }) : new Response(JSON.stringify([{ name: "Globex", domain: "globex.com", icon: null }])),
      ),
    );
    renderWithStore(<DomainSearch id="heroDomain" />);
    await userEvent.type(screen.getByLabelText(/your company domain/i), "glob");
    expect(await screen.findByRole("option", { name: /globex/i })).toHaveTextContent("globex.com");
  });

  it("offers the typed domain first when it is a real domain", async () => {
    // Not "northwind": an earlier test types it, and a slow run can remember its empty answer.
    vi.stubGlobal("fetch", sources({ cb: [{ name: "Fernwood", domain: "fernwood.us" }] }));
    renderWithStore(<DomainSearch id="heroDomain" />);
    await userEvent.type(screen.getByLabelText(/your company domain/i), "fernwood.io");
    // The typed domain shows at once; the companies join it when the answer arrives.
    await screen.findByRole("option", { name: /fernwood\.us/ });
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Use fernwood.io");
    expect(options[1]).toHaveTextContent("fernwood.us");
  });

  it("stops a domain that doesn't exist at the moment it is entered", async () => {
    site = (d) => ({ domain: d, status: "missing", reason: "missing", message: `We can't find ${d}. Check the spelling and try again.`, title: null });
    renderWithStore(<DomainSearch id="heroDomain" hero />);
    await userEvent.type(screen.getByRole("combobox"), "northwnd.io{Enter}");
    await waitFor(() => expect(screen.getAllByRole("alert")[0]).toHaveTextContent("We can't find northwnd.io"));
    expect(push).not.toHaveBeenCalled();
  });

  it("says why a site can't be read, and lets the customer go on anyway", async () => {
    site = (d) => ({ domain: d, status: "unreadable", reason: "blocked", message: `${d} blocks automated visits (it answered 403).`, title: null });
    renderWithStore(<DomainSearch id="heroDomain" hero />);
    await userEvent.type(screen.getByRole("combobox"), "acme.io{Enter}");
    expect(await screen.findByText("acme.io blocks automated visits (it answered 403).")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Continue anyway" }));
    expect(push).toHaveBeenCalledWith("/onboarding?domain=acme.io");
  });
});
