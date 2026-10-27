import type { LlmClient } from "./llm";
import type { SenderProfile } from "../compliance/controls";

export interface DraftContext {
  firstName: string;
  title?: string | null;
  company?: string | null;
  industry?: string | null;
  instructions?: string | null; // campaign SMS instructions
  purpose: "marketing" | "consent_request";
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PHONE_RE = /(?:\+?\d[\d\s()-]{7,}\d)/g;

/**
 * Guardrail: the model may not introduce contact details, links or numbers.
 * Anything matching is rejected so a human never approves invented data.
 */
export function findInventedDetails(body: string): string[] {
  return [...(body.match(URL_RE) ?? []), ...(body.match(EMAIL_RE) ?? []), ...(body.match(PHONE_RE) ?? [])];
}

/** Compose the final SMS: sender identification + body + opt-out (POPIA s69(4)). */
export function composeSms(core: string, sender: SenderProfile): string {
  const text = core.replace(/\s+/g, " ").trim();
  const prefix = sender.businessName ? `${sender.businessName}: ` : "";
  const withPrefix = text.toLowerCase().startsWith(sender.businessName.toLowerCase()) && sender.businessName ? text : prefix + text;
  return `${withPrefix} ${sender.optOutText}`.trim();
}

export function validateSmsBody(body: string, sender: SenderProfile): string[] {
  const errs: string[] = [];
  if (!sender.businessName) errs.push("set your business name (sender identity) in Compliance settings");
  else if (!body.toLowerCase().includes(sender.businessName.toLowerCase())) errs.push("message must identify the sender");
  if (!/\bstop\b/i.test(body)) errs.push("message must include an opt-out instruction (e.g. Reply STOP)");
  const seg = smsSegments(body);
  if (seg.segments > 3) errs.push(`message is ${seg.segments} SMS segments; keep it to 3 or fewer`);
  return errs;
}

const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

export function smsSegments(body: string): { encoding: "GSM-7" | "UCS-2"; length: number; segments: number } {
  const gsm = GSM7.test(body);
  // GSM-7 extension chars count double.
  const length = gsm ? [...body].reduce((n, ch) => n + ("^{}\\[~]|€".includes(ch) ? 2 : 1), 0) : [...body].length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return { encoding: gsm ? "GSM-7" : "UCS-2", length, segments: length <= single ? 1 : Math.ceil(length / multi) };
}

export async function generateSmsCore(llm: LlmClient, ctx: DraftContext, sender: SenderProfile): Promise<{ core: string; generatedBy: string }> {
  const system = [
    "TASK: SMS_DRAFT",
    "You write short, professional B2B SMS messages for South African construction decision-makers.",
    "Rules: max 220 characters; no links, phone numbers or email addresses; no false urgency; no claims you cannot verify;",
    "do NOT include the sender name or opt-out text (added automatically). Output only the message text.",
    ctx.purpose === "consent_request"
      ? "This is a ONE-TIME request for permission to send marketing messages. Ask for consent clearly; do not market a product."
      : "This is a marketing message to a contact who has a lawful basis on record. Treat SMS as a concise follow-up, not a full cold pitch. If the campaign context says a call was attempted or completed, mention only that verified context.",
    `SENDER: ${sender.businessName || "our company"}`,
    `FIRST_NAME: ${ctx.firstName}`,
    `TITLE: ${ctx.title ?? "unknown"}`,
    `COMPANY: ${ctx.company ?? "unknown"}`,
    `INDUSTRY: ${ctx.industry ?? "unknown"}`,
    ctx.instructions ? `CAMPAIGN INSTRUCTIONS: ${ctx.instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let core = "";
  try {
    core = await llm.chat([{ role: "system", content: system }, { role: "user", content: "Write the SMS." }], { temperature: 0.5, maxTokens: 120 });
  } catch {
    core = "";
  }
  core = core.replace(/^["'\s]+|["'\s]+$/g, "");
  if (!core || findInventedDetails(core).length || core.length > 260) {
    // Deterministic template fallback; still requires human approval.
    core =
      ctx.purpose === "consent_request"
        ? `Hi ${ctx.firstName}, may we occasionally send you SMS updates about services for ${ctx.company ?? "your business"}? Reply YES to agree.`
        : `Hi ${ctx.firstName}, would 15 minutes to discuss reducing coordination pressure and site rework at ${ctx.company ?? "your project team"} be useful?`;
    return { core, generatedBy: "template:v1" };
  }
  return { core, generatedBy: llm.name };
}
