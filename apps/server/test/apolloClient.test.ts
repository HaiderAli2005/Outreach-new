import { afterEach, describe, expect, it, vi } from "vitest";
import { ApolloClient } from "../src/integrations/apollo.js";

afterEach(() => vi.unstubAllGlobals());

describe("Apollo client", () => {
  it("reads the total from the top level of the free people search and keeps the obfuscated last name", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({
            total_entries: 78786,
            people: [{ id: "p1", first_name: "Sam", last_name_obfuscated: "Pr***e", title: "Head of Marketing", has_email: true, has_country: true, organization: { name: "Acme", has_employee_count: true } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const res = await new ApolloClient("key").searchPeople({ person_titles: ["Head of Marketing"] }, 1, 25);
    expect(res.totalEntries).toBe(78786);
    expect(res.people[0]).toMatchObject({ first_name: "Sam", last_name: "Pr***e", title: "Head of Marketing", organization: { name: "Acme" } });
    expect(calls[0].url).toBe("https://api.apollo.io/api/v1/mixed_people/api_search");
    expect(calls[0].body).toMatchObject({ person_titles: ["Head of Marketing"], page: 1, per_page: 25 });
  });

  it("says the lead credits ran out instead of a bare HTTP 422, and reads other refusals in the provider's own words", async () => {
    const refusal = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 422, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", refusal({ error: "You have insufficient credits! <a href='x'>Upgrade your plan</a>", error_details: { code: "BILLING.LIMIT.CREDITS_EXHAUSTED", message: "Your team has used all of its credits for this billing cycle." } }));
    await expect(new ApolloClient("key").bulkEnrich([{ id: "p1" }])).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/used all of its credits/) });
    vi.stubGlobal("fetch", refusal({ error: "Invalid <b>person_locations</b> value" }));
    await expect(new ApolloClient("key").searchPeople({}, 1, 25)).rejects.toMatchObject({ status: 422, message: "Invalid person_locations value" });
  });

  it("still reads a total nested under pagination", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ pagination: { total_entries: 12 } }), { status: 200, headers: { "content-type": "application/json" } })));
    expect(await new ApolloClient("key").countOrganizations({})).toBe(12);
  });
});
