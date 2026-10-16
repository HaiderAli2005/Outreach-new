-- Spec 3: the product layer. Personas, reply intents, approval before launch, consent records, per-prospect
-- scheduling, daily budget, and the end of timed automatic replies (drafts only from now on).

-- CreateEnum
CREATE TYPE "LaunchMode" AS ENUM ('APPROVE_EACH', 'APPROVE_FIRST_BATCH', 'AUTO');

-- DropForeignKey
ALTER TABLE "AutoReplyDecision" DROP CONSTRAINT "AutoReplyDecision_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "AutoReplyQueue" DROP CONSTRAINT "AutoReplyQueue_organizationId_fkey";

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "customerIntent" TEXT,
ADD COLUMN     "emailSource" TEXT,
ADD COLUMN     "followup4" TEXT,
ADD COLUMN     "intent" TEXT,
ADD COLUMN     "intentConfidence" DECIMAL(4,3),
ADD COLUMN     "intentCorrectedAt" TIMESTAMP(3),
ADD COLUMN     "intentSetAt" TIMESTAMP(3),
ADD COLUMN     "manualColdMessageAt" TIMESTAMP(3),
ADD COLUMN     "nextTouchAt" TIMESTAMP(3),
ADD COLUMN     "sequenceStopReason" TEXT,
ADD COLUMN     "sequenceStoppedAt" TIMESTAMP(3),
ADD COLUMN     "temperature" TEXT,
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "Mailbox" ADD COLUMN     "personaId" TEXT;

-- AlterTable
ALTER TABLE "OrgSettings" DROP COLUMN "autoReplyCanaryCampaigns",
DROP COLUMN "autoReplyDailyCap",
DROP COLUMN "autoReplyEnabled",
DROP COLUMN "autoReplyKillSwitch",
DROP COLUMN "autoReplyMaxAutoSends",
DROP COLUMN "autoReplyMaxTurns",
DROP COLUMN "autoReplyMinConfidence",
DROP COLUMN "autoReplyMode",
DROP COLUMN "autoReplySoftAck",
DROP COLUMN "autoReplyThreadGapMinutes",
DROP COLUMN "autoReplyWindowEnd",
DROP COLUMN "autoReplyWindowStart",
ADD COLUMN     "dailyBudgetDecicents" BIGINT,
ADD COLUMN     "draftReplies" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "firstBatchApprovedAt" TIMESTAMP(3),
ADD COLUMN     "firstBatchApprovedById" TEXT,
ADD COLUMN     "launchMode" "LaunchMode" NOT NULL DEFAULT 'APPROVE_FIRST_BATCH',
ADD COLUMN     "proofPoints" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "prospectTimezone" TEXT,
ADD COLUMN     "sendDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[];

-- AlterTable
ALTER TABLE "inbound_messages" ADD COLUMN     "assigned_by" TEXT,
ADD COLUMN     "assigned_contact_id" TEXT;

-- AlterTable
ALTER TABLE "pool_metrics_daily" ADD COLUMN     "unmatched_open" INTEGER,
ADD COLUMN     "console" JSONB,
ADD COLUMN     "console_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sends" ADD COLUMN     "from_name_overridden" BOOLEAN NOT NULL DEFAULT false;

-- DropTable
DROP TABLE "AutoReplyDecision";

-- DropTable
DROP TABLE "AutoReplyQueue";

-- DropEnum
DROP TYPE "AutoReplyMode";

-- DropEnum
DROP TYPE "QueueStatus";

-- CreateTable
CREATE TABLE "personas" (
    "id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "locale" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "gender_hint" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_status_vocab" (
    "project_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "lead_status_vocab_pkey" PRIMARY KEY ("project_id","key")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT,
    "text" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "personas_locale_active_idx" ON "personas"("locale", "active");

-- CreateIndex
CREATE UNIQUE INDEX "personas_first_name_locale_key" ON "personas"("first_name", "locale");

-- CreateIndex
CREATE INDEX "consent_records_organization_id_created_at_idx" ON "consent_records"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "Contact_organizationId_nextTouchAt_idx" ON "Contact"("organizationId", "nextTouchAt");

-- CreateIndex
CREATE INDEX "Contact_organizationId_intent_idx" ON "Contact"("organizationId", "intent");

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "personas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_vocab" ADD CONSTRAINT "lead_status_vocab_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Data ────────────────────────────────────────────────────────────────────

-- Workspaces that were already sending keep sending: their first batch counts as approved, and the authorisation
-- they gave before consent capture existed is recorded as such (no user, no IP: it predates this record).
UPDATE "OrgSettings" s SET "firstBatchApprovedAt" = now()
WHERE EXISTS (SELECT 1 FROM sends x WHERE x.customer_id = s."organizationId" AND x.status <> 'REJECTED');

INSERT INTO consent_records (id, organization_id, user_id, text, ip, user_agent, created_at)
SELECT 'legacy_' || o.id, o.id, NULL,
       'Recorded at upgrade: this workspace was already sending before consent capture existed.', NULL, NULL, now()
FROM "Organization" o
WHERE EXISTS (SELECT 1 FROM sends x WHERE x.customer_id = o.id AND x.status <> 'REJECTED');

-- Where each address came from.
UPDATE "Contact" SET "emailSource" = source WHERE "emailSource" IS NULL;

-- Sequences that have already ended stay ended.
UPDATE "Contact" SET "sequenceStoppedAt" = COALESCE("repliedAt", "updatedAt"), "sequenceStopReason" = 'replied'
WHERE status = 'REPLIED' AND "sequenceStoppedAt" IS NULL;
UPDATE "Contact" SET "sequenceStoppedAt" = "updatedAt", "sequenceStopReason" = lower(status::text)
WHERE status IN ('UNSUBSCRIBED', 'BOUNCED', 'BLOCKLISTED') AND "sequenceStoppedAt" IS NULL;

-- No pool mailbox may be a single letter (c@, a@): it reads as automated and gives the reader nothing to trust.
-- NOT VALID: enforced for every new or changed row without failing on history.
ALTER TABLE "Mailbox" ADD CONSTRAINT "mailbox_local_part_not_single_letter"
  CHECK ("organizationId" IS NOT NULL OR position('@' in address) > 2) NOT VALID;
