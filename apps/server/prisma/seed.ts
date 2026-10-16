import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { PERSONA_SEED } from "../src/domain/pool/personaSeed.js";

const prisma = new PrismaClient();

/**
 * Creates the platform admin from ADMIN_EMAIL / ADMIN_PASSWORD, and the internal organizations whose genuine
 * outreach warms the shared pool before there are paying customers. There are no plans to seed: customers prepay a
 * balance and pay per email sent.
 */
const INTERNAL_ORGS = [
  { name: "Marketlytics", primaryDomain: "marketlytics.co.uk", region: "uk" },
  { name: "skimming.ai", primaryDomain: "skimming.ai", region: "global" },
  { name: "RankHouse", primaryDomain: "rankhouse.ai", region: "global" },
];
async function main() {
  // The persona pool the shared mailboxes are named after.
  for (const [locale, { region, names }] of Object.entries(PERSONA_SEED)) {
    for (const [firstName, lastName, genderHint] of names) {
      await prisma.persona.upsert({ where: { firstName_locale: { firstName, locale } }, create: { firstName, lastName, locale, region, genderHint }, update: {} });
    }
  }
  console.log("personas ready");
  await prisma.poolSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
  console.log("pool settings ready");
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.upsert({
      where: { email },
      create: { email, name: "Platform admin", passwordHash, isPlatformAdmin: true, emailVerifiedAt: new Date() },
      update: { isPlatformAdmin: true, emailVerifiedAt: new Date() },
    });
    console.log(`platform admin ready: ${email}`);
    const admin = await prisma.user.findUniqueOrThrow({ where: { email } });
    // Internal outreach goes through the pool exactly like a customer's: same router, same ladder, same caps. It is
    // not billed, is left out of revenue and margin, and is served after customers when capacity is tight.
    for (const o of INTERNAL_ORGS) {
      const existing = await prisma.organization.findFirst({ where: { kind: "INTERNAL", name: o.name } });
      const org = existing ?? (await prisma.organization.create({ data: { ...o, kind: "INTERNAL" } }));
      await prisma.membership.upsert({ where: { organizationId_userId: { organizationId: org.id, userId: admin.id } }, create: { organizationId: org.id, userId: admin.id, role: "OWNER" }, update: {} });
      await prisma.orgSettings.upsert({ where: { organizationId: org.id }, create: { organizationId: org.id, senderCompany: o.name }, update: {} });
      console.log(`internal organization ready: ${o.name}`);
    }
  } else {
    console.log("set ADMIN_EMAIL and ADMIN_PASSWORD to create the platform admin");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
