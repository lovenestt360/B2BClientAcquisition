/**
 * Voice conversation engine — transport-independent.
 *
 * The engine consumes events from a transport (browser sandbox today, an authorised SIP media
 * bridge in future) and returns actions for the transport to perform. State is plain JSON so it
 * can be persisted between HTTP requests or media frames.
 *
 *  start ──► SPEAKING(disclosure) ──playback_finished──► LISTENING ──utterance──► THINKING ──► SPEAKING …
 *     user_speech_started while SPEAKING  → barge-in: stop audio, mark turn interrupted, LISTENING
 *     silence_timeout while LISTENING     → reprompt (≤ maxSilenceReprompts) then polite hang-up
 *     opt-out / "talk to a human" / bye   → deterministic handling, never left to the model
 *     emergency_hangup                    → immediate END, no further speech
 */
import type { ChatMessage, LlmClient } from "../ai/llm";

export type Phase = "idle" | "speaking" | "listening" | "thinking" | "human_takeover" | "ended";

export interface Turn {
  seq: number;
  speaker: "agent" | "human" | "system";
  text: string;
  interrupted?: boolean;
  atMs: number;
}

export interface EngineState {
  phase: Phase;
  turns: Turn[];
  nextSeq: number;
  silenceReprompts: number;
  agentTurns: number;
  startedAtMs: number;
  endedReason?: EndReason;
  optOut: boolean;
  humanRequested: boolean;
}

export type EndReason = "completed" | "opt_out" | "silence" | "max_turns" | "hangup" | "emergency_hangup" | "human_takeover" | "error";

export type EngineEvent =
  | { type: "start" }
  | { type: "agent_playback_finished" }
  | { type: "user_speech_started" }
  | { type: "user_utterance"; text: string }
  | { type: "silence_timeout" }
  | { type: "hangup" }
  | { type: "human_takeover" }
  | { type: "emergency_hangup" };

export type EngineAction =
  | { type: "speak"; text: string; seq: number }
  | { type: "stop_speaking" }
  | { type: "start_silence_timer"; ms: number }
  | { type: "transfer_to_human" }
  | { type: "end_call"; reason: EndReason };

export interface EngineConfig {
  businessName: string;
  persona: string;
  instructions: string;
  disclosureText: string;
  silenceTimeoutMs: number;
  maxSilenceReprompts: number;
  maxTurns: number;
}

const AI_DISCLOSURE_RE = /\b(AI|artificial intelligence)\b/i;

export function validateDisclosure(text: string): string | null {
  return AI_DISCLOSURE_RE.test(text) ? null : 'Disclosure must state that the caller is an AI (include "AI" or "artificial intelligence")';
}

