-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "handledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sms_events" ADD COLUMN     "handledAt" TIMESTAMP(3);

