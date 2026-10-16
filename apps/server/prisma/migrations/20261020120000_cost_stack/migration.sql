-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "aiPrices" JSONB NOT NULL,
    "apolloPerEnrichUsd" DECIMAL(12,6) NOT NULL,
    "apolloPerSearchUsd" DECIMAL(12,6) NOT NULL,
    "verifyPerEmailUsd" DECIMAL(12,6) NOT NULL,
    "paymentFeePercent" DECIMAL(6,3) NOT NULL,
    "paymentFeeFixedUsd" DECIMAL(8,4) NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_createdAt_idx" ON "ai_usage"("createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_organizationId_createdAt_idx" ON "ai_usage"("organizationId", "createdAt");
