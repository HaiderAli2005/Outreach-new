-- Setup surface: the campaign's approved sequence, and which audience each person was found for.
ALTER TABLE "Campaign" ADD COLUMN "sequence" JSONB;
ALTER TABLE "Contact" ADD COLUMN "audienceId" TEXT;
CREATE INDEX "Contact_organizationId_audienceId_status_idx" ON "Contact"("organizationId", "audienceId", "status");
