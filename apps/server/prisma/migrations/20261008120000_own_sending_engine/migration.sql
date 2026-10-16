-- CreateEnum
CREATE TYPE "OrgKind" AS ENUM ('CUSTOMER', 'INTERNAL');

-- Smartlead is gone: its stored keys and webhook log rows go with it, so the enum values can be dropped.
DELETE FROM "IntegrationCredential" WHERE "provider"::text = 'SMARTLEAD';
DELETE FROM "WebhookEvent" WHERE "provider"::text = 'SMARTLEAD';

-- AlterEnum
BEGIN;
CREATE TYPE "IntegrationProvider_new" AS ENUM ('APOLLO', 'MILLIONVERIFIER', 'SLACK_WEBHOOK');
ALTER TABLE "IntegrationCredential" ALTER COLUMN "provider" TYPE "IntegrationProvider_new" USING ("provider"::text::"IntegrationProvider_new");
ALTER TYPE "IntegrationProvider" RENAME TO "IntegrationProvider_old";
ALTER TYPE "IntegrationProvider_new" RENAME TO "IntegrationProvider";
DROP TYPE "public"."IntegrationProvider_old";
COMMIT;

-- AlterEnum
ALTER TYPE "SendStatus" ADD VALUE 'AUTH_FAILURE';

-- AlterEnum
BEGIN;
CREATE TYPE "WebhookProvider_new" AS ENUM ('STRIPE', 'CALENDLY', 'APOLLO');
ALTER TABLE "WebhookEvent" ALTER COLUMN "provider" TYPE "WebhookProvider_new" USING ("provider"::text::"WebhookProvider_new");
ALTER TYPE "WebhookProvider" RENAME TO "WebhookProvider_old";
ALTER TYPE "WebhookProvider_new" RENAME TO "WebhookProvider";
DROP TYPE "public"."WebhookProvider_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "send_lanes" DROP CONSTRAINT "send_lanes_mailboxId_fkey";

-- DropForeignKey
ALTER TABLE "send_lanes" DROP CONSTRAINT "send_lanes_organizationId_fkey";

-- DropIndex
DROP INDEX "Campaign_smartleadCampaignId_key";

-- DropIndex
DROP INDEX "Contact_smartleadLeadId_idx";

-- DropIndex
DROP INDEX "sends_external_ref_key";

-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "smartleadCampaignId";

-- AlterTable
ALTER TABLE "Contact" DROP COLUMN "smartleadCampaignId",
DROP COLUMN "smartleadLeadId";

-- AlterTable
ALTER TABLE "Mailbox" DROP COLUMN "smartleadAccountId",
ADD COLUMN     "credentialRef" TEXT,
ADD COLUMN     "imapHost" TEXT,
ADD COLUMN     "imapPort" INTEGER,
ADD COLUMN     "lastImapUid" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "lastPolledAt" TIMESTAMP(3),
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPort" INTEGER,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN     "transportRef" TEXT;

-- Existing mailboxes send over direct SMTP.
UPDATE "Mailbox" SET "transportRef" = 'smtp:' || "address" WHERE "transportRef" IS NULL;
ALTER TABLE "Mailbox" ALTER COLUMN "transportRef" SET NOT NULL;

-- AlterTable
ALTER TABLE "Message" RENAME COLUMN "smartleadMessageId" TO "emailMessageId";
ALTER TABLE "Message" DROP COLUMN "smartleadStatsId";
UPDATE "Message" SET "via" = 'manual' WHERE "via" = 'smartlead-manual';
UPDATE "Message" SET "via" = 'email' WHERE "via" = 'smartlead';

-- AlterTable
ALTER TABLE "OrgSettings" DROP COLUMN "smartleadDefaultCampaignId",
DROP COLUMN "smartleadMailboxIds";

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "kind" "OrgKind" NOT NULL DEFAULT 'CUSTOMER';

-- AlterTable
ALTER TABLE "SendingDomain" ADD COLUMN     "dkim_ok" BOOLEAN,
ADD COLUMN     "dkim_selector" TEXT,
ADD COLUMN     "dkim_verified_at" TIMESTAMP(3),
ADD COLUMN     "dmarc_ok" BOOLEAN,
ADD COLUMN     "dns_checked_at" TIMESTAMP(3),
ADD COLUMN     "pause_reason" TEXT,
ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "seed_result" TEXT,
ADD COLUMN     "seed_test_at" TIMESTAMP(3),
ADD COLUMN     "seed_token" TEXT,
ADD COLUMN     "spf_ok" BOOLEAN;

-- AlterTable
ALTER TABLE "pool_metrics_daily" ADD COLUMN     "dilution" DECIMAL(8,2);

-- AlterTable
ALTER TABLE "sends" DROP COLUMN "external_ref",
ADD COLUMN     "bounce_parse" TEXT,
ADD COLUMN     "enhanced_code" TEXT,
ADD COLUMN     "in_reply_to" TEXT,
ADD COLUMN     "message_id" TEXT,
ADD COLUMN     "next_retry_at" TIMESTAMP(3),
ADD COLUMN     "references_chain" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rerouted_from" TEXT,
ADD COLUMN     "retry_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "smtp_code" TEXT,
ADD COLUMN     "subject" TEXT;

-- DropTable
DROP TABLE "send_lanes";

-- CreateTable
CREATE TABLE "inbound_messages" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "imap_uid" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "matched_send_id" TEXT,
    "from_email" TEXT NOT NULL,
    "subject" TEXT,
    "body_text" TEXT,
    "raw_headers" TEXT,
    "message_id" TEXT,
    "handled_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_suppression" (
    "email_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_suppression_pkey" PRIMARY KEY ("email_hash")
);

-- CreateTable
CREATE TABLE "prospect_contact_log" (
    "email_hash" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "contacted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_contact_log_pkey" PRIMARY KEY ("email_hash","customer_id","contacted_at")
);

-- CreateIndex
CREATE INDEX "inbound_messages_kind_handled_at_idx" ON "inbound_messages"("kind", "handled_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_messages_mailbox_id_imap_uid_key" ON "inbound_messages"("mailbox_id", "imap_uid");

-- CreateIndex
CREATE INDEX "prospect_contact_log_email_hash_contacted_at_idx" ON "prospect_contact_log"("email_hash", "contacted_at" DESC);

-- CreateIndex
CREATE INDEX "prospect_contact_log_email_hash_mailbox_id_idx" ON "prospect_contact_log"("email_hash", "mailbox_id");

-- CreateIndex
CREATE UNIQUE INDEX "sends_message_id_key" ON "sends"("message_id");

-- CreateIndex
CREATE INDEX "sends_status_next_retry_at_idx" ON "sends"("status", "next_retry_at");

-- AddForeignKey
ALTER TABLE "sends" ADD CONSTRAINT "sends_rerouted_from_fkey" FOREIGN KEY ("rerouted_from") REFERENCES "Mailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_matched_send_id_fkey" FOREIGN KEY ("matched_send_id") REFERENCES "sends"("id") ON DELETE SET NULL ON UPDATE CASCADE;

