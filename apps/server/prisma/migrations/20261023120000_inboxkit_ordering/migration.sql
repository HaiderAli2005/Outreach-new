-- Ordering domains and mailboxes through InboxKit, with InboxKit's warmup before Aperture's ladder.

-- Pool domains: who supplied them and their supplier warmup.
ALTER TABLE "SendingDomain" ADD COLUMN "supplier" TEXT;
ALTER TABLE "SendingDomain" ADD COLUMN "externalWarmup" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SendingDomain" ADD COLUMN "warmupTargetDays" INTEGER;
ALTER TABLE "SendingDomain" ADD COLUMN "supplierWarmupAt" TIMESTAMP(3);
ALTER TABLE "SendingDomain" ADD COLUMN "supplierSyncedAt" TIMESTAMP(3);

-- Mailboxes: the supplier's warmup health, and when Aperture asked the supplier to cancel a retired mailbox.
ALTER TABLE "Mailbox" ADD COLUMN "supplierWarmupStatus" TEXT;
ALTER TABLE "Mailbox" ADD COLUMN "warmupHealth" TEXT;
ALTER TABLE "Mailbox" ADD COLUMN "warmupScore" DECIMAL(5,2);
ALTER TABLE "Mailbox" ADD COLUMN "warmupInboxRate" DECIMAL(5,2);
ALTER TABLE "Mailbox" ADD COLUMN "supplierWarmupDay" INTEGER;
ALTER TABLE "Mailbox" ADD COLUMN "supplierSyncedAt" TIMESTAMP(3);
ALTER TABLE "Mailbox" ADD COLUMN "supplierCancelRequestedAt" TIMESTAMP(3);

-- InboxKit settings (one row). The API key lives in the secret store.
CREATE TABLE "InboxKitSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "workspaceUid" TEXT,
    "workspaceName" TEXT,
    "contact" JSONB,
    "redirectUrl" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'GOOGLE',
    "warmupDays" INTEGER NOT NULL DEFAULT 28,
    "keepWarmupAfterLive" BOOLEAN NOT NULL DEFAULT true,
    "maxDomainPriceUsd" DECIMAL(8,2) NOT NULL DEFAULT 20.00,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxKitSettings_pkey" PRIMARY KEY ("id")
);

-- Orders.
CREATE TYPE "SupplierOrderStatus" AS ENUM ('QUOTED', 'SCHEDULED', 'WAITING_FOR_FUNDS', 'DONE', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "SupplierOrderItemStatus" AS ENUM ('PENDING', 'PLACING', 'PLACED', 'REJECTED');

CREATE TABLE "SupplierOrder" (
    "id" TEXT NOT NULL,
    "supplier" TEXT NOT NULL DEFAULT 'inboxkit',
    "status" "SupplierOrderStatus" NOT NULL DEFAULT 'QUOTED',
    "platform" TEXT NOT NULL DEFAULT 'GOOGLE',
    "region" TEXT NOT NULL DEFAULT 'global',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "warmup" BOOLEAN NOT NULL DEFAULT true,
    "requested" INTEGER NOT NULL,
    "estimate" JSONB NOT NULL,
    "lastError" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierOrder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupplierOrder_status_nextRunAt_idx" ON "SupplierOrder"("status", "nextRunAt");

CREATE TABLE "SupplierOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "domainName" TEXT NOT NULL,
    "priceUsd" DECIMAL(8,2),
    "mailboxes" JSONB NOT NULL,
    "status" "SupplierOrderItemStatus" NOT NULL DEFAULT 'PENDING',
    "externalOrderId" TEXT,
    "message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "placingAt" TIMESTAMP(3),
    "placedAt" TIMESTAMP(3),
    "sendingDomainId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierOrderItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupplierOrderItem_sendingDomainId_key" ON "SupplierOrderItem"("sendingDomainId");
CREATE INDEX "SupplierOrderItem_orderId_status_idx" ON "SupplierOrderItem"("orderId", "status");
CREATE INDEX "SupplierOrderItem_domainName_idx" ON "SupplierOrderItem"("domainName");
ALTER TABLE "SupplierOrderItem" ADD CONSTRAINT "SupplierOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SupplierOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierOrderItem" ADD CONSTRAINT "SupplierOrderItem_sendingDomainId_fkey" FOREIGN KEY ("sendingDomainId") REFERENCES "SendingDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
