import { describe, expect, it } from "vitest";
import { companiesFrom, pickProspects, type MarketPerson } from "../src/modules/onboarding/onboarding.service.js";

const person = (audienceId: string, firstName: string, hasEmail: boolean): MarketPerson => ({ audienceId, firstName, lastInitial: "K", title: "Owner", company: "Acme", country: null, hasEmail });

describe("first impression data", () => {
  it("shows people from every audience, those with an email on file first", () => {
    const big = Array.from({ length: 20 }, (_, i) => person("seg_1", `A${i}`, i >= 15));
    const small = [person("seg_2", "B0", false), person("seg_2", "B1", true)];
    const picked = pickProspects([...big, ...small], 4, 12);
    expect(picked.map((p) => p.audienceId).slice(0, 2)).toEqual(["seg_1", "seg_2"]);
    expect(picked.filter((p) => p.audienceId === "seg_2")).toHaveLength(2);
    expect(picked[0].hasEmail).toBe(true);
    expect(picked[1]).toMatchObject({ firstName: "B1", hasEmail: true });
    expect(picked.filter((p) => p.audienceId === "seg_1")).toHaveLength(4);
  });

  it("groups companies with how many matching people work there and their titles", () => {
    const companies = companiesFrom(
      [
        { first_name: "A", title: "SEO Manager", organization: { name: "Solo Ltd" } },
        { first_name: "B", title: "Head of Marketing", organization: { name: "Busy Co", primary_domain: "busy.co" } },
        { first_name: "C", title: "SEO Manager", organization: { name: "Busy Co", primary_domain: "busy.co" } },
      ],
      "seg_1",
    );
    expect(companies[0]).toMatchObject({ name: "Busy Co", people: 2, titles: ["Head of Marketing", "SEO Manager"] });
    expect(companies[1]).toMatchObject({ name: "Solo Ltd", people: 1 });
  });
});

describe("right-to-left email text", () => {
  it("wraps Urdu and Arabic emails so mail apps show them right to left, and leaves English alone", async () => {
    const { htmlize, isRtlText } = await import("../src/domain/sequence.js");
    expect(isRtlText("{{first_name}} صاحب، آپ کا اسٹاک ہر برانچ میں الگ کیوں ہے؟")).toBe(true);
    expect(isRtlText("مرحبا {{first_name}}، كيف حالك؟")).toBe(true);
    expect(isRtlText("Hi {{first_name}}, one quick question about Metro Mart.")).toBe(false);
    expect(htmlize("سلام\nشکریہ")).toBe('<div dir="rtl" style="direction:rtl;text-align:right">سلام<br/>شکریہ</div>');
    expect(htmlize("Hi <b>there</b>")).toBe("Hi &lt;b&gt;there&lt;/b&gt;");
  });
});
