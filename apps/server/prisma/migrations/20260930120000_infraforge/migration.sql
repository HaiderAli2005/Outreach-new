-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MailboxStatus" ADD VALUE 'CREATING';
ALTER TYPE "MailboxStatus" ADD VALUE 'CONNECTING';
ALTER TYPE "MailboxStatus" ADD VALUE 'RELEASED';

-- AlterEnum
ALTER TYPE "SendingDomainStatus" ADD VALUE 'REGISTERING';

-- AlterTable
ALTER TABLE "Mailbox" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "nextCheckAt" TIMESTAMP(3),
ADD COLUMN     "providerId" TEXT,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "sendCap" INTEGER,
ADD COLUMN     "warmupStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SendingDomain" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "autoRenew" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "dnsVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextCheckAt" TIMESTAMP(3),
ADD COLUMN     "prewarmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "providerId" TEXT,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "registeredAt" TIMESTAMP(3),
ADD COLUMN     "replacedName" TEXT,
ADD COLUMN     "sslAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "InfraWorkspace" (
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'infraforge',
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dedicatedIp" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "heldReason" TEXT,
    "heldAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfraWorkspace_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "InfraWorkspace_workspaceId_key" ON "InfraWorkspace"("workspaceId");

-- CreateIndex
CREATE INDEX "Mailbox_status_idx" ON "Mailbox"("status");

-- CreateIndex
CREATE INDEX "SendingDomain_status_idx" ON "SendingDomain"("status");

-- AddForeignKey
ALTER TABLE "InfraWorkspace" ADD CONSTRAINT "InfraWorkspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

