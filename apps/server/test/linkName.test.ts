import { describe, expect, it } from "vitest";
import { checkFirstTouch } from "../src/domain/emailRules.js";

const body = (company: string, extra = "") =>
  `Hi Georgina,\n\n${company} sells a lot through its product pages, and those pages only bring visitors when their titles, descriptions and supporting text stay clear and current for search.${extra}\n\nI'm {{sender_first_name}} from Rankhouse. We keep product and category pages tidy for search every week, with no extra work for your team, so new collections are found sooner and older pages keep their place.\n\nTeams that sell online use this to keep a large catalogue in shape without adding headcount or another agency.\n\nWould a short look at a few of your pages be useful?`;

describe("the first-email link rule", () => {
  it("lets a company named like a website through, and still blocks a real link", () => {
    expect(checkFirstTouch(body("THE OUTNET.COM"), "en", ["THE OUTNET.COM"])).toBeNull();
    expect(checkFirstTouch(body("THE OUTNET.COM", " See theoutnet.com/sale."), "en", ["THE OUTNET.COM"])).toMatch(/link/);
    expect(checkFirstTouch(body("THE OUTNET.COM"), "en")).toMatch(/link/);
  });
});
