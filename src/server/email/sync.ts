import type { Db } from "@/lib/db";
import { audit } from "../audit";
import type { LlmClient } from "../ai/llm";
import { mailboxFor, type MailboxClient } from "./mailbox";
import { ingestRawEmail } from "./ingest";

const BATCH = 200;

/** Pull new INBOX messages by UID and ingest them. Re-running is safe (dedupe by Message-ID). */
export async function syncAccount(db: Db, accountId: string, deps: { mailbox?: MailboxClient | null; llm?: LlmClient } = {}) {
  const account = await db.emailAccount.findUniqueOrThrow({ where: { id: accountId } });
  if (!account.enabled) return { skipped: "disabled" as const };
  const mailbox = deps.mailbox !== undefined ? deps.mailbox : mailboxFor(account);
  if (!mailbox) return { skipped: "simulated" as const };
  try {
    let lastUid = account.imapLastUid;
    let res = await mailbox.fetchSince(lastUid, BATCH);
    if (account.imapUidValidity != null && res.uidValidity !== account.imapUidValidity) {
      // Mailbox was rebuilt: UIDs restarted. Re-scan; Message-ID dedupe prevents duplicates.
      lastUid = 0;
      res = await mailbox.fetchSince(0, BATCH);
    }
    const counts = { stored: 0, duplicate: 0, ignored: 0, failed: 0 };
    for (const m of res.messages) {
      try {
        counts[(await ingestRawEmail(db, accountId, m.raw, { llm: deps.llm })).status]++;
      } catch (e) {
        counts.failed++;
        console.error("[email.sync] ingest failed", accountId, m.uid, e);
      }
      lastUid = Math.max(lastUid, m.uid);
    }
    await db.emailAccount.update({ where: { id: accountId }, data: { imapLastUid: lastUid, imapUidValidity: res.uidValidity, lastSyncAt: new Date(), lastSyncError: null } });
    if (counts.stored) await audit(db, { actorType: "job", action: "email.sync", entityType: "email_account", entityId: accountId, metadata: counts });
    return counts;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.emailAccount.update({ where: { id: accountId }, data: { lastSyncAt: new Date(), lastSyncError: message.slice(0, 300) } });
    throw e;
  }
}

export async function syncAllAccounts(db: Db) {
  const accounts = await db.emailAccount.findMany({ where: { enabled: true, isSimulated: false } });
  const results: Record<string, unknown> = {};
  for (const a of accounts) {
    try {
      results[a.fromAddress] = await syncAccount(db, a.id);
    } catch (e) {
      results[a.fromAddress] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return results;
}
