import nodemailer from "nodemailer";
import type { EmailAccount } from "@prisma/client";
import { decryptSecret } from "../crypto";

export interface OutboundEmail {
  fromName: string;
  fromAddress: string;
  to: string;
  subject: string;
  text: string;
  messageId: string; // without <>
  headers: Record<string, string>;
}

export interface SendResult {
  accepted: string[];
  rejected: string[];
  response: string;
}

/** SMTP abstraction so tests and simulation never touch a real server. */
export interface MailTransport {
  verify(): Promise<void>;
  send(msg: OutboundEmail): Promise<SendResult>;
}

/** Errors raised before the server accepted DATA: the message definitely was not sent. */
const NOT_SENT_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "EDNS", "EAUTH", "ESOCKET", "ECONNREFUSED", "ETLS"]);

export function wasDefinitelyNotSent(err: unknown): boolean {
  const e = err as { code?: string; responseCode?: number; command?: string };
  if (e?.code && NOT_SENT_CODES.has(e.code)) return true;
  // Envelope (MAIL FROM / RCPT TO) rejections happen before DATA.
  return e?.command === "MAIL FROM" || e?.command === "RCPT TO" || e?.code === "EENVELOPE";
}

export function credentials(account: EmailAccount): { password: string } {
  if (!account.encryptedSecrets) throw new Error("Mailbox has no stored credentials");
  return JSON.parse(decryptSecret(account.encryptedSecrets)) as { password: string };
}

export class SmtpTransport implements MailTransport {
  private t: nodemailer.Transporter;
  /** `extra` overrides transport options (tests use it to talk to a local plain-text server). */
  constructor(account: EmailAccount, password: string, extra: Record<string, unknown> = {}) {
    this.t = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      requireTLS: !account.smtpSecure,
      auth: { user: account.username, pass: password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      ...extra,
    });
  }
  async verify() {
    await this.t.verify();
  }
  async send(msg: OutboundEmail): Promise<SendResult> {
    const info = await this.t.sendMail({
      from: { name: msg.fromName, address: msg.fromAddress }, // nodemailer encodes/quotes the name
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      messageId: `<${msg.messageId}>`,
      headers: msg.headers,
    });
    return {
      accepted: (info.accepted as (string | { address: string })[]).map((a) => (typeof a === "string" ? a : a.address)),
      rejected: (info.rejected as (string | { address: string })[]).map((a) => (typeof a === "string" ? a : a.address)),
      response: info.response,
    };
  }
}

/** Fake transport for the simulated mailbox: accepts everything, sends nothing. */
export class SimulatedTransport implements MailTransport {
  async verify() {}
  async send(msg: OutboundEmail): Promise<SendResult> {
    return { accepted: [msg.to], rejected: [], response: "250 SIMULATED: not sent" };
  }
}

export function transportFor(account: EmailAccount): MailTransport {
  if (account.isSimulated) return new SimulatedTransport();
  return new SmtpTransport(account, credentials(account).password);
}
