import { simpleParser } from "mailparser";
import type { DeliveryState, EmailMessage } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { sha256 } from "../crypto";
import { recordOptOut } from "../compliance/controls";
import { assertDeliveryTransition, type Evidence } from "../messaging/states";
import { classifyReply } from "../ai/classify";
import { getLlm, type LlmClient } from "../ai/llm";
import { fromAddress, isAutoReply, parseBounce, ruleLabel, stripQuoted, toAddresses, type ReplyLabel } from "./parse";

const stripId = (s: string | undefined | null) => (s ? s.trim().replace(/^<|>$/g, "") : null);

function referenceIds(refs: string | string[] | undefined, inReplyTo: string | undefined): string[] {
  const list = Array.isArray(refs) ? refs : refs ? refs.split(/\s+/) : [];
  return [...new Set([inReplyTo, ...list].map(stripId).filter(Boolean) as string[])];
}

/**
 * Move an outbound email (and its draft) to a new delivery state, enforcing the evidence rules.
 * Returns false when the transition is not allowed (e.g. a late bounce after a reply).
 */
export async function setEmailDelivery(db: Db, msg: EmailMessage, to: DeliveryState, evidence: Evidence, extra: Partial<EmailMessage> = {}) {
  if (msg.deliveryState === to) return true;
  try {
    assertDeliveryTransition(msg.deliveryState, to, evidence);
  } catch {
    return false;
  }
  await db.emailMessage.update({ where: { id: msg.id }, data: { deliveryState: to, deliveryEvidence: evidence, ...extra } });
  if (msg.draftId) await db.messageDraft.update({ where: { id: msg.draftId }, data: { deliveryState: to } });
  return true;
}

export interface IngestResult {
  status: "stored" | "duplicate" | "ignored";
  label?: ReplyLabel;
  messageId?: string;
  contactId?: string | null;
}

/** Parse one raw RFC 5322 message from the mailbox and apply its consequences. Idempotent by Message-ID. */
export async function ingestRawEmail(db: Db, accountId: string, raw: Buffer, deps: { llm?: LlmClient } = {}): Promise<IngestResult> {
  const p = await simpleParser(raw);
  const messageId = stripId(p.messageId) ?? `sha256-${sha256(raw).slice(0, 32)}@local`;
  if (await db.emailMessage.findUnique({ where: { messageId } })) return { status: "duplicate", messageId };

  const account = await db.emailAccount.findUniqueOrThrow({ where: { id: accountId } });
  const from = fromAddress(p);
  if (from && from === account.fromAddress) return { status: "ignored", messageId }; // our own copy

  const bounce = parseBounce(p);
  const refs = referenceIds(p.references, p.inReplyTo);

  // Which of our outbound messages does this relate to?
  let parent =
    (bounce?.originalMessageId &&
      (await db.emailMessage.findFirst({ where: { messageId: bounce.originalMessageId, direction: "outbound", accountId } }))) ||
    (refs.length ? await db.emailMessage.findFirst({ where: { messageId: { in: refs }, direction: "outbound", accountId }, orderBy: { occurredAt: "desc" } }) : null) ||
    null;
  if (!parent && bounce?.recipient) {
    parent = await db.emailMessage.findFirst({ where: { toAddress: bounce.recipient, direction: "outbound", accountId }, orderBy: { occurredAt: "desc" } });
  }
  const contactId = parent?.contactId ?? (bounce ? null : (await db.contact.findUnique({ where: { email: from } }))?.id ?? null);

  const newText = stripQuoted(p.text ?? "");
  let label: ReplyLabel;
  let source: string;
  if (bounce) [label, source] = ["bounce", "rules"];
  else if (isAutoReply(p)) [label, source] = ["out_of_office", "rules"];
  else if (ruleLabel(newText)) [label, source] = [ruleLabel(newText)!, "rules"];
  else ({ label, source } = await classifyReply(deps.llm ?? getLlm(), newText));

  const stored = await db.emailMessage.create({
    data: {
      accountId,
      contactId,
      parentId: parent?.id ?? null,
      direction: "inbound",
      messageId,
      inReplyTo: stripId(p.inReplyTo),
      references: refs.join(" ") || null,
      fromAddress: from || "unknown",
      toAddress: toAddresses(p)[0] ?? account.fromAddress,
      subject: (p.subject ?? "(no subject)").slice(0, 300),
      bodyText: (p.text ?? "").slice(0, 20_000),
      classification: label,
      classificationSource: source,
      bounceType: bounce?.type ?? null,
      bounceCode: bounce?.code ?? null,
      occurredAt: p.date ?? new Date(),
    },
  });

  // ── Reconcile the outbound message's delivery state ──
  if (parent) {
    if (bounce?.type === "hard") {
      await setEmailDelivery(db, parent, "FAILED", "dsn_bounce", { bounceType: "hard", bounceCode: bounce.code });
      const addr = bounce.recipient ?? parent.toAddress;
      if (!(await db.suppression.findFirst({ where: { email: addr } }))) {
        await db.suppression.create({ data: { email: addr, reason: "bounce", source: `DSN ${bounce.code ?? ""} on ${parent.messageId}`.trim(), channel: "EMAIL" } });
      }
    } else if (bounce?.type === "soft") {
      await db.emailMessage.update({ where: { id: parent.id }, data: { bounceType: "soft", bounceCode: bounce.code } });
    } else {
      await setEmailDelivery(db, parent, "DELIVERED", label === "out_of_office" ? "recipient_auto_reply" : "recipient_reply");
    }
  }

  // ── Consequences for the contact ──
  if (contactId && label === "unsubscribe") {
    await recordOptOut(db, { contactId, channel: "EMAIL", address: from, evidence: `email reply "${newText.slice(0, 40)}" (${messageId})` }, null);
    await db.messageDraft.updateMany({ where: { contactId, channel: "EMAIL", status: { in: ["PENDING_APPROVAL", "APPROVED"] } }, data: { status: "CANCELLED" } });
  }
  if (contactId && (label === "interested" || label === "question")) {
    await db.contact.updateMany({ where: { id: contactId, stage: { in: ["NEW", "RESEARCHING", "QUALIFIED", "CONTACTED"] } }, data: { stage: "ENGAGED" } });
  }

  await audit(db, {
    actorType: "job",
    action: "email.inbound",
    entityType: "email_message",
    entityId: stored.id,
    metadata: { label, source, contactId, parent: parent?.messageId ?? null, bounce: bounce?.code ?? null },
  });
  return { status: "stored", label, messageId, contactId };
}
