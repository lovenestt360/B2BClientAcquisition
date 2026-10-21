import type { LlmClient } from "./llm";
import type { ReplyLabel } from "../email/parse";

const LABELS: ReplyLabel[] = ["interested", "not_interested", "question", "other"];

/** Offline keyword classifier (used for the mock LLM and as a fallback). */
export function keywordLabel(text: string): ReplyLabel {
  const t = text.toLowerCase();
  if (/\b(not interested|no thanks|no thank you|not at this time|we('re| are) (fine|sorted)|not for us)\b/.test(t)) return "not_interested";
  if (/\b(interested|sounds good|let's (talk|chat|meet)|book|schedule|call me|happy to (chat|talk|meet)|yes)\b/.test(t)) return "interested";
  if (/\?\s*$|\b(how much|what does|can you|could you|pricing|price|cost)\b/.test(t)) return "question";
  return "other";
}

/**
 * Classify a human reply. The model only chooses among fixed labels; opt-outs, bounces and
 * auto-replies are decided by rules before this is called.
 */
export async function classifyReply(llm: LlmClient, text: string): Promise<{ label: ReplyLabel; source: "llm" | "mock" | "rules" }> {
  if (llm.name.startsWith("mock")) return { label: keywordLabel(text), source: "mock" };
  try {
    const out = await llm.chat(
      [
        {
          role: "system",
          content:
            "Classify a reply to a B2B sales email. Answer with exactly one word from: interested, not_interested, question, other. " +
            "interested = wants to talk/meet or learn more; not_interested = declines; question = asks something without committing.",
        },
        { role: "user", content: text.slice(0, 2000) },
      ],
      { temperature: 0, maxTokens: 5 },
    );
    const label = out.trim().toLowerCase().replace(/[^a-z_]/g, "") as ReplyLabel;
    if (LABELS.includes(label)) return { label, source: "llm" };
  } catch {
    // fall through
  }
  return { label: keywordLabel(text), source: "rules" };
}
