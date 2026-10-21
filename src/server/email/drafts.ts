import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError } from "../errors";
import { checkEligibility } from "../compliance/eligibility";
import { getSenderProfile, type SenderProfile } from "../compliance/controls";
import { getLlm, type LlmClient } from "../ai/llm";
import { composeEmailBody, inventedDetailsInCore } from "./compose";

interface Ctx {
  firstName: string;
  title?: string | null;
  company?: string | null;
  industry?: string | null;
  instructions?: string | null;
  purpose: "marketing" | "consent_request";
}

export async function generateEmailCore(llm: LlmClient, ctx: Ctx, sender: SenderProfile): Promise<{ subject: string; core: string; generatedBy: string }> {
  const fallback = () => ({
    subject: ctx.purpose === "consent_request" ? `May we keep in touch, ${ctx.firstName}?` : `Quick question for ${ctx.company ?? ctx.firstName}`,
    core:
      ctx.purpose === "consent_request"
        ? `Hi ${ctx.firstName},\n\nMay ${sender.businessName || "we"} occasionally email you about services relevant to ${ctx.company ?? "your business"}? Reply "yes" to agree. If we don't hear from you, we won't email you again.`
        : `Hi ${ctx.firstName},\n\nI work with ${ctx.industry ? `${ctx.industry.toLowerCase()} ` : ""}teams on cutting operational admin. Would a 15-minute call next week be useful to see if there's a fit for ${ctx.company ?? "your team"}?`,
    generatedBy: "template:v1",
  });
  if (llm.name.startsWith("mock")) {
    const f = fallback();
    return { ...f, generatedBy: llm.name };
  }
  try {
    const raw = await llm.chat(
      [
        {
          role: "system",
          content: [
            "TASK: EMAIL_DRAFT. Write a short, plain-text B2B email for South Africa.",
            'Return strict JSON {"subject": string, "body": string}. Body max 120 words, starts with "Hi <first name>,".',
            "No links, phone numbers or email addresses. No signature, no unsubscribe line (added automatically). No false urgency or unverifiable claims.",
            ctx.purpose === "consent_request"
              ? "This is a ONE-TIME request for permission to send marketing emails. Ask for consent; do not market a product."
              : "This is a marketing email to a contact with a lawful basis on record.",
            `SENDER: ${sender.businessName}`,
            `RECIPIENT: ${ctx.firstName}, ${ctx.title ?? "unknown title"} at ${ctx.company ?? "unknown company"} (${ctx.industry ?? "unknown industry"})`,
            ctx.instructions ? `CAMPAIGN INSTRUCTIONS: ${ctx.instructions}` : "",
          ].join("\n"),
        },
        { role: "user", content: "JSON only." },
      ],
      { temperature: 0.5, maxTokens: 400 },
    );
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { subject?: string; body?: string };
    const subject = (j.subject ?? "").trim();
    const core = (j.body ?? "").trim();
    if (!subject || !core || core.length > 1500 || inventedDetailsInCore(`${subject}\n${core}`).length) return fallback();
    return { subject: subject.slice(0, 120), core, generatedBy: llm.name };
  } catch {
    return fallback();
  }
}

/** AI email drafts for eligible contacts. Nothing is sent: each draft waits for approval and a Send click. */
export async function generateEmailDrafts(
  db: Db,
  p: { contactIds: string[]; accountId: string; userId: string; purpose?: "marketing" | "consent_request"; campaignId?: string },
  llm: LlmClient = getLlm(),
) {
  const purpose = p.purpose ?? "marketing";
  const account = await db.emailAccount.findUniqueOrThrow({ where: { id: p.accountId } });
  if (!account.enabled) throw new AppError(`Mailbox "${account.label}" is disabled. Enable it on the Email page.`, "provider_disabled", 423);
  const sender = await getSenderProfile(db);
  if (!sender.businessName) throw new AppError("Set your business name (sender identity) on the Compliance page before drafting email");
  const campaign = p.campaignId ? await db.campaign.findUnique({ where: { id: p.campaignId } }) : null;
  const providerKey = account.isSimulated ? "simulated_email" : "smtp_email";
  const day = new Date().toISOString().slice(0, 10);
  const report = { created: [] as string[], skipped: [] as { contactId: string; reasons: string[] }[] };

  for (const contactId of p.contactIds) {
    const c = await db.contact.findUnique({ where: { id: contactId }, include: { company: true } });
    if (!c?.email) {
      report.skipped.push({ contactId, reasons: ["no email address on record"] });
      continue;
    }
    if (account.isSimulated !== c.isSimulated) {
      report.skipped.push({ contactId, reasons: [account.isSimulated ? "the simulated mailbox only emails dummy leads" : "real mailboxes never email dummy leads"] });
      continue;
    }
    const elig = await checkEligibility(db, { contactId, channel: "EMAIL", purpose, address: c.email, campaignId: p.campaignId, ignoreContactWindow: true });
    if (!elig.eligible) {
      report.skipped.push({ contactId, reasons: elig.reasons });
      continue;
    }
    const idempotencyKey = `email:${account.id}:${contactId}:${purpose}:${p.campaignId ?? "-"}:${day}`;
    if (await db.messageDraft.findUnique({ where: { idempotencyKey } })) {
      report.skipped.push({ contactId, reasons: ["already drafted today"] });
      continue;
    }
    const g = await generateEmailCore(llm, { firstName: c.firstName, title: c.title, company: c.company?.name, industry: c.company?.industry, instructions: campaign?.emailInstructions, purpose }, sender);
    const d = await db.messageDraft.create({
      data: {
        contactId,
        campaignId: p.campaignId,
        channel: "EMAIL",
        providerKey,
        emailAccountId: account.id,
        toAddress: c.email,
        subject: g.subject,
        body: composeEmailBody(g.core, account, sender),
        generatedBy: g.generatedBy,
        purpose,
        status: "PENDING_APPROVAL",
        eligibility: elig as unknown as Prisma.InputJsonValue,
        idempotencyKey,
      },
    });
    await audit(db, { actorId: p.userId, action: "email.draft_created", entityType: "message_draft", entityId: d.id, metadata: { contactId, generatedBy: g.generatedBy } });
    report.created.push(d.id);
  }
  return report;
}
