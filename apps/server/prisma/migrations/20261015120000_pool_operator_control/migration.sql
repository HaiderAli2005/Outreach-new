ALTER TABLE "SendingDomain" ADD COLUMN "degradeReason" TEXT,
  ADD COLUMN "degradeBounceRate" DECIMAL(5,4),
  ADD COLUMN "degradeSends" INTEGER,
  ADD COLUMN "forcedActiveAt" TIMESTAMP(3),
  ADD COLUMN "forcedActiveById" TEXT,
  ADD COLUMN "forcedActiveReason" TEXT,
  ADD COLUMN "forcedFromDay" INTEGER;

ALTER TABLE "Mailbox" ADD COLUMN "degradeReason" TEXT;

CREATE TABLE "PoolSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "spareDomainsMin" INTEGER NOT NULL DEFAULT 15,
    "spareMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.0,
    "maxBuyPerBatch" INTEGER NOT NULL DEFAULT 5,
    "maxBuyPerDay" INTEGER NOT NULL DEFAULT 10,
    "autoBuyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PoolSettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "PoolSettings" ("id", "updatedAt") VALUES ('default', CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
