import { z } from "zod";
import type { LlmClient } from "../ai/llm";

export const guidanceSchema = z.object({
  opener: z.string(),
  talkingPoints: z.array(z.string()).max(8),
  questions: z.array(z.string()).max(8),
  objections: z.array(z.object({ objection: z.string(), response: z.string() })).max(6),
  close: z.string(),
});
export type CallGuidance = z.infer<typeof guidanceSchema> & { generatedBy: string; complianceNotes: string[] };

export async function generateCallGuidance(
  llm: LlmClient,
  ctx: { firstName: string; title?: string | null; company?: string | null; industry?: string | null; instructions?: string | null; notes?: string | null; businessName: string },
): Promise<CallGuidance> {
  const complianceNotes = [
    "Identify yourself and your company at the start of the call.",
    "If they ask not to be contacted again, apologise, confirm, and record 'Opt-out requested'.",
    "Calls are never recorded. Live assist transcribes only after you tell the lead (outside ZA, after they agree); it hears your laptop mic or the browser softphone, never the iPhone itself.",
    "South Africa (CPA Reg 4): weekdays 08:00–20:00, Saturdays 09:00–13:00, never Sundays or public holidays.",
  ];
  const system = [
    "TASK: CALL_GUIDANCE",
    "Produce concise talking points for a human making a B2B phone call. Do not invent facts about the prospect;",
    "Use a direct peer-to-peer construction tone, acknowledge that the prospect may be on site, and ask permission to continue. If there is site noise or bad timing, stop the pitch and arrange a lawful follow-up.",
    "use only the context given. Return strict JSON with keys opener, talkingPoints[], questions[], objections[{objection,response}], close.",
    `CALLER COMPANY: ${ctx.businessName || "our company"}`,
    `PROSPECT: ${ctx.firstName}, ${ctx.title ?? "unknown title"} at ${ctx.company ?? "unknown company"} (${ctx.industry ?? "unknown industry"})`,
    ctx.notes ? `CRM NOTES: ${ctx.notes.slice(0, 500)}` : "",
    ctx.instructions ? `CAMPAIGN CALL INSTRUCTIONS: ${ctx.instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const raw = await llm.chat([{ role: "system", content: system }, { role: "user", content: "JSON only." }], { temperature: 0.3, maxTokens: 500 });
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    return { ...guidanceSchema.parse(JSON.parse(json)), generatedBy: llm.name, complianceNotes };
  } catch {
    return {
      opener: `Hi ${ctx.firstName}, <your name> here from ${ctx.businessName || "<company>"}. I know you're likely busy on site, so I'll be brief. Is now a bad time for two minutes?`,
      talkingPoints: ["Confirm their responsibility for BIM, MEP coordination or project delivery", `Tie the reason for calling to verified project context at ${ctx.company ?? "their company"}`, "Discuss preventing coordination issues from becoming rework, variations or programme pressure", "Do not quote savings or project results without recorded proof"],
      questions: ["How are you handling BIM and MEP coordination on the project today?", "Are you fully resourced internally, or is there pressure you may need to outsource?"],
      objections: [{ objection: "Send me an email", response: "Happy to. What's the one thing you'd want it to cover?" }],
      close: "Suggest a 15-minute technical scoping discussion with two specific time options.",
      generatedBy: "template:v1",
      complianceNotes,
    };
  }
}
