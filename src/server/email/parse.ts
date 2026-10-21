import type { ParsedMail, AddressObject } from "mailparser";

export interface BounceInfo {
  originalMessageId: string | null;
  recipient: string | null;
  code: string | null; // e.g. 5.1.1
  type: "hard" | "soft";
}

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (sub)?system)/i;
const BOUNCE_SUBJECT = /(undeliver(able|ed)|delivery status notification|failure notice|returned mail|mail delivery failed|delivery has failed)/i;

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  if (!a) return [];
  return (Array.isArray(a) ? a : [a]).flatMap((x) => x.value.map((v) => (v.address ?? "").toLowerCase())).filter(Boolean);
}

export function fromAddress(p: ParsedMail): string {
  return addresses(p.from)[0] ?? "";
}

export function toAddresses(p: ParsedMail): string[] {
  return addresses(p.to);
}

function allText(p: ParsedMail): string {
  const parts = [p.text ?? ""];
  for (const a of p.attachments ?? []) {
    if (/^(message\/(delivery-status|rfc822)|text\/rfc822-headers|text\/plain)/i.test(a.contentType)) parts.push(a.content.toString("utf8"));
  }
  return parts.join("\n");
}

/** Detect a delivery status notification (bounce) and pull out what it refers to. */
export function parseBounce(p: ParsedMail): BounceInfo | null {
  const ct = String(p.headers.get("content-type") ? (p.headers.get("content-type") as { value?: string; params?: Record<string, string> }).value ?? "" : "");
  const reportType = (p.headers.get("content-type") as { params?: Record<string, string> } | undefined)?.params?.["report-type"];
  const isDsn = /multipart\/report/i.test(ct) && /delivery-status/i.test(reportType ?? "delivery-status");
  if (!isDsn && !(BOUNCE_FROM.test(fromAddress(p) + " " + (p.from?.text ?? "")) && BOUNCE_SUBJECT.test(p.subject ?? ""))) return null;

  const text = allText(p);
  const code = /Status:\s*([245]\.\d{1,3}\.\d{1,3})/i.exec(text)?.[1] ?? /\b([45]\.\d\.\d{1,3})\b/.exec(text)?.[1] ?? null;
  const recipient =
    /Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/i.exec(text)?.[1]?.toLowerCase() ??
    /Original-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/i.exec(text)?.[1]?.toLowerCase() ??
    null;
  const originalMessageId = /Message-ID:\s*<([^>\s]+)>/i.exec(text.replace(p.messageId ?? "\u0000", ""))?.[1] ?? null;
  const diag = /Diagnostic-Code:[^\n]*\b(5\d\d)\b/i.exec(text)?.[1];
  const type: "hard" | "soft" = code?.startsWith("5") || diag ? "hard" : "soft";
  return { originalMessageId, recipient, code, type };
}

/** RFC 3834 auto-replies and the usual vendor headers / subjects. */
export function isAutoReply(p: ParsedMail): boolean {
  const h = (k: string) => String(p.headers.get(k) ?? "").toLowerCase();
  if (h("auto-submitted") && h("auto-submitted") !== "no") return true;
  if (h("x-autoreply") || h("x-autorespond") || h("x-auto-response-suppress").includes("oof")) return true;
  if (/^(auto_reply|auto-reply)$/.test(h("precedence"))) return true;
  return /^(auto(matic)?[ -]?reply|out of (the )?office|ooo\b|autoreply|abwesenheit|afwesig)/i.test(p.subject ?? "");
}

/** The new text of a reply, without quoted history. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .+wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^From:\s.+/.test(l) || /^_{5,}/.test(l)) break;
    if (l.startsWith(">")) continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

export type ReplyLabel = "interested" | "not_interested" | "question" | "unsubscribe" | "out_of_office" | "bounce" | "other";

const UNSUB = /\b(unsubscribe|remove me|stop (emailing|sending|contacting)|opt[ -]?out|take me off|do not (email|contact) me)\b/i;

/** Deterministic labels that must never depend on a model. */
export function ruleLabel(newText: string): ReplyLabel | null {
  return UNSUB.test(newText) ? "unsubscribe" : null;
}
