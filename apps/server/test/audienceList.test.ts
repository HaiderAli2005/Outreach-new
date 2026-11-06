import { beforeEach, describe, expect, it } from "vitest";
import { createTenant, makeCampaign, makePoolMailbox, resetDb } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { setApolloFactory, type ApolloPerson } from "../src/integrations/apollo.js";
import { sourceForOrg } from "../src/jobs/sourcing.js";
import { growList } from "../src/domain/sourcing.js";

/**
 * The audience list: the search (free) saves everyone who fits, thousands if the market has them; emails are looked
 * up (paid) only for the best-fit people the balance can email, so money limits sending, never the list.
 */

const person = (i: number, title = "CEO"): ApolloPerson => ({
  id: `ap${i}`,
  first_name: "Sam",
  last_name: `Price${i}`,
  name: `Sam Price${i}`,
  title,
  email: `sam${i}@acme${i}.com`,
  email_status: "verified",
  linkedin_url: `https://linkedin.com/in/sam${i}`,
  organization: { name: `Acme ${i}`, website_url: `https://acme${i}.com`, primary_domain: `acme${i}.com`, estimated_num_employees: 40, country: "United States" },
});

/** A market of `total` people, served 100 a page like the real search. Enrich returns the person with an email. */
function fakeApollo(total: number, opts: { junior?: (i: number) => boolean } = {}) {
  const calls = { search: 0, enriched: 0 };
  setApolloFactory(async () => ({
    searchPeople: async (_f: Record<string, unknown>, page: number, perPage: number) => {
      calls.search++;
      const from = (page - 1) * perPage;
      const people = Array.from({ length: Math.max(0, Math.min(perPage, total - from)) }, (_, k) => {
        const i = from + k + 1;
        // A poor fit: a junior title and nothing else known about them.
        return opts.junior?.(i) ? { id: `ap${i}`, first_name: "Kim", last_name: `Lee${i}`, title: "Intern", seniority: "entry", email_status: null } : person(i);
      });
      return { people, totalEntries: total };
    },
    bulkEnrich: async (ids: { id?: string }[]) => {
      calls.enriched += ids.length;
      return ids.map((x) => person(Number(String(x.id).slice(2))));
    },
  }));
  return calls;
}

async function workspace(balanceDollars: number) {
  await makePoolMailbox();
  const t = await createTenant({ balance: BigInt(balanceDollars * 1000) });
  await prisma.orgSettings.update({ where: { organizationId: t.orgId }, data: { weeklyBatchMode: false, autopilotEnabled: true, dailySourceTarget: 100 } });
  const campaign = await makeCampaign(t.orgId);
  return { t, campaign };
}

describe("audience list", () => {
  beforeEach(resetDb);

  it("saves the whole matching audience from free searches, far past what the balance could email", async () => {
    const { t, campaign } = await workspace(10);
    const calls = fakeApollo(1200);
    const r = await growList(t.orgId, campaign.id, { pages: 10 });
    expect(r).toMatchObject({ pages: 10, added: 1000 });
    expect(await prisma.prospect.count({ where: { organizationId: t.orgId, status: "WAITING" } })).toBe(1000);
    // Nothing was paid for: no email was looked up while building the list.
    expect(calls.enriched).toBe(0);
    // The next run carries on from page 11, and stops at the end of the market.
    const more = await growList(t.orgId, campaign.id, { pages: 10 });
    expect(more).toMatchObject({ added: 200, saturated: true });
  });

  it("keeps only people who fit, never the same person twice, and never someone already contacted", async () => {
    const { t, campaign } = await workspace(10);
    fakeApollo(100, { junior: (i) => i % 4 === 0 });
    const r = await growList(t.orgId, campaign.id, { pages: 1 });
    expect(r.lowFit).toBe(25);
    expect(r.added).toBe(75);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { sourcePage: 1, saturatedAt: null } });
    expect((await growList(t.orgId, campaign.id, { pages: 1 })).added).toBe(0);
  });

  it("looks up emails only for as many people as the balance can email, best fit first; the rest wait in the list", async () => {
    const { t } = await workspace(10);
    const calls = fakeApollo(1500);
    const r = await sourceForOrg(t.orgId, { force: true });
    // $10 pays for 62 four-email sequences: 62 people are pulled and stored, the list keeps the rest.
    expect(await prisma.contact.count({ where: { organizationId: t.orgId } })).toBe(62);
    expect(calls.enriched).toBe(62);
    expect((r as { listed: number }).listed).toBeGreaterThanOrEqual(1000);
    expect(await prisma.prospect.count({ where: { organizationId: t.orgId, status: "PULLED" } })).toBe(62);
    expect(await prisma.prospect.count({ where: { organizationId: t.orgId, status: "WAITING" } })).toBeGreaterThan(900);
  });

  it("with no lead source the list stays empty and nothing breaks", async () => {
    const { t, campaign } = await workspace(10);
    setApolloFactory(async () => null);
    expect(await growList(t.orgId, campaign.id)).toMatchObject({ pages: 0, added: 0 });
  });
});
