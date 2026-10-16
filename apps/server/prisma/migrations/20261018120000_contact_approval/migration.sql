-- CreateEnum
CREATE TYPE "LeadSourcing" AS ENUM ('AUTOMATIC', 'OFF');

-- AlterTable
ALTER TABLE "OrgSettings" ADD COLUMN "leadSourcing" "LeadSourcing" NOT NULL DEFAULT 'AUTOMATIC';
ALTER TABLE "Contact" ADD COLUMN "approvalSource" TEXT;

-- Backfill: people already approved one by one keep it.
UPDATE "Contact" SET "approvalSource" = 'review' WHERE "approvedAt" IS NOT NULL;

-- People in an approved week.
UPDATE "Contact" c SET "approvedAt" = COALESCE(b."approvedAt", b."updatedAt"), "approvalSource" = 'review'
FROM "WeeklyBatch" b
WHERE c."batchId" = b.id AND c."approvedAt" IS NULL AND b.status IN ('APPROVED', 'SENDING', 'DONE');

-- Uploaded people.
UPDATE "Contact" SET "approvedAt" = "createdAt", "approvalSource" = 'upload' WHERE "approvedAt" IS NULL AND source = 'csv';
