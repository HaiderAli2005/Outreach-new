-- Spec 4: one price per email ($0.04) and one volume control, the daily budget. Emails a day are derived from the
-- budget, never stored. Workspaces keep the volume they had: their old emails a day become a budget at $0.04 each.
UPDATE "OrgSettings" s
SET "dailyBudgetDecicents" = LEAST(GREATEST(o."volume", 100), 5000)::bigint * 40
FROM "Onboarding" o
WHERE o."organizationId" = s."organizationId" AND s."dailyBudgetDecicents" IS NULL AND o."launchedAt" IS NULL;

UPDATE "OrgSettings"
SET "dailyBudgetDecicents" = LEAST(GREATEST("defaultDailySendCap", 100), 5000)::bigint * 40
WHERE "dailyBudgetDecicents" IS NULL;

ALTER TABLE "OrgSettings" DROP COLUMN "defaultDailySendCap";
ALTER TABLE "Onboarding" DROP COLUMN "volume";
ALTER TABLE "Campaign" DROP COLUMN "dailySendCap";

-- Auto-reload: off by default; at most one charge in 24 hours; a failure switches it off.
ALTER TABLE "OrgSettings" ADD COLUMN "autoReloadEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OrgSettings" ADD COLUMN "autoReloadThresholdDecicents" BIGINT;
ALTER TABLE "OrgSettings" ADD COLUMN "autoReloadAmountDecicents" BIGINT;
ALTER TABLE "OrgSettings" ADD COLUMN "autoReloadLastAt" TIMESTAMP(3);
ALTER TABLE "OrgSettings" ADD COLUMN "autoReloadFailedAt" TIMESTAMP(3);
ALTER TABLE "OrgSettings" ADD COLUMN "autoReloadFailReason" TEXT;