const OPT_OUT_RE = /\b(do ?n[o']?t (call|contact|phone)|stop (calling|contacting)|remove (me|my (number|details))|take me off|unsubscribe|never call)\b/i;
const HUMAN_RE = /\b((speak|talk) (to|with) (a |an )?(real )?(human|person|someone|manager|agent)|real person)\b/i;
const AI_QUESTION_RE = /\b(are you|is this|am i talking to) (a |an )?(robot|bot|ai|machine|computer|real person|human|recording)\b/i;
const BYE_RE = /^\s*(ok(ay)?[, ]+)?(bye|goodbye|cheers|thanks,? bye)\b/i;
const BACKCHANNEL_RE = /^\s*(mm+[- ]?hmm+|mm+|mhm+|uh[- ]?huh|hmm+|ah+|uh+|um+)[.!?]?\s*$/i;
const CLAIMS_HUMAN_RE = /\b(i am|i'm) (a )?(real )?(human|person|not an? (ai|bot|robot))\b/i;

export function initialState(now = Date.now()): EngineState {
  return { phase: "idle", turns: [], nextSeq: 0, silenceReprompts: 0, agentTurns: 0, startedAtMs: now, optOut: false, humanRequested: false };
}

export class ConversationEngine {
  state: EngineState;

  constructor(
    private cfg: EngineConfig,
    private llm: LlmClient,
    state?: EngineState,
    private now: () => number = Date.now,
  ) {
    this.state = state ? structuredClone(state) : initialState(now());
  }

  async handle(event: EngineEvent): Promise<EngineAction[]> {
    const s = this.state;
    if (s.phase === "ended") return [];
    switch (event.type) {
      case "start": {
        if (s.phase !== "idle") return [];
        const disclosure = this.cfg.disclosureText.replaceAll("{business}", this.cfg.businessName || "our company");
        return [this.say(disclosure)];
      }
      case "agent_playback_finished":
        if (s.phase !== "speaking") return [];
        s.phase = "listening";
        return [{ type: "start_silence_timer", ms: this.cfg.silenceTimeoutMs }];

      case "user_speech_started": {
        if (s.phase !== "speaking") return [];
        // Barge-in: the human started talking over the agent.
        const last = [...s.turns].reverse().find((t) => t.speaker === "agent");
        if (last) last.interrupted = true;
        s.phase = "listening";
        return [{ type: "stop_speaking" }];
      }
      case "user_utterance":
        return this.onUtterance(event.text);

      case "silence_timeout": {
        if (s.phase !== "listening") return [];
        s.silenceReprompts += 1;
        if (s.silenceReprompts > this.cfg.maxSilenceReprompts) {
          return this.endWith("silence", "It sounds like now isn't a good time. I'll let you go. Goodbye.");
        }
        return [this.say(s.silenceReprompts === 1 ? "Sorry, are you still there?" : "I'm not hearing anything. Can you hear me?")];
      }
      case "hangup":
        return this.finish("hangup");
      case "emergency_hangup":
        this.system("Emergency hang-up by operator");
        return [{ type: "stop_speaking" }, ...this.finish("emergency_hangup")];
      case "human_takeover":
        this.system("Human operator took over");
        s.phase = "human_takeover";
        s.endedReason = "human_takeover";
        return [{ type: "stop_speaking" }, { type: "transfer_to_human" }];
    }
  }

  private async onUtterance(raw: string): Promise<EngineAction[]> {
    const s = this.state;
    const text = raw.trim();
    if (!text || s.phase === "human_takeover") return [];
    if (BACKCHANNEL_RE.test(text)) {
      // "mm-hmm" is not a turn; keep listening (or keep talking if we still are).
      return s.phase === "listening" ? [{ type: "start_silence_timer", ms: this.cfg.silenceTimeoutMs }] : [];
    }
    const pre: EngineAction[] = s.phase === "speaking" ? [{ type: "stop_speaking" }] : [];
    if (s.phase === "speaking") {
      const last = [...s.turns].reverse().find((t) => t.speaker === "agent");
      if (last) last.interrupted = true;
    }
    this.push("human", text);
    s.silenceReprompts = 0;

    if (OPT_OUT_RE.test(text)) {
      s.optOut = true;
      return [...pre, ...this.endWith("opt_out", "I'm sorry to have bothered you. I'll make sure you aren't contacted again. Goodbye.")];
    }
    if (HUMAN_RE.test(text)) {
      s.humanRequested = true;
      return [...pre, ...this.endWith("human_takeover", "Of course. I'll ask a colleague to follow up with you personally. Thank you, goodbye.", true)];
    }
    if (AI_QUESTION_RE.test(text)) {
      return [...pre, this.say(`Yes, I'm an AI assistant calling on behalf of ${this.cfg.businessName || "our company"}. Would you like to continue, or would you prefer a person to follow up?`)];
    }
    if (BYE_RE.test(text)) return [...pre, ...this.endWith("completed", "Thank you for your time. Goodbye.")];
    if (s.agentTurns >= this.cfg.maxTurns) {
      return [...pre, ...this.endWith("max_turns", "I don't want to take more of your time. I'll follow up by email. Goodbye.")];
    }

    s.phase = "thinking";
    let reply: string;
    try {
      reply = (await this.llm.chat(this.prompt(), { temperature: 0.5, maxTokens: 120 })).trim();
    } catch {
      return [...pre, ...this.endWith("error", "I'm sorry, I'm having technical trouble. Someone will follow up with you. Goodbye.")];
    }
    if (!reply || CLAIMS_HUMAN_RE.test(reply)) {
      reply = "Sorry, could you say that again?";
    }
    return [...pre, this.say(reply)];
  }

  private prompt(): ChatMessage[] {
    const system = [
      `You are an AI voice assistant calling on behalf of ${this.cfg.businessName || "a company"}. ${this.cfg.persona}`,
      `Goal and script: ${this.cfg.instructions}`,
      "Rules: speak naturally in at most two short sentences; ask one question at a time; never claim to be human;",
      "never invent facts, prices or commitments; if unsure, offer a human follow-up; respect any request to stop.",
    ].join("\n");
    const history: ChatMessage[] = this.state.turns
      .filter((t) => t.speaker !== "system")
      .map((t) => ({ role: t.speaker === "agent" ? "assistant" : "user", content: t.interrupted ? `${t.text} [interrupted]` : t.text }));
    return [{ role: "system", content: system }, ...history];
  }

  private say(text: string): EngineAction {
    const t = this.push("agent", text);
    this.state.phase = "speaking";
    this.state.agentTurns += 1;
    return { type: "speak", text, seq: t.seq };
  }

  private endWith(reason: EndReason, text: string, transfer = false): EngineAction[] {
    const speak = this.say(text);
    const actions: EngineAction[] = [speak];
    if (transfer) actions.push({ type: "transfer_to_human" });
    return [...actions, ...this.finish(reason)];
  }

  private finish(reason: EndReason): EngineAction[] {
    this.state.phase = "ended";
    this.state.endedReason ??= reason;
    return [{ type: "end_call", reason: this.state.endedReason }];
  }

  private system(text: string) {
    this.push("system", text);
  }

  private push(speaker: Turn["speaker"], text: string): Turn {
    const t: Turn = { seq: this.state.nextSeq++, speaker, text, atMs: this.now() - this.state.startedAtMs };
    this.state.turns.push(t);
    return t;
  }
}
