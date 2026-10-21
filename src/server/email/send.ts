import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError, ComplianceBlockedError } from "../errors";
import { checkEligibility, type Purpose } from "../compliance/eligibility";
import { getSenderProfile } from "../compliance/controls";
import { findInventedDetails } from "../ai/drafts";
import { assertDraftTransition } from "../messaging/states";
import { now } from "../clock";
import { startOfLocalDay } from "../today";
import { listUnsubscribeHeader, newMessageId, UNSUBSCRIBE_LINE, validateEmailDraft } from "./compose";
import { transportFor, wasDefinitelyNotSent, type MailTransport } from "./transport";
import { sentToday } from "./accounts";

type Actor = { id: string; role: string };

export async function approveEmailDraft(db: Db, draftId: string, actor: Actor, edit?: { subject?: string; body?: string }) {
  const d = await db.messageDraft.findUniqueOrThrow({ where: { id: draftId }, include: { emailAccount: true } });
  if (d.channel !== "EMAIL") throw new AppError("Not an email draft");
  assertDraftTransition(d.status, "APPROVED");
  const subject = (edit?.subject ?? d.subject ?? "").trim();
  const body = (edit?.body ?? d.body).trim();
  const sender = await getSenderProfile(db);
  // The signature/opt-out footer is ours; every other line is checked for invented details.
  const footer = new Set([d.emailAccount?.fromName, sender.businessName, UNSUBSCRIBE_LINE].filter(Boolean).map((l) => l!.trim()));
  const signatureFree = body.split("\n").filter((l) => !footer.has(l.trim())).join("\n");
  const errors = [...validateEmailDraft(subject, body, sender), ...findInventedDetails(`${subject}\n${signatureFree}`).map((x) => `remove contact detail or link "${x}"`)];
  if (errors.length) throw new AppError(errors.join("; "), "invalid_content");
  const elig = await checkEligibility(db, { contactId: d.contactId, channel: "EMAIL", purpose: d.purpose as Purpose, address: d.toAddress, campaignId: d.campaignId, ignoreContactWindow: true });
  if (!elig.eligible) throw new ComplianceBlockedError(elig.reasons);
  const u = await db.messageDraft.update({
    where: { id: draftId, status: d.status },
    data: { status: "APPROVED", subject, body, approvedById: actor.id, approvedAt: new Date(), eligibility: elig as unknown as Prisma.InputJsonValue },
  });
  await audit(db, { actorId: actor.id, action: "email.approve", entityType: "message_draft", entityId: draftId, metadata: { edited: body !== d.body || subject !== d.subject } });
  return u;
}

/**
 * Send one approved email through the mailbox's SMTP server. Safe to retry: the attempt is
 * recorded before the network call, so a retry after a crash never sends twice. SMTP acceptance
 * is recorded as ACCEPTED only; DELIVERED needs a reply (see ingest.ts).
 */
