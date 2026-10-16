-- Spec 5: a card unlocks the free credit; "Skip for now" and "Notify me" are remembered on the setup.
-- AlterTable
ALTER TABLE "Onboarding" ADD COLUMN     "capacityNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "capacityNotifyAt" TIMESTAMP(3),
ADD COLUMN     "cardSkippedAt" TIMESTAMP(3);

