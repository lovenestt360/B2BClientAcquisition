import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "../errors";
import { ingestRawEmail } from "./ingest";
import type { LlmClient } from "../ai/llm";

export type SimulatedReply = "interested" | "not_interested" | "question" | "unsubscribe" | "out_of_office" | "bounce";

const BODIES: Record<Exclude<SimulatedReply, "out_of_office" | "bounce">, string> = {
  interested: "Hi, thanks for reaching out. Sounds good, let's chat next Tuesday morning.",
  not_interested: "Thanks, but we're not interested at this time.",
  question: "How much does this usually cost for a team of 20?",
  unsubscribe: "Please unsubscribe me from these emails.",
};

const crlf = (lines: string[]) => Buffer.from(lines.join("\r\n"));

/** Build a realistic raw message as the recipient's server would deliver it. */
export function buildSimulatedRaw(kind: SimulatedReply, outbound: { messageId: string; fromAddress: string; toAddress: string; subject: string }) {
  const id = `${crypto.randomUUID()}@sim.example`;
  const date = new Date().toUTCString();
  if (kind === "bounce") {
    const b = `b-${crypto.randomUUID()}`;
    return crlf([
      `From: Mail Delivery System <MAILER-DAEMON@sim.example>`,
      `To: ${outbound.fromAddress}`,
      `Subject: Undelivered Mail Returned to Sender`,
      `Date: ${date}`,
      `Message-ID: <${id}>`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/report; report-type=delivery-status; boundary="${b}"`,
      ``,
      `--${b}`,
      `Content-Type: text/plain`,
      ``,
      `Your message could not be delivered to ${outbound.toAddress}: mailbox does not exist.`,
      `--${b}`,
      `Content-Type: message/delivery-status`,
      ``,
      `Final-Recipient: rfc822; ${outbound.toAddress}`,
      `Action: failed`,
      `Status: 5.1.1`,
      `Diagnostic-Code: smtp; 550 5.1.1 User unknown`,
      ``,
      `--${b}`,
      `Content-Type: text/rfc822-headers`,
      ``,
      `Message-ID: <${outbound.messageId}>`,
      `Subject: ${outbound.subject}`,
      `--${b}--`,
      ``,
    ]);
  }
  const ooo = kind === "out_of_office";
  return crlf([
    `From: <${outbound.toAddress}>`,
    `To: ${outbound.fromAddress}`,
    `Subject: ${ooo ? "Automatic reply: " : "Re: "}${outbound.subject}`,
    `Date: ${date}`,
    `Message-ID: <${id}>`,
    `In-Reply-To: <${outbound.messageId}>`,
    `References: <${outbound.messageId}>`,
    ...(ooo ? ["Auto-Submitted: auto-replied"] : []),
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    ooo ? "I am out of the office until Monday with limited access to email." : BODIES[kind],
    ``,
    `On ${date}, ${outbound.fromAddress} wrote:`,
    `> ${outbound.subject}`,
    ``,
  ]);
}

/** Simulation only: inject a reply to a dummy lead's email through the real ingestion path. */
export async function simulateReply(db: Db, outboundId: string, kind: SimulatedReply, deps: { llm?: LlmClient } = {}) {
  if (!env().SIMULATION_MODE) throw new AppError("Simulated replies are only available in simulation mode");
  const out = await db.emailMessage.findUniqueOrThrow({ where: { id: outboundId }, include: { account: true, contact: true } });
  if (out.direction !== "outbound" || !out.account.isSimulated || !out.contact?.isSimulated) {
    throw new AppError("Only emails from the simulated mailbox to dummy leads can get simulated replies");
  }
  return ingestRawEmail(db, out.accountId, buildSimulatedRaw(kind, out), deps);
}
