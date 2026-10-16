-- Stripe billing v2: prepaid PaymentIntents only. No plans, subscriptions or invoices; disputes are tracked;
-- auto-reload records its mandate and why the system switched it off.

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'DISPUTED';

-- Auto-reload: the failure columns become the general "switched off by the system" record, and the mandate is stored.
ALTER TABLE "OrgSettings" RENAME COLUMN "autoReloadFailedAt" TO "autoReloadDisabledAt";
ALTER TABLE "OrgSettings" RENAME COLUMN "autoReloadFailReason" TO "autoReloadDisabledReason";
ALTER TABLE "OrgSettings"
  ADD COLUMN "autoReloadMandateText" TEXT,
  ADD COLUMN "autoReloadMandateAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "autoReloadMandateIp" TEXT,
  ADD COLUMN "autoReloadMandateUserId" TEXT;
-- Nobody can have accepted a mandate before it existed, so any auto-reload switched on before now goes off.
UPDATE "OrgSettings" SET "autoReloadEnabled" = false WHERE "autoReloadEnabled" = true;

-- Orphans from the old subscription model: nothing reads or writes them.
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_organizationId_fkey";
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_organizationId_fkey";
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_planId_fkey";
ALTER TABLE "Payment" DROP COLUMN "stripeInvoiceId";
DROP TABLE "Invoice";
DROP TABLE "Plan";
DROP TABLE "Subscription";
DROP TYPE "SubscriptionStatus";
