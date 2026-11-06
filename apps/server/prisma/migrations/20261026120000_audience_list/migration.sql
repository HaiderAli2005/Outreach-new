-- The audience list: everyone the lead search matched, saved without an email, pulled just in time.
CREATE TYPE "ProspectStatus" AS ENUM ('WAITING', 'PULLED', 'SKIPPED');

CREATE TABLE "Prospect" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "audienceId" TEXT,
    "apolloId" TEXT NOT NULL,
    "fullName" TEXT,
    "title" TEXT,
    "seniority" TEXT,
    "company" TEXT,
    "companyDomain" TEXT,
    "country" TEXT,
    "employees" INTEGER,
    "fitScore" INTEGER NOT NULL DEFAULT 0,
    "status" "ProspectStatus" NOT NULL DEFAULT 'WAITING',
    "pulledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Prospect_organizationId_apolloId_key" ON "Prospect"("organizationId", "apolloId");
CREATE INDEX "Prospect_organizationId_campaignId_status_fitScore_idx" ON "Prospect"("organizationId", "campaignId", "status", "fitScore");

ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
