-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('TOPUP', 'CHARGE', 'RESERVE', 'RELEASE', 'REFUND', 'BONUS');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('OPEN', 'SETTLED');

-- CreateEnum
CREATE TYPE "SendStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'HARD_BOUNCE', 'SOFT_BOUNCE', 'COMPLAINT', 'REJECTED');

-- CreateEnum
CREATE TYPE "CustomerHealthStatus" AS ENUM ('OK', 'WARNING', 'PAUSED');

-- CreateEnum
CREATE TYPE "PoolReorderStatus" AS ENUM ('PENDING', 'APPROVED', 'DONE', 'DISMISSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MailboxStatus" ADD VALUE 'REPLIES_ONLY';
ALTER TYPE "MailboxStatus" ADD VALUE 'RETIRED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SendingDomainStatus" ADD VALUE 'AGING';
ALTER TYPE "SendingDomainStatus" ADD VALUE 'WARMING';
ALTER TYPE "SendingDomainStatus" ADD VALUE 'ACTIVE';
ALTER TYPE "SendingDomainStatus" ADD VALUE 'DEGRADED';
ALTER TYPE "SendingDomainStatus" ADD VALUE 'RETIRED';

-- DropForeignKey
ALTER TABLE "CreditLedger" DROP CONSTRAINT "CreditLedger_billingOrganizationId_fkey";

-- DropForeignKey
ALTER TABLE "CreditLedger" DROP CONSTRAINT "CreditLedger_organizationId_fkey";

-- AlterTable
ALTER TABLE "Contact" DROP COLUMN "creditRef",
ADD COLUMN     "assignedMailboxId" TEXT;

-- AlterTable
ALTER TABLE "Mailbox" ADD COLUMN     "degradedAt" TIMESTAMP(3),
ADD COLUMN     "fromNameDefault" TEXT,
ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "sendCapToday" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sentToday" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sentTodayOn" DATE,
ADD COLUMN     "warmupDay" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "warmupCheckedOn" DATE,
ALTER COLUMN "organizationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "region" TEXT NOT NULL DEFAULT 'global';

-- AlterTable
ALTER TABLE "Plan" DROP COLUMN "monthlyApiCredits",
DROP COLUMN "monthlyCredits";

-- AlterTable
ALTER TABLE "SendingDomain" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "agingUntil" TIMESTAMP(3),
ADD COLUMN     "degradedAt" TIMESTAMP(3),
ADD COLUMN     "ipPoolId" TEXT,
ADD COLUMN     "nameserverSet" TEXT,
ADD COLUMN     "region" TEXT NOT NULL DEFAULT 'global',
ADD COLUMN     "registrar" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "warmupStartedAt" TIMESTAMP(3),
ALTER COLUMN "organizationId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "apiCredits",
DROP COLUMN "credits",
DROP COLUMN "creditsResetAt";

-- DropTable
DROP TABLE "CreditLedger";

-- DropEnum
DROP TYPE "CreditCurrency";

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "customer_id" TEXT NOT NULL,
    "kind" "LedgerKind" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "send_id" TEXT,
    "reservation_id" TEXT,
    "stripe_ref" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_reservations" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "amount" BIGINT NOT NULL,
    "remaining" BIGINT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "credit_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sends" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "prospect_id" TEXT NOT NULL,
    "mailbox_id" TEXT,
    "domain_id" TEXT,
    "is_first_touch" BOOLEAN NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 1,
    "status" "SendStatus" NOT NULL,
    "price_charged" BIGINT NOT NULL DEFAULT 0,
    "reject_code" TEXT,
    "reject_reason" TEXT,
    "bounce_code" TEXT,
    "bounce_reason" TEXT,
    "external_ref" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "send_lanes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "smartleadCampaignId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "send_lanes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_health" (
    "customer_id" TEXT NOT NULL,
    "window_sends" INTEGER NOT NULL DEFAULT 0,
    "window_bounces" INTEGER NOT NULL DEFAULT 0,
    "bounce_rate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "status" "CustomerHealthStatus" NOT NULL DEFAULT 'OK',
    "paused_at" TIMESTAMP(3),
    "paused_reason" TEXT,
    "unpaused_at" TIMESTAMP(3),
    "unpaused_by" TEXT,
    "unpause_reason" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_health_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "domain_health_daily" (
    "domain_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "sends" INTEGER NOT NULL DEFAULT 0,
    "hard_bounces" INTEGER NOT NULL DEFAULT 0,
    "complaints" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_health_daily_pkey" PRIMARY KEY ("domain_id","day")
);

-- CreateTable
CREATE TABLE "pool_metrics_daily" (
    "day" DATE NOT NULL,
    "active_domains" INTEGER NOT NULL,
    "warming_domains" INTEGER NOT NULL,
    "active_mailboxes" INTEGER NOT NULL,
    "warming_mailboxes" INTEGER NOT NULL,
    "replies_only_mailboxes" INTEGER NOT NULL,
    "domains_degraded" INTEGER NOT NULL,
    "domains_retired" INTEGER NOT NULL,
    "ewma_weekly_burn" DECIMAL(8,3) NOT NULL,

    CONSTRAINT "pool_metrics_daily_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "pool_reorders" (
    "id" TEXT NOT NULL,
    "status" "PoolReorderStatus" NOT NULL DEFAULT 'PENDING',
    "domains_to_buy" INTEGER NOT NULL,
    "runway_weeks" DECIMAL(8,2) NOT NULL,
    "ewma_burn" DECIMAL(8,3) NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'global',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pool_reorders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_seq_key" ON "credit_ledger"("seq");

-- CreateIndex
CREATE INDEX "credit_ledger_customer_id_created_at_idx" ON "credit_ledger"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_kind_stripe_ref_key" ON "credit_ledger"("kind", "stripe_ref");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_kind_send_id_key" ON "credit_ledger"("kind", "send_id");

-- CreateIndex
CREATE INDEX "credit_reservations_customer_id_status_idx" ON "credit_reservations"("customer_id", "status");

-- CreateIndex
CREATE INDEX "credit_reservations_contact_id_status_idx" ON "credit_reservations"("contact_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sends_external_ref_key" ON "sends"("external_ref");

-- CreateIndex
CREATE INDEX "sends_customer_id_sent_at_idx" ON "sends"("customer_id", "sent_at" DESC);

-- CreateIndex
CREATE INDEX "sends_mailbox_id_sent_at_idx" ON "sends"("mailbox_id", "sent_at" DESC);

-- CreateIndex
CREATE INDEX "sends_domain_id_sent_at_idx" ON "sends"("domain_id", "sent_at" DESC);

-- CreateIndex
CREATE INDEX "sends_status_idx" ON "sends"("status");

-- CreateIndex
CREATE INDEX "sends_prospect_id_step_idx" ON "sends"("prospect_id", "step");

-- CreateIndex
CREATE UNIQUE INDEX "send_lanes_smartleadCampaignId_key" ON "send_lanes"("smartleadCampaignId");

-- CreateIndex
CREATE UNIQUE INDEX "send_lanes_organizationId_mailboxId_key" ON "send_lanes"("organizationId", "mailboxId");

-- CreateIndex
CREATE INDEX "pool_reorders_status_idx" ON "pool_reorders"("status");

-- CreateIndex
CREATE INDEX "Contact_assignedMailboxId_idx" ON "Contact"("assignedMailboxId");

-- CreateIndex
CREATE INDEX "Mailbox_sendingDomainId_status_idx" ON "Mailbox"("sendingDomainId", "status");

-- CreateIndex
CREATE INDEX "SendingDomain_organizationId_idx" ON "SendingDomain"("organizationId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_assignedMailboxId_fkey" FOREIGN KEY ("assignedMailboxId") REFERENCES "Mailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_send_id_fkey" FOREIGN KEY ("send_id") REFERENCES "sends"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sends" ADD CONSTRAINT "sends_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sends" ADD CONSTRAINT "sends_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sends" ADD CONSTRAINT "sends_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "Mailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sends" ADD CONSTRAINT "sends_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "SendingDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_lanes" ADD CONSTRAINT "send_lanes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "send_lanes" ADD CONSTRAINT "send_lanes_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_health" ADD CONSTRAINT "customer_health_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_health_daily" ADD CONSTRAINT "domain_health_daily_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "SendingDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Hand-written rules ─────────────────────────────────────────────────────

-- A balance can never be negative: every ledger row records the balance after it, and none may be below zero.
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_balance_after_nonnegative" CHECK ("balance_after" >= 0);
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_amounts_valid" CHECK ("amount" >= 0 AND "remaining" >= 0 AND "remaining" <= "amount");

-- Shared-pool rows have no owner, so the per-owner unique keys don't cover them. Names stay unique across the pool.
CREATE UNIQUE INDEX "SendingDomain_pool_name_key" ON "SendingDomain"("name") WHERE "organizationId" IS NULL;
CREATE UNIQUE INDEX "Mailbox_pool_address_key" ON "Mailbox"("address") WHERE "organizationId" IS NULL;

-- A prospect's mailbox, once set, is permanent. Every follow-up and reply must leave from the same address, or the
-- thread breaks and the reply reads like an impersonation attempt. No code path may change it.
CREATE OR REPLACE FUNCTION contact_mailbox_pin_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."assignedMailboxId" IS NOT NULL AND NEW."assignedMailboxId" IS DISTINCT FROM OLD."assignedMailboxId" THEN
    RAISE EXCEPTION 'assignedMailboxId is permanent once set (contact %)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "contact_mailbox_pin" BEFORE UPDATE OF "assignedMailboxId" ON "Contact"
  FOR EACH ROW EXECUTE FUNCTION contact_mailbox_pin_guard();
