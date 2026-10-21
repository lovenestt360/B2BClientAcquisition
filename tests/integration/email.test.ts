import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";
import type { AddressInfo } from "node:net";
import { db, makeContact, resetDb, setupOutreach } from "./helpers";
import { saveEmailAccount, seedSimulatedMailbox, setEmailAccountEnabled, testEmailAccount } from "@/server/email/accounts";
import { generateEmailDrafts } from "@/server/email/drafts";
import { approveEmailDraft, sendEmailDraft } from "@/server/email/send";
import { ingestRawEmail } from "@/server/email/ingest";
import { syncAccount } from "@/server/email/sync";
import { buildSimulatedRaw, simulateReply } from "@/server/email/simulate";
import { SmtpTransport, type MailTransport } from "@/server/email/transport";
import type { MailboxClient } from "@/server/email/mailbox";
import { MockLlmClient } from "@/server/ai/llm";
import { setClock } from "@/server/clock";

// ── in-process SMTP server ──
const received: ParsedMail[] = [];
let port = 0;
const server = new SMTPServer({
  authOptional: true,
  allowInsecureAuth: true,
  disabledCommands: ["STARTTLS"],
  logger: false,
  onAuth: (_a, _s, cb) => cb(null, { user: "test" }),
  onRcptTo: (addr, _s, cb) => (addr.address.startsWith("nobody") ? cb(Object.assign(new Error("5.1.1 No such user"), { responseCode: 550 })) : cb()),
  onData: (stream, _s, cb) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", async () => {
      received.push(await simpleParser(Buffer.concat(chunks)));
      cb();
    });
  },
});
beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => ((port = (server.server.address() as AddressInfo).port), r()))));
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(async () => {
  received.length = 0;
  await resetDb();
});
afterEach(() => setClock(null));

const llm = new MockLlmClient();

async function realAccount(adminId: string) {
  const a = await saveEmailAccount(db, null, { label: "Hostinger", fromName: "Sam Seller", fromAddress: "Sam@Acme.example", password: "s3cret-pass", smtpPort: "465" }, adminId);
  await db.emailAccount.update({ where: { id: a.id }, data: { lastTestResult: "ok", enabled: true } });
  return db.emailAccount.findUniqueOrThrow({ where: { id: a.id } });
}
const localSmtp = (account: Awaited<ReturnType<typeof realAccount>>): MailTransport =>
  new SmtpTransport({ ...account, smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false }, "s3cret-pass", { requireTLS: false, ignoreTLS: true });

async function consented(over: Parameters<typeof makeContact>[0] = {}) {
  const c = await makeContact(over);
  await db.marketingPermission.create({ data: { contactId: c.id, channel: "EMAIL", status: "GRANTED", basis: "CONSENT", evidence: "web form", capturedAt: new Date("2026-10-01") } });
  return c;
}

async function approvedDraft(accountId: string, adminId: string, actor: { id: string; role: string }, over: Parameters<typeof makeContact>[0] = {}) {
  const c = await consented(over);
  const r = await generateEmailDrafts(db, { contactIds: [c.id], accountId, userId: adminId }, llm);
  expect(r.created).toHaveLength(1);
  await approveEmailDraft(db, r.created[0], actor);
  return { contact: c, draftId: r.created[0] };
}

describe("mailbox accounts", () => {
  it("encrypts the password, starts disabled, and needs a passing test before enabling", async () => {
    const { admin } = await setupOutreach();
    const a = await saveEmailAccount(db, null, { label: "Main", fromName: "Sam", fromAddress: "sam@acme.example", password: "pw-123456" }, admin.id);
    expect(a).toMatchObject({ enabled: false, smtpHost: "smtp.hostinger.com", smtpPort: 465, imapHost: "imap.hostinger.com", imapPort: 993, username: "sam@acme.example" });
    expect(a.encryptedSecrets).not.toContain("pw-123456");
    await expect(setEmailAccountEnabled(db, a.id, true, admin.id)).rejects.toThrow(/connection test/);

    const bad: MailTransport = { verify: async () => Promise.reject(new Error("535 auth failed")), send: async () => Promise.reject(new Error()) };
    expect(await testEmailAccount(db, a.id, admin.id, { transport: bad, mailbox: null })).toMatch(/^failed: 535/);
    const good: MailTransport = { verify: async () => {}, send: async () => ({ accepted: [], rejected: [], response: "" }) };
    const okMailbox: MailboxClient = { verify: async () => {}, fetchSince: async () => ({ uidValidity: 1n, messages: [] }) };
    expect(await testEmailAccount(db, a.id, admin.id, { transport: good, mailbox: okMailbox })).toBe("ok");
    await setEmailAccountEnabled(db, a.id, true, admin.id);
    expect(await db.auditLog.count({ where: { action: { startsWith: "email_account." } } })).toBe(4);
  });
});

