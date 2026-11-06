import { describe, expect, it } from "vitest";
import { planFor } from "../src/domain/sending/dailyPlan.js";
import { newPeopleBounds } from "../src/config/plans.js";

/** The day's split: follow-ups first, new people fill all the rest, never less than a fifth of the day. */
describe("daily plan", () => {
  const plan = (emails: number, firsts: number, fuSent: number, fuDue: number) => {
    const { min, max } = newPeopleBounds(emails);
    return planFor(emails, min, max, firsts, fuSent, fuDue);
  };

  it("on the first days, with no follow-ups yet, the whole day goes to new people", () => {
    expect(newPeopleBounds(100)).toEqual({ min: 20, max: 100 });
    expect(plan(100, 0, 0, 0)).toMatchObject({ newAllowed: 100, followupsAllowed: 0 });
    expect(plan(1250, 0, 0, 0)).toMatchObject({ newAllowed: 1250 });
  });

  it("puts due follow-ups first and gives new people what is left", () => {
    expect(plan(100, 0, 0, 50)).toMatchObject({ newAllowed: 50, followupsAllowed: 50 });
    expect(plan(100, 0, 0, 70)).toMatchObject({ newAllowed: 30, followupsAllowed: 70 });
  });

  it("on a stacked day keeps a fifth for new people; the follow-ups that don't fit wait a day", () => {
    expect(plan(100, 0, 0, 140)).toMatchObject({ newAllowed: 20, followupsAllowed: 80 });
  });

  it("never takes back new people already sent today", () => {
    expect(plan(100, 50, 0, 90)).toMatchObject({ newAllowed: 50, followupsAllowed: 50 });
    // Follow-ups that turn up after a full day of first emails wait for tomorrow; the total never goes over.
    expect(plan(100, 100, 0, 30)).toMatchObject({ newAllowed: 100, followupsAllowed: 0 });
  });

  it("sends nothing without a budget, and at least one new person on the smallest one", () => {
    expect(plan(0, 0, 0, 5)).toMatchObject({ newAllowed: 0, followupsAllowed: 0 });
    expect(newPeopleBounds(2)).toEqual({ min: 1, max: 2 });
  });
});
