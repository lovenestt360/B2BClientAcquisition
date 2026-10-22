import { z } from "zod";
import type { Db } from "@/lib/db";
import type { LlmClient } from "../ai/llm";
import { findInventedDetails } from "../ai/drafts";
import type { Playbook } from "./playbook";

export interface LeadBrief {
  contactId: string;
  firstName: string;
  lastName: string | null;
  title: string | null;
  company: string | null;
  industry: string | null;
  city: string | null;
  email: string | null;
  facts: { field: string; value: string; sourceUrl: string; confidence: number }[];
  history: string[];
  angle: string;
  opener: string;
  pitch: string;
  discoveryQuestions: string[];
  objections: { objection: string; response: string }[];
  generatedBy: string;
}

const aiPart = z.object({
  angle: z.string().min(5).max(300),
  opener: z.string().min(5).max(250),
  pitch: z.string().min(10).max(500),
  discoveryQuestions: z.array(z.string().min(5).max(200)).min(2).max(4),
  objections: z.array(z.object({ objection: z.string().max(120), response: z.string().max(300) })).max(5),
});

/** Everything we know about the lead, from our own records only. */
export async function collectLeadFacts(db: Db, contactId: string) {
  const c = await db.contact.findUniqueOrThrow({
    where: { id: contactId },
    include: {
      company: { include: { researchFacts: { orderBy: { verifiedAt: "desc" }, take: 8 } } },
      calls: { where: { outcome: { not: null } }, orderBy: { createdAt: "desc" }, take: 3 },
      emailMessages: { where: { direction: "inbound" }, orderBy: { occurredAt: "desc" }, take: 3 },
      smsEvents: { where: { direction: "inbound" }, orderBy: { occurredAt: "desc" }, take: 3 },
    },
  });
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const history = [
    ...c.calls.map((k) => `${day(k.createdAt)} call: ${k.outcome?.replace(/_/g, " ").toLowerCase()}${k.notes ? ` (${k.notes.slice(0, 120)})` : ""}`),
    ...c.emailMessages.map((e) => `${day(e.occurredAt)} email reply (${e.classification ?? "unclassified"}): ${e.bodyText.replace(/\s+/g, " ").slice(0, 120)}`),
    ...c.smsEvents.map((s) => `${day(s.occurredAt)} SMS reply: ${(s.body ?? "").slice(0, 120)}`),
  ];
  if (c.notes) history.unshift(`CRM notes: ${c.notes.slice(0, 300)}`);
  return {
    contact: c,
    facts: (c.company?.researchFacts ?? []).map((f) => ({ field: f.field, value: f.value, sourceUrl: f.sourceUrl, confidence: f.confidence })),
    history,
  };
}

function templateBrief(base: Omit<LeadBrief, "angle" | "opener" | "pitch" | "discoveryQuestions" | "objections" | "generatedBy">, p: Playbook) {
  const who = base.company ?? "your team";
  const vp = p.valueProps[0] ?? "save time on operations";
  const proof = p.proofPoints[0] ? ` For example, ${p.proofPoints[0].replace(/\.$/, "")}.` : "";
  return {
    angle: `${base.title ?? "Decision maker"} at ${who}${base.industry ? ` (${base.industry})` : ""}: lead with "${vp}".`,
    opener: `I'm calling because we help ${base.industry ? `${base.industry.toLowerCase()} ` : ""}businesses like ${who} ${vp.charAt(0).toLowerCase()}${vp.slice(1).replace(/\.$/, "")}.`,
    pitch: `Based on what you've said, the quickest win for ${who} would be to ${vp.charAt(0).toLowerCase()}${vp.slice(1).replace(/\.$/, "")}.${proof} The best next step is a short ${p.meetingLengthMin}-minute ${p.meetingFormat} to see if it fits.`,
    discoveryQuestions: [
      `How are you handling that at ${who} at the moment?`,
      "What would you most like to improve in the next few months?",
      "Who else would usually be involved in a decision like this?",
    ],
    objections: [
      { objection: "not interested", response: "Completely fair. Most people say that before seeing what's possible, which is why the first meeting is short and no-obligation." },
      { objection: "send me an email", response: "Happy to, and a quick call is usually faster to see whether it's even relevant for you." },
      { objection: "no budget", response: "Understood. The first conversation is just to see whether the numbers make sense; there's no commitment." },
      { objection: "already have a supplier", response: "That's good to hear. Many of our clients did too; the meeting is a quick comparison so you know your options." },
    ],
  };
}

/**
 * Pre-call brief: facts from our records + an angle, opener, pitch, questions and objection answers.
 * The model only rephrases the playbook for this lead; it must not add facts, numbers or contacts.
 */
export async function buildLeadBrief(db: Db, contactId: string, playbook: Playbook, llm: LlmClient): Promise<LeadBrief> {
  const { contact: c, facts, history } = await collectLeadFacts(db, contactId);
  const base = {
    contactId: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    title: c.title,
    company: c.company?.name ?? null,
    industry: c.company?.industry ?? null,
    city: c.company?.city ?? null,
    email: c.email,
    facts,
    history,
  };
  const fallback = { ...base, ...templateBrief(base, playbook), generatedBy: "template:v1" };
  if (llm.name.startsWith("mock")) return { ...fallback, generatedBy: llm.name };

  try {
    const raw = await llm.chat(
      [
        {
          role: "system",
          content: [
            "TASK: LEAD_BRIEF. Prepare a B2B sales call. Output strict JSON with keys angle, opener, pitch, discoveryQuestions[], objections[{objection,response}].",
            "Use ONLY the lead data and playbook below. Do not invent facts, numbers, clients, prices, links, emails or phone numbers.",
            "opener: one sentence on why you're calling, relevant to the lead. pitch: max 3 sentences tying the offer to the lead, ending with the meeting as next step.",
            `PLAYBOOK: ${JSON.stringify(playbook)}`,
            `LEAD: ${JSON.stringify({ ...base, email: undefined })}`,
          ].join("\n"),
        },
        { role: "user", content: "JSON only." },
      ],
      { temperature: 0.4, maxTokens: 700 },
    );
    const ai = aiPart.parse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
    const text = [ai.opener, ai.pitch, ...ai.objections.map((o) => o.response)].join("\n");
    if (findInventedDetails(text).length) return fallback;
    return { ...base, ...ai, generatedBy: llm.name };
  } catch {
    return fallback;
  }
}
