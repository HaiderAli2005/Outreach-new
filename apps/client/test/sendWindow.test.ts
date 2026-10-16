import { describe, expect, it } from "vitest";
import { windowNow } from "@/lib/sendWindow";

describe("the live sending window line", () => {
  const days = [1, 2, 3, 4, 5];
  it("says it is open, and until when", () => {
    // Wednesday 14 Oct 2026, 12:00 in New York.
    expect(windowNow("America/New_York", days, "09:00", "17:00", new Date("2026-10-14T16:00:00Z"))).toEqual({ open: true, text: "Right now it is 12:00pm for your prospects in New York, so sending is open until 5pm." });
  });
  it("says it is closed, and when it opens", () => {
    expect(windowNow("America/New_York", days, "09:00", "17:00", new Date("2026-10-14T22:40:00Z")).text).toBe("Right now it is 6:40pm for your prospects in New York, so sending is closed until 9am tomorrow.");
    expect(windowNow("America/New_York", days, "09:30", "17:00", new Date("2026-10-14T11:00:00Z")).text).toBe("Right now it is 7:00am for your prospects in New York, so sending is closed until 9:30am today.");
    // Friday evening: Monday.
    expect(windowNow("America/New_York", days, "09:00", "17:00", new Date("2026-10-16T23:00:00Z")).text).toMatch(/closed until 9am Monday\.$/);
  });
});
