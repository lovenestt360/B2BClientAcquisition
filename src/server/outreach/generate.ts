import { z } from "zod";
import type { Db } from "@/lib/db";
import type { LlmClient } from "../ai/llm";
import { latestPermission } from "../compliance/eligibility";
import { loadReferenceExamples, type Exposure, type OutreachSettings } from "./config";

// ───── Contract ─────

export interface EvidenceItem {
  id: string;
  scope: "company" | "contact";
  kind: string; // fact | project | role | sector | need_evidence
  field: string;
  value: string;
  sourceUrl: string;
  confidence: number;
  verifiedAt: string;
  isInference: boolean;
}

export interface PriorMessage {
  step: number;
  subject: string;
  body: string;
  exposure: string | null;
}

export interface GenerationInput {
  lead: { firstName: string; lastName: string | null; title: string | null; company: string | null; sector: string | null; city: string | null; country: string | null };
  campaign: { key: string; name: string; icp: string };
  step: number;
  totalSteps: number;
  verifiedResearch: EvidenceItem[];
  hypotheses: EvidenceItem[];
  approvedCapabilities: { id: string; text: string }[];
  exposureLibrary: Pick<Exposure, "id" | "label">[];
  priorMessages: PriorMessage[];
  permissionStatus: { basis: string | null; evidence: string | null };
  operationalContext: {
    meetingMinutes: number;
    bookingUrl: string | null;
    approvedLinkDomains: string[];
    wordRange: { min: number; max: number };
    bannedClaims: string[];
    senderName: string;
    businessName: string;
  };
}

export const generationOutputSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
  meetingCta: z.string().trim().min(1).max(400),
  chosenCommercialExposure: z.string().trim().min(1).max(120),
  supportingEvidenceIds: z.array(z.string()).default([]),
  hypotheticalClaims: z.array(z.string()).default([]),
  distinctFromPriorExplanation: z.string().default(""),
  riskFlags: z.array(z.string()).default([]),
  decision: z.enum(["APPROVE", "HOLD", "RESEARCH_REQUIRED"]),
});
export type GenerationOutput = z.infer<typeof generationOutputSchema>;

// ───── Evidence ─────

