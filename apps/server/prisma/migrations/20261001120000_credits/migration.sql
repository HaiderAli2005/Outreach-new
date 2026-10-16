-- CreateEnum
CREATE TYPE "CreditCurrency" AS ENUM ('CREDITS', 'API_CREDITS');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "audienceCursor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "audiences" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "creditRef" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "billingOrganizationId" TEXT;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "monthlyApiCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "monthlyCredits" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "apiCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "credits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creditsResetAt" TIMESTAMP(3),
ADD COLUMN     "currentPeriodStart" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "billingOrganizationId" TEXT NOT NULL,
    "userId" TEXT,
    "currency" "CreditCurrency" NOT NULL DEFAULT 'CREDITS',
    "delta" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "source" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_idempotencyKey_key" ON "CreditLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedger_billingOrganizationId_createdAt_idx" ON "CreditLedger"("billingOrganizationId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedger_organizationId_createdAt_idx" ON "CreditLedger"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_reference_action_key" ON "CreditLedger"("reference", "action");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_billingOrganizationId_fkey" FOREIGN KEY ("billingOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_billingOrganizationId_fkey" FOREIGN KEY ("billingOrganizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A balance can never go below zero, whatever code path writes it.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_credits_nonnegative" CHECK ("credits" >= 0 AND "apiCredits" >= 0);

-- Monthly allowance per plan: one credit is one new person, and each person gets a 3-email sequence over
-- 22 sending days, so a plan's emails a day x 22 / 3 people a month. Stored as data from here on.
UPDATE "Plan" SET "monthlyCredits" = ROUND("maxDailyVolume" * 22 / 3.0) WHERE "monthlyCredits" = 0;

-- Subscriptions that are already running start with their full allowance, recorded in the ledger.
UPDATE "Subscription" s SET "credits" = p."monthlyCredits", "apiCredits" = p."monthlyApiCredits", "creditsResetAt" = now()
FROM "Plan" p WHERE p.id = s."planId" AND s.status IN ('ACTIVE', 'TRIALING');

INSERT INTO "CreditLedger" ("id", "organizationId", "billingOrganizationId", "currency", "delta", "action", "reference", "balanceAfter", "source", "idempotencyKey")
SELECT 'mig_' || s.id, s."organizationId", s."organizationId", 'CREDITS', s."credits", 'plan.grant', 'grant:' || s.id, s."credits", 'migration 20261001120000_credits', 'plan.grant:grant:' || s.id
FROM "Subscription" s WHERE s.status IN ('ACTIVE', 'TRIALING') AND s."credits" > 0;
