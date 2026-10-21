import type { Db } from "@/lib/db";
import { commitImport } from "../import/service";
import { generateSmsDrafts } from "../messaging/sms";

export const handlers = {
  "import.commit": async (db: Db, p: { batchId: string; userId: string | null }) => {
    const b = await commitImport(db, p.batchId, p.userId);
    return { created: b.createdRows, merged: b.mergedRows };
  },
  // Drafts are idempotent per contact/purpose/day, so a retried job never duplicates them.
  "sms.generate_drafts": async (
    db: Db,
    p: { contactIds: string[]; userId: string; campaignId?: string; purpose?: "marketing" | "consent_request"; providerKey?: string },
  ) => generateSmsDrafts(db, p),
};

export type QueueName = keyof typeof handlers;