/** Sourced research for one lead: company facts and person facts, split into verified vs inference. */
export async function collectEvidence(db: Db, contactId: string, minConfidence: number) {
  const c = await db.contact.findUniqueOrThrow({ where: { id: contactId }, include: { company: true } });
  const facts = await db.researchFact.findMany({
    where: { OR: [{ contactId }, ...(c.companyId ? [{ companyId: c.companyId, contactId: null }] : [])] },
    orderBy: [{ confidence: "desc" }, { verifiedAt: "desc" }],
  });
  const items: EvidenceItem[] = facts.map((f) => ({
    id: f.id,
    scope: f.contactId ? "contact" : "company",
    kind: f.kind,
    field: f.field,
    value: f.value,
    sourceUrl: f.sourceUrl,
    confidence: f.confidence,
    verifiedAt: f.verifiedAt.toISOString(),
    isInference: f.isInference,
  }));
  const verified = items.filter((i) => !i.isInference && i.confidence >= minConfidence && /^https?:\/\//.test(i.sourceUrl));
  const hypotheses = items.filter((i) => !verified.includes(i));
  return { contact: c, verified, hypotheses };
}

export async function buildGenerationInput(
  db: Db,
  args: { contactId: string; campaign: { key: string; name: string; icpDescription: string | null }; step: number; totalSteps: number; prior: PriorMessage[]; settings: OutreachSettings },
): Promise<GenerationInput> {
  const s = args.settings;
  const { contact, verified, hypotheses } = await collectEvidence(db, args.contactId, s.minFactConfidence);
  const perms = await db.marketingPermission.findMany({ where: { contactId: args.contactId } });
  const perm = latestPermission(perms, "EMAIL");
  const sectorFact = verified.find((v) => v.kind === "sector" || v.field === "sector");
  return {
    lead: {
      firstName: contact.firstName,
      lastName: contact.lastName,
      title: contact.title,
      company: contact.company?.name ?? null,
      sector: sectorFact?.value ?? contact.company?.industry ?? null,
      city: contact.company?.city ?? null,
      country: contact.country,
    },
    campaign: { key: args.campaign.key, name: args.campaign.name, icp: args.campaign.icpDescription ?? "" },
    step: args.step,
    totalSteps: args.totalSteps,
    verifiedResearch: verified,
    hypotheses,
    approvedCapabilities: s.capabilities,
    exposureLibrary: s.exposures.filter((e) => !e.campaigns.length || e.campaigns.includes(args.campaign.key)).map((e) => ({ id: e.id, label: e.label })),
    priorMessages: args.prior,
    permissionStatus: { basis: perm?.status === "GRANTED" ? (perm.basis ?? "CONSENT") : contact.isExistingCustomer ? "EXISTING_CUSTOMER" : null, evidence: perm?.evidence ?? null },
    operationalContext: {
      meetingMinutes: s.meetingMinutes,
      bookingUrl: s.bookingUrl,
      approvedLinkDomains: s.approvedLinkDomains,
      wordRange: { min: s.wordRange.min, max: s.wordRange.max },
      bannedClaims: s.bannedClaims,
      senderName: s.senderName,
      businessName: s.businessName,
    },
  };
}

// ───── Prompt ─────

export const SCOPE_NOT_TEMPLATE = `CRITICAL: THIS IS SCOPE, NOT A TEMPLATE.
The guidance and any reference examples define what outreach must accomplish, not a fixed email
pattern. Use the lawfully obtained research on THIS lead to choose, yourself, the most relevant
commercial exposure, opening, scenario, tone, subject, structure and meeting invitation. Do not
copy examples, do not map fixed loss categories to fixed steps, do not start with "Imagine" or
"Suppose" by habit. Strategic constraints and compliance rules are mandatory; creative execution
is yours.`;

export function systemPrompt(input: GenerationInput, referenceExamples: string): string {
  const o = input.operationalContext;
  return `TASK: OUTREACH_EMAIL
${SCOPE_NOT_TEMPLATE}

Goal: a qualified ${o.meetingMinutes}-minute meeting. Every step (this is step ${input.step} of ${input.totalSteps}) stands alone and
asks for that meeting; do not wait for later steps and do not educate about BIM.
Reasoning lens (not a paragraph order): deepest credible business consequence -> why this recipient
or company is exposed -> plausible prevention/resolution relevant to ${o.businessName} -> a timely ${o.meetingMinutes}-minute meeting.

Hard rules:
- Use ONLY facts in verifiedResearch. Never invent projects, numbers, names, events, deadlines, disputes,
  internal failures or personal responsibility. Anything not verified must read as clearly hypothetical.
- Exactly one call to action: a ${o.meetingMinutes}-minute meeting invitation. Not "would you like to learn more?".
- ${o.bookingUrl ? `You may include this approved booking link once if it helps the single CTA: ${o.bookingUrl}` : "No booking link is approved: invite a reply to arrange the meeting."} At most one link, only https on ${o.approvedLinkDomains.join(", ") || "(none)"}; no shorteners, no attachments.
- Roughly ${o.wordRange.min}-${o.wordRange.max} words, plain text, greeting with the first name. Do NOT add a signature or opt-out line; the system appends them.
- Subject: short, specific, honest operational correspondence. No "Re:"/"Fwd:", no fake urgency, no prior-contact pretence, no inside knowledge.
- Choose a commercial exposure materially different from every prior message (see priorMessages) and explain why.
- Banned phrases: ${o.bannedClaims.join("; ")}.
- If research is too thin for credible personalisation, return decision RESEARCH_REQUIRED; if anything else is doubtful, HOLD.

Return ONLY JSON: {"subject","body","meetingCta","chosenCommercialExposure","supportingEvidenceIds":[],"hypotheticalClaims":[],"distinctFromPriorExplanation","riskFlags":[],"decision":"APPROVE|HOLD|RESEARCH_REQUIRED"}

REFERENCE MATERIAL (NON-BINDING; reasoning inspiration only, never copy):
${referenceExamples}`;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Generate with the self-hosted model; fall back to the evidence composer when the model is the
 * offline mock or returns something unusable. Either way the validator decides, not the generator.
 */
export async function generateOutreachEmail(
  llm: LlmClient,
  input: GenerationInput,
  exposures: Exposure[],
): Promise<{ output: GenerationOutput; generatedBy: string; modelError?: string }> {
  if (llm.name.startsWith("mock")) return { output: composeFromEvidence(input, exposures), generatedBy: "rules:evidence-composer" };
  try {
    const text = await llm.chat(
      [
        { role: "system", content: systemPrompt(input, loadReferenceExamples()) },
        { role: "user", content: JSON.stringify({ lead: input.lead, campaign: input.campaign, step: input.step, verifiedResearch: input.verifiedResearch, hypotheses: input.hypotheses, approvedCapabilities: input.approvedCapabilities, exposureLibrary: input.exposureLibrary, priorMessages: input.priorMessages, permissionStatus: input.permissionStatus }) },
      ],
      { temperature: 0.6, maxTokens: 700 },
    );
    return { output: generationOutputSchema.parse(extractJson(text)), generatedBy: llm.name };
  } catch (e) {
    return { output: composeFromEvidence(input, exposures), generatedBy: "rules:evidence-composer (model fallback)", modelError: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

// ───── Deterministic composer (offline / dry run / model fallback) ─────

const lc = (s: string) => s.toLowerCase();

/** Rank exposures by how strongly this lead's own evidence points to them. */
export function rankExposures(input: GenerationInput, exposures: Exposure[]): { exposure: Exposure; score: number; evidenceIds: string[] }[] {
  const prior = new Set(input.priorMessages.map((p) => p.exposure).filter(Boolean) as string[]);
  const pool = exposures.filter((e) => (!e.campaigns.length || e.campaigns.includes(input.campaign.key)) && !prior.has(e.id));
  const sources = [
    ...input.verifiedResearch.map((v) => ({ id: v.id, text: lc(`${v.field} ${v.value}`), weight: v.kind === "need_evidence" ? 3 : 1 })),
    { id: "", text: lc(`${input.lead.title ?? ""} ${input.lead.sector ?? ""}`), weight: 1 },
  ];
  return pool
    .map((e) => {
      let score = 0;
      const ids = new Set<string>();
      for (const src of sources) {
        const hits = e.keywords.filter((k) => src.text.includes(lc(k))).length;
        if (hits) {
          score += hits * src.weight;
          if (src.id) ids.add(src.id);
        }
      }
      return { exposure: e, score, evidenceIds: [...ids] };
    })
    .sort((a, b) => b.score - a.score || pool.indexOf(a.exposure) - pool.indexOf(b.exposure));
}

const sentence = (s: string) => {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Builds an email only from this lead's verified evidence and the approved exposure and
 * capability wording in the outreach config. Holds rather than writes when evidence is thin.
 */
export function composeFromEvidence(input: GenerationInput, exposures: Exposure[]): GenerationOutput {
  const o = input.operationalContext;
  const need = input.verifiedResearch.filter((v) => v.kind === "need_evidence");
  const hold = (decision: "HOLD" | "RESEARCH_REQUIRED", flag: string): GenerationOutput => ({
    subject: "-",
    body: "-",
    meetingCta: "-",
    chosenCommercialExposure: "-",
    supportingEvidenceIds: [],
    hypotheticalClaims: [],
    distinctFromPriorExplanation: "",
    riskFlags: [flag],
    decision,
  });
  if (!input.verifiedResearch.length || !need.length) return hold("RESEARCH_REQUIRED", "no verified need evidence for this lead");
  if (!input.lead.company) return hold("RESEARCH_REQUIRED", "company unknown");

  const ranked = rankExposures(input, exposures);
  const best = ranked[0];
  if (!best) return hold("HOLD", "no commercial exposure left that differs from earlier steps");
  if (best.score === 0) return hold("RESEARCH_REQUIRED", "evidence does not point to any approved commercial exposure");
  const e = best.exposure;
  const capability = input.approvedCapabilities.find((c) => c.id === e.capability) ?? input.approvedCapabilities[0];
  if (!capability) return hold("HOLD", "no approved capability wording");

  const project = input.verifiedResearch.find((v) => v.kind === "project");
  const company = input.lead.company;
  const sector = input.lead.sector;
  const evidenceIds = new Set(best.evidenceIds);
  if (project) evidenceIds.add(project.id);
  const sectorFact = input.verifiedResearch.find((v) => v.kind === "sector" || v.field === "sector");
  if (sector && sectorFact) evidenceIds.add(sectorFact.id);

  // Vary the frame by what the evidence supports, and away from the frames earlier steps used.
  const frames: { id: string; text: string }[] = [];
  if (project) frames.push({ id: "project", text: `On a project like the ${project.value.replace(/^the\s+/i, "")}, ${e.consequence}.` });
  if (sector) frames.push({ id: "sector", text: `For a business working in ${lc(sector)}, as ${company} does, ${e.consequence}.` });
  frames.push({ id: "company", text: `At ${company}, ${e.consequence}.` });
  const usedProject = !!project && input.priorMessages.some((p) => p.body.includes(project.value.replace(/^the\s+/i, "")));
  const candidates = usedProject ? frames.filter((f) => f.id !== "project") : frames;
  const frame = candidates[(input.step - 1) % candidates.length];
  if (frame.id !== "project" && project) evidenceIds.delete(project.id);
  const help = `${o.businessName} helps by ${capability.text}.`;
  const when = input.step === 1 ? "this week" : "in the coming days";
  const cta = `Would ${o.meetingMinutes} minutes ${when} be worthwhile to discuss ${e.prevention}?`;
  const link = o.bookingUrl ? `\n\nOr choose a time here: ${o.bookingUrl}` : "";
  // When a link is included, drop the stake line to stay short.
  const body = `Hi ${input.lead.firstName},\n\n${sentence(frame.text)}${o.bookingUrl ? "" : ` ${e.stake}`}\n\n${help}\n\n${cta}${link}`;
  const usesSector = frame.id === "sector";
  if (!usesSector && sectorFact) evidenceIds.delete(sectorFact.id);

  const suffix = frame.id === "project" && project ? project.value : company;
  let subject = `${e.subjectTopic} — ${suffix}`;
  if (subject.length > 70) subject = `${e.subjectTopic} — ${company}`.length <= 70 ? `${e.subjectTopic} — ${company}` : e.subjectTopic;

  return {
    subject,
    body,
    meetingCta: cta,
    chosenCommercialExposure: e.id,
    supportingEvidenceIds: [...evidenceIds],
    hypotheticalClaims: [sentence(frame.text)],
    distinctFromPriorExplanation: input.priorMessages.length
      ? `Argues ${e.label}; earlier steps argued ${input.priorMessages.map((p) => p.exposure ?? "?").join(", ")}.`
      : `First touch: strongest evidence-linked exposure (${e.label}).`,
    riskFlags: [],
    decision: "APPROVE",
  };
}
