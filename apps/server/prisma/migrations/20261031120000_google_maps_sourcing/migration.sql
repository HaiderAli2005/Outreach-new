-- Google Maps as a lead source: the provider, where each waiting person came from, and the places looked at.
ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'GOOGLE_PLACES';

ALTER TABLE "Prospect" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'apollo';
ALTER TABLE "Prospect" ADD COLUMN "email" TEXT;
ALTER TABLE "Prospect" ADD COLUMN "placeId" TEXT;
ALTER TABLE "Prospect" ADD COLUMN "city" TEXT;

CREATE TABLE "MapsPlace" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "audienceId" TEXT,
    "placeId" TEXT NOT NULL,
    "domain" TEXT,
    "name" TEXT,
    "address" TEXT,
    "city" TEXT,
    "status" TEXT NOT NULL,
    "people" INTEGER NOT NULL DEFAULT 0,
    "query" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MapsPlace_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MapsPlace_organizationId_placeId_key" ON "MapsPlace"("organizationId", "placeId");
CREATE INDEX "MapsPlace_organizationId_domain_idx" ON "MapsPlace"("organizationId", "domain");
CREATE INDEX "MapsPlace_createdAt_idx" ON "MapsPlace"("createdAt");
ALTER TABLE "MapsPlace" ADD CONSTRAINT "MapsPlace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