export async function sendEmailDraft(db: Db, draftId: string, actor: Actor | null, deps: { transport?: MailTransport } = {}) {
  const d = await db.messageDraft.findUniqueOrThrow({ where: { id: draftId }, include: { contact: true, emailAccount: true, emailMessage: true } });
  if (d.emailMessage) return d.emailMessage; // already attempted: never resend automatically
  if (d.channel !== "EMAIL" || !d.emailAccount) throw new AppError("Not an email draft");
  assertDraftTransition(d.status, "HANDED_OFF");
  const account = d.emailAccount;
  if (!account.enabled) throw new AppError(`Mailbox "${account.label}" is disabled`, "provider_disabled", 423);
  if (account.isSimulated !== d.contact.isSimulated) throw new AppError("Simulated mailboxes only email dummy leads, and real mailboxes never do");

  const elig = await checkEligibility(db, { contactId: d.contactId, channel: "EMAIL", purpose: d.purpose as Purpose, address: d.toAddress, campaignId: d.campaignId });
  if (!elig.eligible) throw new ComplianceBlockedError(elig.reasons);
  const count = await sentToday(db, account.id, startOfLocalDay(now()));
  if (count >= account.dailyLimit) throw new AppError(`Daily limit reached for ${account.fromAddress} (${account.dailyLimit}). Protects your sender reputation.`, "rate_limited", 429);

  const messageId = newMessageId(account.fromAddress);
  // 1. Record the attempt first (crash-safe).
  const msg = await db.$transaction(async (tx) => {
    await tx.messageDraft.update({ where: { id: draftId, status: d.status }, data: { status: "HANDED_OFF", deliveryState: "ATTEMPTED", lastError: null } });
    return tx.emailMessage.create({
      data: {
        accountId: account.id,
        contactId: d.contactId,
        draftId,
        direction: "outbound",
        messageId,
        fromAddress: account.fromAddress,
        toAddress: d.toAddress,
        subject: d.subject ?? "",
        bodyText: d.body,
        deliveryState: "ATTEMPTED",
        occurredAt: new Date(),
      },
    });
  });

  // 2. Hand to SMTP.
  try {
    const res = await (deps.transport ?? transportFor(account)).send({
      fromName: account.fromName,
      fromAddress: account.fromAddress,
      to: d.toAddress,
      subject: d.subject ?? "",
      text: d.body,
      messageId,
      headers: { "List-Unsubscribe": listUnsubscribeHeader(account.fromAddress) },
    });
    const accepted = res.accepted.map((a) => a.toLowerCase()).includes(d.toAddress.toLowerCase());
    await db.emailMessage.update({
      where: { id: msg.id },
      data: { deliveryState: accepted ? "ACCEPTED" : "FAILED", deliveryEvidence: accepted ? "smtp_250" : "smtp_reject", smtpResponse: res.response?.slice(0, 500) },
    });
    await db.messageDraft.update({ where: { id: draftId }, data: { status: accepted ? "SENT_CONFIRMED" : "SEND_FAILED", deliveryState: accepted ? "ACCEPTED" : "FAILED" } });
    if (accepted && ["NEW", "RESEARCHING", "QUALIFIED"].includes(d.contact.stage)) {
      await db.contact.update({ where: { id: d.contactId }, data: { stage: "CONTACTED" } });
    }
    await audit(db, { actorId: actor?.id ?? null, actorType: actor ? "user" : "job", action: accepted ? "email.sent_accepted" : "email.rejected", entityType: "message_draft", entityId: draftId, metadata: { messageId, response: res.response?.slice(0, 200) } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (wasDefinitelyNotSent(e)) {
      // Nothing left our side: undo the attempt so it can be retried.
      const rejectedRcpt = (e as { command?: string }).command === "RCPT TO" || (e as { code?: string }).code === "EENVELOPE";
      if (rejectedRcpt) {
        await db.emailMessage.update({ where: { id: msg.id }, data: { deliveryState: "FAILED", deliveryEvidence: "smtp_reject", smtpResponse: message.slice(0, 500) } });
        await db.messageDraft.update({ where: { id: draftId }, data: { status: "SEND_FAILED", deliveryState: "FAILED", lastError: message.slice(0, 500) } });
      } else {
        await db.emailMessage.delete({ where: { id: msg.id } });
        await db.messageDraft.update({ where: { id: draftId }, data: { status: "APPROVED", deliveryState: "NOT_ATTEMPTED", lastError: message.slice(0, 500) } });
      }
    } else {
      // The server may or may not have taken it. Do not guess and do not resend.
      await db.emailMessage.update({ where: { id: msg.id }, data: { deliveryState: "UNKNOWN", smtpResponse: message.slice(0, 500) } });
      await db.messageDraft.update({ where: { id: draftId }, data: { deliveryState: "UNKNOWN", lastError: message.slice(0, 500) } });
    }
    await audit(db, { actorId: actor?.id ?? null, action: "email.send_error", entityType: "message_draft", entityId: draftId, metadata: { message: message.slice(0, 200) } });
    throw new AppError(`Sending failed: ${message}`, "send_failed", 502);
  }
  return db.emailMessage.findUniqueOrThrow({ where: { id: msg.id } });
}

export async function rejectEmailDraft(db: Db, draftId: string, actor: Actor, reason?: string) {
  const d = await db.messageDraft.findUniqueOrThrow({ where: { id: draftId } });
  assertDraftTransition(d.status, "REJECTED");
  await db.messageDraft.update({ where: { id: draftId }, data: { status: "REJECTED", lastError: reason || null } });
  await audit(db, { actorId: actor.id, action: "email.reject", entityType: "message_draft", entityId: draftId, metadata: { reason } });
}
