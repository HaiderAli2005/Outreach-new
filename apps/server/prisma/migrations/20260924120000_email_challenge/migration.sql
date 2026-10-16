-- CreateEnum
CREATE TYPE "ChallengePurpose" AS ENUM ('VERIFY', 'RESET');

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('PENDING', 'APPROVED', 'FAILED', 'EXPIRED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- Accounts that existed before email verification keep signing in as before.
UPDATE "User" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;

-- CreateTable
CREATE TABLE "EmailChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "ChallengePurpose" NOT NULL,
    "token" TEXT NOT NULL,
    "matchNumber" INTEGER NOT NULL,
    "decoyOne" INTEGER NOT NULL,
    "decoyTwo" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "consumedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredIp" TEXT,
    "answeredAgent" TEXT,

    CONSTRAINT "EmailChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailChallenge_token_key" ON "EmailChallenge"("token");

-- CreateIndex
CREATE INDEX "EmailChallenge_userId_purpose_status_idx" ON "EmailChallenge"("userId", "purpose", "status");

-- CreateIndex
CREATE INDEX "EmailChallenge_expiresAt_idx" ON "EmailChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "EmailChallenge" ADD CONSTRAINT "EmailChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