describe("sending through SMTP", () => {
  it("sends an approved draft; SMTP 250 = ACCEPTED (never DELIVERED); never resends", async () => {
    const { admin, actor } = await setupOutreach();
    const account = await realAccount(admin.id);
    const { contact, draftId } = await approvedDraft(account.id, admin.id, actor);

    const msg = await sendEmailDraft(db, draftId, actor, { transport: localSmtp(account) });
    expect(msg).toMatchObject({ deliveryState: "ACCEPTED", deliveryEvidence: "smtp_250", direction: "outbound", toAddress: contact.email });
    expect(received).toHaveLength(1);
    const m = received[0];
    expect(m.messageId).toBe(`<${msg.messageId}>`);
    expect(m.from?.value[0]).toMatchObject({ name: "Sam Seller", address: "sam@acme.example" });
    expect(m.headerLines.find((h) => h.key === "list-unsubscribe")?.line).toMatch(/mailto:sam@acme\.example\?subject=unsubscribe/);
    expect(m.text).toMatch(/Acme Ops[\s\S]*unsubscribe/);

    expect(await db.messageDraft.findUniqueOrThrow({ where: { id: draftId } })).toMatchObject({ status: "SENT_CONFIRMED", deliveryState: "ACCEPTED" });
    expect((await db.contact.findUniqueOrThrow({ where: { id: contact.id } })).stage).toBe("CONTACTED");
    const again = await sendEmailDraft(db, draftId, actor, { transport: localSmtp(account) });
    expect(again.id).toBe(msg.id);
    expect(received).toHaveLength(1);
  });

  it("recipient rejected → FAILED; connection refused → not sent, back to APPROVED; ambiguous error → UNKNOWN", async () => {
    const { admin, actor } = await setupOutreach();
    const account = await realAccount(admin.id);

    const rej = await approvedDraft(account.id, admin.id, actor, { email: "nobody@corp.example" });
    await expect(sendEmailDraft(db, rej.draftId, actor, { transport: localSmtp(account) })).rejects.toThrow(/Sending failed/);
    expect(await db.messageDraft.findUniqueOrThrow({ where: { id: rej.draftId } })).toMatchObject({ status: "SEND_FAILED", deliveryState: "FAILED" });

    const down = await approvedDraft(account.id, admin.id, actor);
    const closed = new SmtpTransport({ ...account, smtpHost: "127.0.0.1", smtpPort: 1, smtpSecure: false }, "x", { ignoreTLS: true, connectionTimeout: 2000 });
    await expect(sendEmailDraft(db, down.draftId, actor, { transport: closed })).rejects.toThrow(/Sending failed/);
    expect(await db.messageDraft.findUniqueOrThrow({ where: { id: down.draftId } })).toMatchObject({ status: "APPROVED", deliveryState: "NOT_ATTEMPTED", lastError: expect.any(String) });
    expect(await db.emailMessage.count({ where: { draftId: down.draftId } })).toBe(0);

    const amb = await approvedDraft(account.id, admin.id, actor);
    const flaky: MailTransport = { verify: async () => {}, send: async () => Promise.reject(Object.assign(new Error("Connection closed after DATA"), { code: "EMESSAGE", command: "DATA" })) };
    await expect(sendEmailDraft(db, amb.draftId, actor, { transport: flaky })).rejects.toThrow();
    expect(await db.messageDraft.findUniqueOrThrow({ where: { id: amb.draftId } })).toMatchObject({ status: "HANDED_OFF", deliveryState: "UNKNOWN" });
    // A retry (e.g. the job queue) must not send again.
    await sendEmailDraft(db, amb.draftId, actor, { transport: localSmtp(account) });
    expect(received.filter((r) => r.to && JSON.stringify(r.to).includes(amb.contact.email!))).toHaveLength(0);
  });

  it("enforces the daily limit, consent, and real/dummy separation", async () => {
    const { admin, actor } = await setupOutreach();
    const account = await realAccount(admin.id);
    await db.emailAccount.update({ where: { id: account.id }, data: { dailyLimit: 1 } });
    const a = await approvedDraft(account.id, admin.id, actor);
    const b = await approvedDraft(account.id, admin.id, actor);
    await sendEmailDraft(db, a.draftId, actor, { transport: localSmtp(account) });
    await expect(sendEmailDraft(db, b.draftId, actor, { transport: localSmtp(account) })).rejects.toThrow(/Daily limit/);

    const noConsent = await makeContact();
    const dummy = await consented({ isSimulated: true });
    const r = await generateEmailDrafts(db, { contactIds: [noConsent.id, dummy.id], accountId: account.id, userId: admin.id }, llm);
    expect(r.skipped.map((s) => s.reasons[0])).toEqual([expect.stringMatching(/POPIA s69: EMAIL/), "real mailboxes never email dummy leads"]);
  });
});

