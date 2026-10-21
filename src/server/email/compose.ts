import type { EmailAccount } from "@prisma/client";
import type { SenderProfile } from "../compliance/controls";
import { findInventedDetails } from "../ai/drafts";

export const UNSUBSCRIBE_LINE = 'To stop receiving these emails, reply with "unsubscribe".';

/** Signature + opt-out footer (POPIA s69(4): sender identity and a way to opt out). */
export function composeEmailBody(core: string, account: Pick<EmailAccount, "fromName">, sender: SenderProfile): string {
  const text = core.trim().replace(/\n{3,}/g, "\n\n");
  return `${text}\n\n${account.fromName}\n${sender.businessName}\n\n${UNSUBSCRIBE_LINE}`;
}

export function validateEmailDraft(subject: string, body: string, sender: SenderProfile): string[] {
  const errs: string[] = [];
  if (!subject.trim()) errs.push("subject is required");
  if (subject.length > 120) errs.push("subject is too long (max 120)");
  if (!sender.businessName) errs.push("set your business name (sender identity) in Compliance settings");
  else if (!body.toLowerCase().includes(sender.businessName.toLowerCase())) errs.push("email must identify the sender business");
  if (!/unsubscribe/i.test(body)) errs.push("email must tell the recipient how to unsubscribe");
  if (body.length > 5000) errs.push("email body is too long");
  return errs;
}

/** Only details the model introduced are a problem; the footer is ours. */
export function inventedDetailsInCore(core: string): string[] {
  return findInventedDetails(core);
}

export function listUnsubscribeHeader(fromAddress: string): string {
  return `<mailto:${fromAddress}?subject=unsubscribe>`;
}

export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1] ?? "localhost";
  return `${crypto.randomUUID()}@${domain}`;
}
