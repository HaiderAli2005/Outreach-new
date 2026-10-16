-- AlterTable
ALTER TABLE "Onboarding" ADD COLUMN     "facts" JSONB,
ADD COLUMN     "fastStart" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "groups" JSONB,
ADD COLUMN     "market" JSONB,
ADD COLUMN     "senders" JSONB,
ADD COLUMN     "siteReadable" BOOLEAN,
ALTER COLUMN "warmupDays" SET DEFAULT 14;