describe("inbound: replies, unsubscribes, bounces, auto-replies", () => {
  let ctx: { admin: { id: string }; actor: { id: string; role: string }; account: Awaited<ReturnType<typeof realAccount>> } | null = null;
  beforeEach(() => {
    ctx = null;
  });
  async function sent() {
    if (!ctx) {
      const { admin, actor } = await setupOutreach();
      ctx = { admin, actor, account: await realAccount(admin.id) };
    }
    const { admin, actor, account } = ctx;
    const { contact, draftId } = await approvedDraft(account.id, admin.id, actor);
    const out = await sendEmailDraft(db, draftId, actor, { transport: localSmtp(account) });
    return { account, contact, draftId, out };
  }

  it("a human reply proves delivery, is classified and moves the lead forward; re-ingest is a no-op", async () => {
    const { account, contact, draftId, out } = await sent();
    const raw = buildSimulatedRaw("interested", out);
    const r = await ingestRawEmail(db, account.id, raw, { llm });
    expect(r).toMatchObject({ status: "stored", label: "interested", contactId: contact.id });
    expect(await db.emailMessage.findUniqueOrThrow({ where: { id: out.id } })).toMatchObject({ deliveryState: "DELIVERED", deliveryEvidence: "recipient_reply" });
    expect((await db.messageDraft.findUniqueOrThrow({ where: { id: draftId } })).deliveryState).toBe("DELIVERED");
    expect((await db.contact.findUniqueOrThrow({ where: { id: contact.id } })).stage).toBe("ENGAGED");
    expect((await ingestRawEmail(db, account.id, raw, { llm })).status).toBe("duplicate");
  });

  it("unsubscribe reply withdraws consent and suppresses the address", async () => {
    const { account, contact, out } = await sent();
    expect((await ingestRawEmail(db, account.id, buildSimulatedRaw("unsubscribe", out), { llm })).label).toBe("unsubscribe");
    expect(await db.suppression.count({ where: { email: contact.email! } })).toBe(1);
    expect(await db.marketingPermission.findFirst({ where: { contactId: contact.id, channel: "EMAIL" }, orderBy: { createdAt: "desc" } })).toMatchObject({ status: "WITHDRAWN" });
  });

  it("hard bounce → FAILED + suppression; out-of-office → DELIVERED via auto-reply", async () => {
    const { account, contact, out } = await sent();
    expect((await ingestRawEmail(db, account.id, buildSimulatedRaw("bounce", out), { llm })).label).toBe("bounce");
    expect(await db.emailMessage.findUniqueOrThrow({ where: { id: out.id } })).toMatchObject({ deliveryState: "FAILED", deliveryEvidence: "dsn_bounce", bounceType: "hard", bounceCode: "5.1.1" });
    expect(await db.suppression.findFirst({ where: { email: contact.email! } })).toMatchObject({ reason: "bounce", channel: "EMAIL" });

    const second = await sent();
    expect((await ingestRawEmail(db, second.account.id, buildSimulatedRaw("out_of_office", second.out), { llm })).label).toBe("out_of_office");
    expect(await db.emailMessage.findUniqueOrThrow({ where: { id: second.out.id } })).toMatchObject({ deliveryState: "DELIVERED", deliveryEvidence: "recipient_auto_reply" });
  });

  it("IMAP sync ingests by UID and survives a UIDVALIDITY reset without duplicates", async () => {
    const { account, out } = await sent();
    const msgs = [
      { uid: 5, raw: buildSimulatedRaw("question", out) },
      { uid: 7, raw: Buffer.from("From: stranger@else.example\r\nTo: sam@acme.example\r\nSubject: Hello\r\nMessage-ID: <s1@else.example>\r\n\r\nWho are you?") },
    ];
    let validity = 100n;
    const fake: MailboxClient = { verify: async () => {}, fetchSince: async (last) => ({ uidValidity: validity, messages: msgs.filter((m) => m.uid > last) }) };
    expect(await syncAccount(db, account.id, { mailbox: fake, llm })).toEqual({ stored: 2, duplicate: 0, ignored: 0, failed: 0 });
    expect(await db.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ imapLastUid: 7, imapUidValidity: 100n, lastSyncError: null });
    expect(await syncAccount(db, account.id, { mailbox: fake, llm })).toEqual({ stored: 0, duplicate: 0, ignored: 0, failed: 0 });
    validity = 200n;
    expect(await syncAccount(db, account.id, { mailbox: fake, llm })).toEqual({ stored: 0, duplicate: 2, ignored: 0, failed: 0 });
    expect(await db.emailMessage.count({ where: { direction: "inbound" } })).toBe(2);
    expect(await db.emailMessage.findFirst({ where: { fromAddress: "stranger@else.example" } })).toMatchObject({ contactId: null, classification: "question" });
  });
});

