-- AlterTable
ALTER TABLE "email_accounts" ADD COLUMN     "fromName" TEXT NOT NULL,
ADD COLUMN     "imapLastUid" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "imapSecure" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "imapUidValidity" BIGINT,
ADD COLUMN     "isSimulated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncError" TEXT,
ADD COLUMN     "lastTestAt" TIMESTAMP(3),
ADD COLUMN     "lastTestResult" TEXT,
ADD COLUMN     "smtpSecure" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "username" TEXT NOT NULL,
ALTER COLUMN "encryptedSecrets" DROP NOT NULL,
ALTER COLUMN "dailyLimit" SET DEFAULT 30;

-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "bounceCode" TEXT,
ADD COLUMN     "bounceType" TEXT,
ADD COLUMN     "classificationSource" TEXT,
ADD COLUMN     "deliveryEvidence" TEXT,
ADD COLUMN     "draftId" TEXT,
ADD COLUMN     "fromAddress" TEXT NOT NULL,
ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "references" TEXT,
ADD COLUMN     "smtpResponse" TEXT,
ADD COLUMN     "toAddress" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "message_drafts" ADD COLUMN     "emailAccountId" TEXT,
ADD COLUMN     "lastError" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_draftId_key" ON "email_messages"("draftId");

-- CreateIndex
CREATE INDEX "email_messages_contactId_occurredAt_idx" ON "email_messages"("contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "email_messages_accountId_direction_idx" ON "email_messages"("accountId", "direction");

-- AddForeignKey
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "email_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "message_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "email_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

