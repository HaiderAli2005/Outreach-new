import { describe, expect, it } from "vitest";
import { ago, brandOf, initials, money, n0, normDomain, titleCase, validDomain } from "@/lib/format";

describe("format", () => {
  it("normalises domains typed in any form", () => {
    expect(normDomain("  https://www.Northwind.io/about?x=1 ")).toBe("northwind.io");
    expect(normDomain("northwind.io/pricing")).toBe("northwind.io");
    expect(normDomain("")).toBe("");
  });

  it("accepts real domains and rejects junk", () => {
    expect(validDomain("northwind.io")).toBe(true);
    expect(validDomain("my-shop.co.uk")).toBe(true);
    expect(validDomain("northwind")).toBe(false);
    expect(validDomain("-bad.com")).toBe(false);
    expect(validDomain("a b.com")).toBe(false);
  });

  it("formats money and counts", () => {
    expect(money(19900)).toBe("$199");
    expect(money(43391)).toBe("$433.91");
    expect(money(1000, { exact: true })).toBe("$10.00");
    expect(money(null)).toBe("$0");
    expect(n0(1234.6)).toBe("1,235");
    expect(n0(undefined)).toBe("0");
  });

  it("derives names and initials", () => {
    expect(brandOf("bright-labs.co")).toBe("Bright Labs");
    expect(initials("Alex Morgan")).toBe("AM");
    expect(initials("  ")).toBe("?");
    expect(titleCase("NOT_INTERESTED")).toBe("Not Interested");
  });

  it("describes elapsed time", () => {
    expect(ago(new Date())).toBe("just now");
    expect(ago(new Date(Date.now() - 5 * 60_000))).toBe("5m ago");
    expect(ago(new Date(Date.now() - 3 * 3_600_000))).toBe("3h ago");
    expect(ago(null)).toBe("");
  });
});
