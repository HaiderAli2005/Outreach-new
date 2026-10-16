import type { BalanceView, Catalogue, OnboardingState, Session } from "@/lib/types";

export const catalogue: Catalogue = {
  pricing: {
    perEmail: "$0.04",
    perEmailDeciCents: "40",
    replyReserve: "$2.00",
    sequenceDays: [0, 3, 7, 14],
    minTopup: "$25.00",
    minTopupDeciCents: "25000",
    topupDays: [3, 7, 14, 30],
    freeTrial: { amount: "$10.00", emails: 250, people: 62 },
    included: [],
    ownership: "Your leads are yours. Export them any time.",
  },
  budget: {
    minDeciCents: "4000",
    maxDeciCents: "200000",
    defaultDeciCents: "20000",
    presetsDeciCents: ["10000", "20000", "40000", "100000", "200000"],
    stops: Array.from({ length: 197 }, (_, i) => ({ deciCents: String((i + 4) * 1000), emails: (i + 4) * 25, people: Math.floor(((i + 4) * 25) / 4) })),
  },
  volume: {
    min: 100,
    max: 5000,
    step: 50,
    presets: [250, 500, 1000, 2500, 5000],
    stops: Array.from({ length: 99 }, (_, i) => {
      const emails = 100 + i * 50;
      return { emails, perDay: `$${emails / 25}`, perDayDeciCents: String(emails * 40), people: Math.floor(emails / 4), perMonth: `$${(emails / 25) * 22}` };
    }),
  },
  sizing: { sequenceSteps: 4 },
};

export const emptyCredits: BalanceView = {
  balance: "$0.00",
  balanceDeciCents: "0",
  available: "$0.00",
  held: "$0.00",
  emailsLeft: 0,
  peopleLeft: 0,
  pricePerEmail: "$0.04",
  sendRatePerDay: 0,
  dailyBudget: "20000",
  runwayDays: null,
  lastTopup: null,
  lasts: null,
  stage: "unfunded",
  warnings: { low: false, runway: false, empty: true },
};

export const fundedCredits: BalanceView = { ...emptyCredits, balance: "$25.00", balanceDeciCents: "25000", available: "$25.00", emailsLeft: 625, peopleLeft: 156, lastTopup: "$25.00", warnings: { low: false, runway: false, empty: false }, stage: "trial", lasts: "about a day" };

export const session: Session = {
  accessToken: "token-1",
  expiresIn: 900,
  user: { id: "u1", email: "alex@northwind.io", name: "Alex Morgan", isPlatformAdmin: false },
  organizations: [{ id: "org1", name: "Northwind", role: "OWNER", primaryDomain: "northwind.io" }],
  activeOrganizationId: "org1",
};

export function onboardingState(over: Partial<OnboardingState> = {}): OnboardingState {
  return {
    onboarding: {
      id: "ob1",
      domain: "northwind.io",
      brand: "Northwind",
      summary: null,
      icp: { industries: [], titles: [], sizes: [], regions: [] },
      preview: null,
      warmupDays: 14,
      inboxesPerDomain: 3,
      provider: "google",
      analyzedAt: null,
      analysisError: null,
      paidAt: null,
      launchedAt: null,
      facts: [],
      groups: [],
      analysis: null,
      siteReadable: null,
      fastStart: false,
    },
    funded: false,
    credits: emptyCredits,
    emailsPerDay: 500,
    capacityNotify: false,
    campaign: null,
    aiAvailable: false,
    sizeOptions: [],
    ...over,
  };
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
