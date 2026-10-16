import { describe, expect, it } from "vitest";
import { parseDollars, usd } from "@/components/onboarding/sizing";

describe("sizing", () => {
  it("formats deci-cents the server sent without floats", () => {
    expect(usd("20000")).toBe("$20");
    expect(usd("20500")).toBe("$20.50");
  });

  it("reads typed dollar amounts without floats", () => {
    expect(parseDollars("60")).toBe(60_000n);
    expect(parseDollars("$1,250.5")).toBe(1_250_500n);
    expect(parseDollars("abc")).toBeNull();
  });
});
