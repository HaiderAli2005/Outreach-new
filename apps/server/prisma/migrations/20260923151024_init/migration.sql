-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'INVITED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('INCOMPLETE', 'INCOMPLETE_EXPIRED', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'UNPAID', 'CANCELED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('REQUIRES_PAYMENT', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "WebhookProvider" AS ENUM ('STRIPE', 'SMARTLEAD', 'CALENDLY', 'APOLLO');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "SendingDomainStatus" AS ENUM ('SELECTED', 'PENDING_REGISTRATION', 'REGISTERED', 'FAILED');

-- CreateEnum
CREATE TYPE "MailboxStatus" AS ENUM ('PLANNED', 'PENDING', 'WARMING', 'ACTIVE', 'ERROR');

-- CreateEnum
CREATE TYPE "AutoReplyMode" AS ENUM ('OFF', 'SHADOW', 'CANARY', 'LIVE');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('APOLLO', 'SMARTLEAD', 'MILLIONVERIFIER', 'SLACK_WEBHOOK');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('NEW', 'PERSONALIZED', 'QUEUED', 'CONTACTED', 'REPLIED', 'NO_RESPONSE', 'BLOCKLISTED', 'UNSUBSCRIBED', 'BOUNCED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AutoReplyStatus" AS ENUM ('AUTO', 'MANUAL', 'PAUSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "BlockEntryType" AS ENUM ('EMAIL', 'DOMAIN');

-- CreateEnum
CREATE TYPE "BlockReason" AS ENUM ('ALREADY_CONTACTED', 'NO_RESPONSE', 'UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'MANUAL', 'COMPETITOR', 'CUSTOMER', 'DEAL_CLOSED', 'REMOVED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('SOURCING', 'REVIEW', 'APPROVED', 'SENDING', 'DONE');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR', 'CRITICAL');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryDomain" TEXT,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "stripeCustomerId" TEXT,
    "webhookToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "invitedEmail" TEXT,
    "inviteTokenHash" TEXT,
    "inviteExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxDailyVolume" INTEGER NOT NULL,
    "priceMonthlyCents" INTEGER NOT NULL,
    "maxCampaigns" INTEGER,
    "features" JSONB NOT NULL,
    "stripePriceId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'INCOMPLETE',
    "stripeSubscriptionId" TEXT,
    "dailyVolume" INTEGER NOT NULL,
    "inboxQuantity" INTEGER NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT NOT NULL,
    "stripeInvoiceId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "amountRefundedCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "PaymentStatus" NOT NULL DEFAULT 'REQUIRES_PAYMENT',
    "failureMessage" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "stripeRefundId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "stripeInvoiceId" TEXT NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL,
    "amountDueCents" INTEGER NOT NULL,
    "amountPaidCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "hostedInvoiceUrl" TEXT,
    "pdfUrl" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" "WebhookProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "organizationId" TEXT,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Onboarding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "summary" TEXT,
    "icp" JSONB NOT NULL,
    "preview" JSONB,
    "volume" INTEGER NOT NULL DEFAULT 1000,
    "warmupDays" INTEGER NOT NULL DEFAULT 21,
    "inboxesPerDomain" INTEGER NOT NULL DEFAULT 3,
    "provider" TEXT NOT NULL DEFAULT 'google',
    "analyzedAt" TIMESTAMP(3),
    "analysisError" TEXT,
    "paidAt" TIMESTAMP(3),
    "launchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Onboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SendingDomain" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "status" "SendingDomainStatus" NOT NULL DEFAULT 'SELECTED',
    "forwardTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SendingDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sendingDomainId" TEXT,
    "address" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'google',
    "status" "MailboxStatus" NOT NULL DEFAULT 'PLANNED',
    "smartleadAccountId" TEXT,
    "warmupDays" INTEGER NOT NULL DEFAULT 21,
    "dailyLimit" INTEGER NOT NULL DEFAULT 40,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgSettings" (
    "organizationId" TEXT NOT NULL,
    "autopilotEnabled" BOOLEAN NOT NULL DEFAULT false,
    "weeklyBatchMode" BOOLEAN NOT NULL DEFAULT true,
    "autoApproveBatches" BOOLEAN NOT NULL DEFAULT false,
    "defaultDailySendCap" INTEGER NOT NULL DEFAULT 100,
    "perMailboxDailyCap" INTEGER NOT NULL DEFAULT 30,
    "blocklistNoReplyDays" INTEGER NOT NULL DEFAULT 7,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "sendingWindowStart" TEXT NOT NULL DEFAULT '09:00',
    "sendingWindowEnd" TEXT NOT NULL DEFAULT '17:00',
    "language" TEXT NOT NULL DEFAULT 'en',
    "personalizationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "requireVerifiedEmail" BOOLEAN NOT NULL DEFAULT true,
    "monthlyCreditCap" INTEGER NOT NULL DEFAULT 0,
    "dailyCreditCap" INTEGER NOT NULL DEFAULT 0,
    "dailySourceTarget" INTEGER NOT NULL DEFAULT 100,
    "expectedBounceRate" DOUBLE PRECISION NOT NULL DEFAULT 0.18,
    "apolloCycleResetDay" INTEGER NOT NULL DEFAULT 1,
    "perCompanyContactCap" INTEGER NOT NULL DEFAULT 2,
    "senderName" TEXT,
    "senderCompany" TEXT,
    "senderTitle" TEXT,
    "senderAddress" TEXT,
    "meetingLink" TEXT,
    "valueProp" TEXT,
    "optOutLine" TEXT,
    "brandProfile" JSONB,
    "smartleadDefaultCampaignId" TEXT,
    "smartleadMailboxIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "slackChannel" TEXT,
    "browserNotifications" BOOLEAN NOT NULL DEFAULT false,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoReplyMode" "AutoReplyMode" NOT NULL DEFAULT 'OFF',
    "autoReplyKillSwitch" BOOLEAN NOT NULL DEFAULT false,
    "autoReplyMinConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    "autoReplyMaxTurns" INTEGER NOT NULL DEFAULT 10,
    "autoReplyMaxAutoSends" INTEGER NOT NULL DEFAULT 4,
    "autoReplyDailyCap" INTEGER NOT NULL DEFAULT 10,
    "autoReplyThreadGapMinutes" INTEGER NOT NULL DEFAULT 60,
    "autoReplyWindowStart" INTEGER NOT NULL DEFAULT 8,
    "autoReplyWindowEnd" INTEGER NOT NULL DEFAULT 18,
    "autoReplyCanaryCampaigns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoReplySoftAck" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "niche" TEXT,
    "marketBrief" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "language" TEXT NOT NULL DEFAULT 'en',
    "smartleadCampaignId" TEXT,
    "apolloFilters" JSONB NOT NULL DEFAULT '{}',
    "dailySendCap" INTEGER NOT NULL DEFAULT 50,
    "sourcePage" INTEGER NOT NULL DEFAULT 1,
    "saturatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "website" TEXT,
    "industry" TEXT,
    "employees" INTEGER,
    "description" TEXT,
    "linkedinUrl" TEXT,
    "city" TEXT,
    "country" TEXT,
    "technologies" JSONB,
    "keywords" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "domain" TEXT,
    "companyDomain" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "fullName" TEXT,
    "title" TEXT,
    "company" TEXT,
    "website" TEXT,
    "linkedinUrl" TEXT,
    "location" TEXT,
    "city" TEXT,
    "country" TEXT,
    "phone" TEXT,
    "industry" TEXT,
    "seniority" TEXT,
    "headline" TEXT,
    "photoUrl" TEXT,
    "apolloId" TEXT,
    "campaignId" TEXT,
    "batchId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'apollo',
    "status" "ContactStatus" NOT NULL DEFAULT 'NEW',
    "personalizationStatus" TEXT NOT NULL DEFAULT 'pending',
    "personalization" TEXT,
    "messageSubject" TEXT,
    "followup2" TEXT,
    "followup3" TEXT,
    "emailStatus" TEXT,
    "verifyResult" TEXT,
    "verifyQuality" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "fitScore" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT,
    "smartleadLeadId" TEXT,
    "smartleadCampaignId" TEXT,
    "firstContactedAt" TIMESTAMP(3),
    "lastContactedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "replyClass" TEXT,
    "replyUrgent" BOOLEAN NOT NULL DEFAULT false,
    "aiDraft" TEXT,
    "aiDraftAt" TIMESTAMP(3),
    "followUpAt" TIMESTAMP(3),
    "handledAt" TIMESTAMP(3),
    "meetingBookedAt" TIMESTAMP(3),
    "autoReplyStatus" "AutoReplyStatus" NOT NULL DEFAULT 'AUTO',
    "autoReplyCount" INTEGER NOT NULL DEFAULT 0,
    "lastAutoReplyAt" TIMESTAMP(3),
    "linkSentAt" TIMESTAMP(3),
    "handoffAt" TIMESTAMP(3),
    "neverAuto" BOOLEAN NOT NULL DEFAULT false,
    "lastEscalationReason" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessageDirection" "MessageDirection",
    "lastMessagePreview" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "hasInbound" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "campaignId" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "via" TEXT,
    "subject" TEXT,
    "body" TEXT,
    "intent" TEXT,
    "classifyStartedAt" TIMESTAMP(3),
    "classifyAttempts" INTEGER NOT NULL DEFAULT 0,
    "smartleadStatsId" TEXT,
    "smartleadMessageId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlocklistEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entryType" "BlockEntryType" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" "BlockReason" NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "contactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlocklistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'SOURCING',
    "targetClean" INTEGER NOT NULL DEFAULT 0,
    "sourcedClean" INTEGER NOT NULL DEFAULT 0,
    "excludedCount" INTEGER NOT NULL DEFAULT 0,
    "approvedCount" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "lastNagAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoReplyQueue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "triggerMessageId" TEXT NOT NULL,
    "replyClass" TEXT,
    "language" TEXT,
    "draft" TEXT NOT NULL,
    "includeLink" BOOLEAN NOT NULL DEFAULT false,
    "sendAfter" TIMESTAMP(3) NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cancelReason" TEXT,
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoReplyQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoReplyDecision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT,
    "messageId" TEXT,
    "mode" TEXT NOT NULL,
    "replyClass" TEXT,
    "wouldSend" BOOLEAN NOT NULL DEFAULT false,
    "skipReason" TEXT,
    "confidence" DOUBLE PRECISION,
    "language" TEXT,
    "includeLink" BOOLEAN NOT NULL DEFAULT false,
    "turnCount" INTEGER,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoReplyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "level" "LogLevel" NOT NULL DEFAULT 'ERROR',
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "peopleEnriched" INTEGER NOT NULL DEFAULT 0,
    "searches" INTEGER NOT NULL DEFAULT 0,
    "emailsVerified" INTEGER NOT NULL DEFAULT 0,
    "aiCalls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "OAuthAccount_userId_idx" ON "OAuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_providerAccountId_key" ON "OAuthAccount"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_stripeCustomerId_key" ON "Organization"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_webhookToken_key" ON "Organization"("webhookToken");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_inviteTokenHash_key" ON "Membership"("inviteTokenHash");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_organizationId_userId_key" ON "Membership"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_organizationId_invitedEmail_key" ON "Membership"("organizationId", "invitedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organizationId_key" ON "Subscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "Payment_organizationId_createdAt_idx" ON "Payment"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_stripeRefundId_key" ON "Refund"("stripeRefundId");

-- CreateIndex
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_stripeInvoiceId_key" ON "Invoice"("stripeInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_createdAt_idx" ON "Invoice"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_provider_receivedAt_idx" ON "WebhookEvent"("provider", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_idx" ON "WebhookEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_externalId_key" ON "WebhookEvent"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Onboarding_organizationId_key" ON "Onboarding"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "SendingDomain_organizationId_name_key" ON "SendingDomain"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_organizationId_address_key" ON "Mailbox"("organizationId", "address");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_organizationId_provider_key" ON "IntegrationCredential"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_smartleadCampaignId_key" ON "Campaign"("smartleadCampaignId");

-- CreateIndex
CREATE INDEX "Campaign_organizationId_status_idx" ON "Campaign"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Company_organizationId_domain_key" ON "Company"("organizationId", "domain");

-- CreateIndex
CREATE INDEX "Contact_organizationId_status_idx" ON "Contact"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Contact_organizationId_campaignId_idx" ON "Contact"("organizationId", "campaignId");

-- CreateIndex
CREATE INDEX "Contact_organizationId_batchId_idx" ON "Contact"("organizationId", "batchId");

-- CreateIndex
CREATE INDEX "Contact_organizationId_companyDomain_idx" ON "Contact"("organizationId", "companyDomain");

-- CreateIndex
CREATE INDEX "Contact_organizationId_replyUrgent_idx" ON "Contact"("organizationId", "replyUrgent");

-- CreateIndex
CREATE INDEX "Contact_organizationId_lastMessageAt_idx" ON "Contact"("organizationId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Contact_organizationId_lastContactedAt_idx" ON "Contact"("organizationId", "lastContactedAt");

-- CreateIndex
CREATE INDEX "Contact_organizationId_fitScore_idx" ON "Contact"("organizationId", "fitScore");

-- CreateIndex
CREATE INDEX "Contact_smartleadLeadId_idx" ON "Contact"("smartleadLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_organizationId_emailNormalized_key" ON "Contact"("organizationId", "emailNormalized");

-- CreateIndex
CREATE INDEX "Message_organizationId_contactId_createdAt_idx" ON "Message"("organizationId", "contactId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_organizationId_direction_createdAt_idx" ON "Message"("organizationId", "direction", "createdAt");

-- CreateIndex
CREATE INDEX "Message_organizationId_intent_idx" ON "Message"("organizationId", "intent");

-- CreateIndex
CREATE INDEX "BlocklistEntry_organizationId_reason_idx" ON "BlocklistEntry"("organizationId", "reason");

-- CreateIndex
CREATE INDEX "BlocklistEntry_organizationId_createdAt_idx" ON "BlocklistEntry"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BlocklistEntry_organizationId_entryType_value_key" ON "BlocklistEntry"("organizationId", "entryType", "value");

-- CreateIndex
CREATE INDEX "WeeklyBatch_organizationId_status_idx" ON "WeeklyBatch"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyBatch_organizationId_weekStart_key" ON "WeeklyBatch"("organizationId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "AutoReplyQueue_triggerMessageId_key" ON "AutoReplyQueue"("triggerMessageId");

-- CreateIndex
CREATE INDEX "AutoReplyQueue_organizationId_status_sendAfter_idx" ON "AutoReplyQueue"("organizationId", "status", "sendAfter");

-- CreateIndex
CREATE INDEX "AutoReplyQueue_contactId_idx" ON "AutoReplyQueue"("contactId");

-- CreateIndex
CREATE INDEX "AutoReplyDecision_organizationId_createdAt_idx" ON "AutoReplyDecision"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "SystemLog_organizationId_resolvedAt_level_idx" ON "SystemLog"("organizationId", "resolvedAt", "level");

-- CreateIndex
CREATE INDEX "SystemLog_createdAt_idx" ON "SystemLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_organizationId_day_key" ON "UsageCounter"("organizationId", "day");

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Onboarding" ADD CONSTRAINT "Onboarding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SendingDomain" ADD CONSTRAINT "SendingDomain_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_sendingDomainId_fkey" FOREIGN KEY ("sendingDomainId") REFERENCES "SendingDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgSettings" ADD CONSTRAINT "OrgSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "WeeklyBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlocklistEntry" ADD CONSTRAINT "BlocklistEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyBatch" ADD CONSTRAINT "WeeklyBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoReplyQueue" ADD CONSTRAINT "AutoReplyQueue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoReplyDecision" ADD CONSTRAINT "AutoReplyDecision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemLog" ADD CONSTRAINT "SystemLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