describe("simulation", () => {
  it("simulated mailbox emails dummy leads only and replies flow through the real ingestion path", async () => {
    const { admin, actor } = await setupOutreach();
    const sim = await seedSimulatedMailbox(db, true);
    const real = await consented();
    const dummy = await consented({ isSimulated: true });
    const r = await generateEmailDrafts(db, { contactIds: [real.id, dummy.id], accountId: sim.id, userId: admin.id }, llm);
    expect(r.skipped[0].reasons).toEqual(["the simulated mailbox only emails dummy leads"]);
    await approveEmailDraft(db, r.created[0], actor);
    const out = await sendEmailDraft(db, r.created[0], actor);
    expect(out).toMatchObject({ deliveryState: "ACCEPTED", smtpResponse: "250 SIMULATED: not sent" });
    expect(received).toHaveLength(0);
    expect((await simulateReply(db, out.id, "interested", { llm })).label).toBe("interested");
    expect((await db.emailMessage.findUniqueOrThrow({ where: { id: out.id } })).deliveryState).toBe("DELIVERED");
  });
});

describe("jobs", () => {
  it("email.send via the queue is idempotent; scheduled sync runs once per run key", async () => {
    const { admin, actor } = await setupOutreach();
    const sim = await seedSimulatedMailbox(db, true);
    const dummy = await consented({ isSimulated: true });
    const [draftId] = (await generateEmailDrafts(db, { contactIds: [dummy.id], accountId: sim.id, userId: admin.id }, llm)).created;
    await approveEmailDraft(db, draftId, actor);
    const { enqueue, runScheduled } = await import("@/server/jobs");
    const j1 = await enqueue(db, "email.send", { draftId, userId: admin.id, role: "ADMIN" }, `email.send:${draftId}`);
    const j2 = await enqueue(db, "email.send", { draftId, userId: admin.id, role: "ADMIN" }, `email.send:${draftId}`);
    expect(j1.id).toBe(j2.id);
    expect(j1).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(await db.emailMessage.count({ where: { draftId } })).toBe(1);

    expect(await runScheduled(db, "email.sync_all", "email.sync_all:run-1")).toEqual({}); // no real mailboxes
    await runScheduled(db, "email.sync_all", "email.sync_all:run-1");
    expect(await db.jobRecord.findUniqueOrThrow({ where: { idempotencyKey: "email.sync_all:run-1" } })).toMatchObject({ attempts: 1, status: "succeeded" });
  });
});
