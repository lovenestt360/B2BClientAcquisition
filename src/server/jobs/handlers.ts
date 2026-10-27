import type { Db } from "@/lib/db";
import { commitImport } from "../import/service";
import { generateSmsDrafts } from "../messaging/sms";
import { sendEmailDraft } from "../email/send";
import { syncAllAccounts } from "../email/sync";
import { runOutreachBatch } from "../outreach/sequence";
import { runStopWatch } from "../outreach/stops";
import { enrichImportBatch } from "../research/import-enrichment";

export const handlers = {
  "import.commit": async (db: Db, p: { batchId: string; userId: string | null }) => {
    const b = await commitImport(db, p.batchId, p.userId);
    const research = await enrichImportBatch(db, p.batchId, p.userId);
    return { created: b.createdRows, merged: b.mergedRows, researched: research.length, unresolved: research.filter((r) => r.unresolved.length).length };
  },
  "import.enrich": async (db: Db, p: { batchId: string; userId: string | null }) => {
    const research = await enrichImportBatch(db, p.batchId, p.userId);
    return { researched: research.length, unresolved: research.filter((r) => r.unresolved.length).length };
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
  // Sequence batch: live only when every launch condition holds, otherwise a dry run.
  // Idempotent per prospect + campaign + step, so a retried tick never duplicates a send.
  "outreach.batch": async (db: Db) => {
    const r = await runOutreachBatch(db);
    return { mode: r.mode, slot: r.slot, outcomes: r.outcomes.length };
  },
  "outreach.stop_watch": async (db: Db) => runStopWatch(db),
};

export type QueueName = keyof typeof handlers;
