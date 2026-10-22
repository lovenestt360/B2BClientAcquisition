-- AlterTable
ALTER TABLE "campaign_members" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "lastConfirmedSendAt" TIMESTAMP(3),
ADD COLUMN     "lastStep" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextDueAt" TIMESTAMP(3),
ADD COLUMN     "state" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
ADD COLUMN     "stopReason" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "country" TEXT,
ADD COLUMN     "key" TEXT;

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "emailVerificationStatus" TEXT;

-- AlterTable
ALTER TABLE "research_facts" ADD COLUMN     "contactId" TEXT,
ADD COLUMN     "isInference" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'fact',
ALTER COLUMN "companyId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "outreach_steps" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "waitDays" INTEGER,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_sends" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "reasonCodes" JSONB,
    "subject" TEXT,
    "body" TEXT,
    "generation" JSONB,
    "validation" JSONB,
    "generatedBy" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "batchAt" TIMESTAMP(3),
    "messageDraftId" TEXT,
    "providerMessageId" TEXT,
    "smtpResponse" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outreach_steps_campaignId_step_key" ON "outreach_steps"("campaignId", "step");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_sends_idempotencyKey_key" ON "outreach_sends"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_sends_messageDraftId_key" ON "outreach_sends"("messageDraftId");

-- CreateIndex
CREATE INDEX "outreach_sends_status_confirmedAt_idx" ON "outreach_sends"("status", "confirmedAt");

-- CreateIndex
CREATE INDEX "outreach_sends_memberId_step_idx" ON "outreach_sends"("memberId", "step");

-- CreateIndex
CREATE INDEX "campaign_members_state_nextDueAt_idx" ON "campaign_members"("state", "nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_key_key" ON "campaigns"("key");

-- CreateIndex
CREATE INDEX "research_facts_contactId_idx" ON "research_facts"("contactId");

-- AddForeignKey
ALTER TABLE "research_facts" ADD CONSTRAINT "research_facts_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_steps" ADD CONSTRAINT "outreach_steps_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_sends" ADD CONSTRAINT "outreach_sends_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_sends" ADD CONSTRAINT "outreach_sends_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "campaign_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_sends" ADD CONSTRAINT "outreach_sends_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

