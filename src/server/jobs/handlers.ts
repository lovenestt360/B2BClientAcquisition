import type { Db } from "@/lib/db";
import { commitImport } from "../import/service";
import { generateSmsDrafts } from "../messaging/sms";
import { sendEmailDraft } from "../email/send";
import { syncAllAccounts } from "../email/sync";

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
  // sendEmailDraft records the attempt before SMTP, so a retry never sends twice.
  "email.send": async (db: Db, p: { draftId: string; userId: string | null; role?: string }) => {
    const m = await sendEmailDraft(db, p.draftId, p.userId ? { id: p.userId, role: p.role ?? "OPERATOR" } : null);
    return { messageId: m.messageId, deliveryState: m.deliveryState };
  },
  "email.sync_all": async (db: Db) => syncAllAccounts(db),
};

export type QueueName = keyof typeof handlers;
