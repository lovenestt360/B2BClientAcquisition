/*
  Warnings:

  - You are about to drop the column `providerId` on the `airtime_entries` table. All the data in the column will be lost.
  - Added the required column `lineId` to the `airtime_entries` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "airtime_entries" DROP CONSTRAINT "airtime_entries_providerId_fkey";

-- DropIndex
DROP INDEX "airtime_entries_providerId_createdAt_idx";

-- AlterTable
ALTER TABLE "airtime_entries" DROP COLUMN "providerId",
ADD COLUMN     "estimated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lineId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "calls" ADD COLUMN     "engineState" JSONB;

-- AlterTable
ALTER TABLE "provider_configs" ADD COLUMN     "lineId" TEXT;

-- CreateTable
CREATE TABLE "carrier_lines" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "simType" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'ZA',
    "ownNumberE164" TEXT,
    "testNumberE164" TEXT,
    "smsRateCents" INTEGER,
    "callRatePerMinCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'ZAR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carrier_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "carrier_lines_key_key" ON "carrier_lines"("key");

-- CreateIndex
CREATE INDEX "airtime_entries_lineId_createdAt_idx" ON "airtime_entries"("lineId", "createdAt");

-- AddForeignKey
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "carrier_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "airtime_entries" ADD CONSTRAINT "airtime_entries_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "carrier_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
