import { env } from "@/lib/env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  readonly name: string;
  chat(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }): Promise<string>;
}

/** Self-hosted Ollama (POST /api/chat). */
export class OllamaClient implements LlmClient {
  constructor(
    private baseUrl: string,
    private model: string,
  ) {}
  get name() {
    return `ollama:${this.model}`;
  }
  async chat(messages: ChatMessage[], opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {}) {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        keep_alive: "30m", // stay loaded between calls; a cold load costs ~10 s on a laptop CPU
        options: { temperature: opts.temperature ?? 0.4, num_predict: opts.maxTokens ?? 300 },
      }),
      signal: opts.signal ?? AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return (data.message?.content ?? "").trim();
  }
}

/**
 * Deterministic offline stand-in used in simulation, tests and CI. It produces plausible
 * replies from simple cues so the conversation engine can be exercised without a model.
 */
export class MockLlmClient implements LlmClient {
  readonly name = "mock:rules";
  async chat(messages: ChatMessage[]) {
    const last = [...messages].reverse().find((m) => m.role === "user")?.content.toLowerCase() ?? "";
    const sys = messages.find((m) => m.role === "system")?.content ?? "";
    if (sys.includes("TASK: SMS_DRAFT")) {
      const name = /FIRST_NAME: (.*)/.exec(sys)?.[1] ?? "there";
      const company = /COMPANY: (.*)/.exec(sys)?.[1];
      return `Hi ${name}, we help ${company && company !== "unknown" ? company : "teams like yours"} cut admin time on operations. Open to a 15-min chat this week?`;
    }
    if (sys.includes("TASK: CALL_GUIDANCE")) {
      return JSON.stringify({
        opener: "Introduce yourself and your company in one sentence; ask if now is a good time.",
        talkingPoints: ["Confirm their role in operations decisions", "Ask about their biggest current bottleneck", "Share one relevant outcome"],
        questions: ["How do you handle this today?", "Who else is involved in decisions like this?"],
        objections: [{ objection: "Not interested", response: "Understood. May I send a one-line summary by email instead?" }],
        close: "Offer two specific meeting slots.",
      });
    }
    if (/\b(yes|sure|okay|ok|interested|tell me more)\b/.test(last)) return "Great. Would a 20-minute call on Tuesday or Thursday morning suit you?";
    if (/\b(busy|later|not now)\b/.test(last)) return "No problem. When would be a better time for a quick follow-up?";
    if (/\b(what|how|why)\b/.test(last)) return "We help operations teams reduce manual admin. Could I ask how you handle scheduling today?";
    return "Thanks for that. Would it be worth a short meeting to explore whether we can help?";
  }
}

export function getLlm(): LlmClient {
  const e = env();
  return e.LLM_PROVIDER === "ollama" ? new OllamaClient(e.OLLAMA_URL, e.OLLAMA_MODEL) : new MockLlmClient();
}
