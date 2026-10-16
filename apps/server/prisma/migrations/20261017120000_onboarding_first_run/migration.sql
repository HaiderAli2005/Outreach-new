-- AlterTable
ALTER TABLE "Onboarding" ADD COLUMN     "firstRunFinishedAt" TIMESTAMP(3),
ADD COLUMN     "firstRunResult" JSONB,
ADD COLUMN     "firstRunStartedAt" TIMESTAMP(3);
