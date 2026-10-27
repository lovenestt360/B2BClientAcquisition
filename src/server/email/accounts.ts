import { z } from "zod";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError } from "../errors";
import { encryptSecret } from "../crypto";
import { normalizeEmail } from "../normalize";
import { transportFor, type MailTransport } from "./transport";
import { mailboxFor, type MailboxClient } from "./mailbox";

/** Hostinger business email defaults (implicit TLS). */
export const HOSTINGER = { smtpHost: "smtp.hostinger.com", smtpPort: 465, smtpSecure: true, imapHost: "imap.hostinger.com", imapPort: 993, imapSecure: true };

const bool = z.union([z.literal("on"), z.literal("true"), z.literal("false"), z.literal(""), z.boolean()]).optional().transform((v) => v === true || v === "on" || v === "true");

export const accountInput = z.object({
  label: z.string().trim().min(1).max(60),
  fromName: z.string().trim().min(1).max(80),
  fromAddress: z.string().trim(),
  username: z.string().trim().optional().or(z.literal("")),
  password: z.string().optional().or(z.literal("")), // blank on edit = keep existing
  smtpHost: z.string().trim().default(HOSTINGER.smtpHost),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(HOSTINGER.smtpPort),
  smtpSecure: bool,
  imapHost: z.string().trim().default(HOSTINGER.imapHost),
  imapPort: z.coerce.number().int().min(1).max(65535).default(HOSTINGER.imapPort),
  imapSecure: bool,
  dailyLimit: z.coerce.number().int().min(1).max(500).default(30),
});

export async function saveEmailAccount(db: Db, id: string | null, raw: unknown, actorId: string) {
  const i = accountInput.parse(raw);
  const fromAddress = normalizeEmail(i.fromAddress);
  if (!fromAddress) throw new AppError("Enter a valid sender email address");
  const existing = id ? await db.emailAccount.findUniqueOrThrow({ where: { id } }) : null;
  if (existing?.isSimulated) throw new AppError("The simulated mailbox can't be edited");
  if (!existing && !i.password) throw new AppError("Password is required");
  const data = {
    label: i.label,
    fromName: i.fromName,
    fromAddress,
    username: i.username || fromAddress,
    smtpHost: i.smtpHost,
    smtpPort: i.smtpPort,
    smtpSecure: i.smtpSecure,
    imapHost: i.imapHost,
    imapPort: i.imapPort,
    imapSecure: i.imapSecure,
    dailyLimit: i.dailyLimit,
    ...(i.password ? { encryptedSecrets: encryptSecret(JSON.stringify({ password: i.password })) } : {}),
  };
  const saved = existing
    ? await db.emailAccount.update({ where: { id: existing.id }, data })
    : await db.emailAccount.create({ data: { ...data, enabled: false } }); // always starts disabled
  await audit(db, {
    actorId,
    action: existing ? "email_account.update" : "email_account.create",
    entityType: "email_account",
    entityId: saved.id,
    metadata: { fromAddress, smtpHost: i.smtpHost, imapHost: i.imapHost, passwordChanged: !!i.password },
  });
  return saved;
}

export async function setEmailAccountEnabled(db: Db, id: string, enabled: boolean, actorId: string) {
  const a = await db.emailAccount.findUniqueOrThrow({ where: { id } });
  if (enabled && !a.isSimulated && a.lastTestResult !== "ok") {
    throw new AppError("Run a successful connection test before enabling this mailbox");
  }
  await db.emailAccount.update({ where: { id }, data: { enabled } });
  await audit(db, { actorId, action: enabled ? "email_account.enable" : "email_account.disable", entityType: "email_account", entityId: id });
}

/** Log in to SMTP and IMAP without sending anything. */
export async function testEmailAccount(
  db: Db,
  id: string,
  actorId: string,
  deps: { transport?: MailTransport; mailbox?: MailboxClient | null } = {},
) {
  const a = await db.emailAccount.findUniqueOrThrow({ where: { id } });
  let result = "ok";
  try {
    await (deps.transport ?? transportFor(a)).verify();
    const mb = deps.mailbox !== undefined ? deps.mailbox : mailboxFor(a);
    await mb?.verify();
  } catch (e) {
    result = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  }
  await db.emailAccount.update({ where: { id }, data: { lastTestAt: new Date(), lastTestResult: result } });
  await audit(db, { actorId, action: "email_account.test", entityType: "email_account", entityId: id, metadata: { result } });
  return result;
}

export async function sentToday(db: Db, accountId: string, since: Date) {
  return db.emailMessage.count({ where: { accountId, direction: "outbound", occurredAt: { gte: since } } });
}

export async function seedSimulatedMailbox(db: Db, enabled: boolean) {
  return db.emailAccount.upsert({
    where: { fromAddress: "outreach@demo-co.example" },
    update: {},
    create: {
      label: "Simulated mailbox",
      fromName: "Klyron Consulting",
      fromAddress: "outreach@demo-co.example",
      username: "outreach@demo-co.example",
      ...HOSTINGER,
      isSimulated: true,
      enabled,
      lastTestResult: "ok",
      dailyLimit: 50,
    },
  });
}
