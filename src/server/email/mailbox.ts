import { ImapFlow } from "imapflow";
import type { EmailAccount } from "@prisma/client";
import { credentials } from "./transport";

export interface FetchedMessage {
  uid: number;
  raw: Buffer;
}

export interface FetchResult {
  uidValidity: bigint;
  messages: FetchedMessage[];
}

/** IMAP abstraction (INBOX only). */
export interface MailboxClient {
  verify(): Promise<void>;
  fetchSince(lastUid: number, limit: number): Promise<FetchResult>;
}

export class ImapMailbox implements MailboxClient {
  constructor(
    private account: EmailAccount,
    private password: string,
  ) {}

  private client() {
    return new ImapFlow({
      host: this.account.imapHost,
      port: this.account.imapPort,
      secure: this.account.imapSecure,
      auth: { user: this.account.username, pass: this.password },
      logger: false,
      socketTimeout: 60_000,
    });
  }

  async verify() {
    const c = this.client();
    await c.connect();
    await c.logout();
  }

  async fetchSince(lastUid: number, limit: number): Promise<FetchResult> {
    const c = this.client();
    await c.connect();
    const lock = await c.getMailboxLock("INBOX", { readOnly: true });
    try {
      const mailbox = c.mailbox as { uidValidity: bigint };
      const messages: FetchedMessage[] = [];
      // "n:*" always returns the newest message even if its UID < n, so filter.
      for await (const m of c.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (m.uid > lastUid && m.source) messages.push({ uid: m.uid, raw: m.source });
        if (messages.length >= limit) break;
      }
      return { uidValidity: BigInt(mailbox.uidValidity), messages: messages.sort((a, b) => a.uid - b.uid) };
    } finally {
      lock.release();
      await c.logout();
    }
  }
}

export function mailboxFor(account: EmailAccount): MailboxClient | null {
  if (account.isSimulated) return null; // simulated replies are injected directly
  return new ImapMailbox(account, credentials(account).password);
}
