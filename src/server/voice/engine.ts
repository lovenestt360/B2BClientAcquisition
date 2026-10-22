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
import type { LeadBrief } from "../sales/brief";
import type { Playbook } from "../sales/playbook";
import { classifyIntent, isPriceQuestion, matchSlot } from "../sales/intent";
import { pickTwo, slotLabel } from "../sales/availability";

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
  sales?: SalesState;
}

/** Sales call progress: permission → discovery → close (offer slots) → booked. */
export interface SalesState {
  stage: "permission" | "discovery" | "close" | "booked" | "closed_no";
  discoveryAsked: number;
  closeAttempts: number;
  offered: string[]; // ISO starts offered most recently
  everOffered: string[];
  pending?: string; // alternative slot awaiting confirmation
  booked?: string;
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
  | { type: "book_meeting"; startIso: string; label: string }
  | { type: "end_call"; reason: EndReason };

export interface EngineConfig {
  businessName: string;
  persona: string;
  instructions: string;
  disclosureText: string;
  silenceTimeoutMs: number;
  maxSilenceReprompts: number;
  maxTurns: number;
  /** When set, the agent runs a goal-driven sales call aimed at booking a meeting. */
  sales?: SalesConfig;
}

export interface SalesConfig {
  brief: LeadBrief;
  playbook: Playbook;
  freeSlots: string[]; // ISO starts, earliest first
  timeZone: string;
  maxCloseAttempts: number; // after this many "no"s, accept it and leave politely
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
        const sc = this.cfg.sales;
        const owner = sc?.playbook.ownerName;
        let disclosure = this.cfg.disclosureText;
        if (!owner) {
          // No named owner: drop the owner phrases instead of repeating the business name.
          disclosure = disclosure
            .replace(/,?\s*speaking in \{owner\}'s voice/g, "")
            .replace(/\{owner\} at \{business\}/g, "{business}");
        }
        disclosure = disclosure
          .replaceAll("{business}", this.cfg.businessName || "our company")
          .replaceAll("{owner}", owner || "our team")
          .replaceAll("{name}", sc?.brief.firstName ?? "there");
        if (!sc) return [this.say(disclosure)];
        s.sales = { stage: "permission", discoveryAsked: 0, closeAttempts: 0, offered: [], everOffered: [] };
        return [this.say(`${disclosure} ${sc.brief.opener} Do you have two minutes?`)];
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

    if (this.cfg.sales && s.sales) return [...pre, ...(await this.salesTurn(text))];

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


  // ───────────── Sales flow ─────────────

  private async salesTurn(text: string): Promise<EngineAction[]> {
    const sc = this.cfg.sales!;
    const st = this.state.sales!;
    const intent = classifyIntent(text);
    const name = sc.brief.firstName;

    if (st.stage === "permission") {
      if (intent === "busy") {
        st.stage = "close";
        return [this.say(`No problem at all. Rather than keep you now, could we book a short ${sc.playbook.meetingLengthMin}-minute ${sc.playbook.meetingFormat}? ${this.offerSlots()}`)];
      }
      if (intent === "decline") return this.handleNo(text, true);
      st.stage = "discovery";
      st.discoveryAsked = 1;
      const ack = await this.bridge(text, "acknowledge briefly and warmly that they have a moment");
      return [this.say(`${ack} ${sc.brief.discoveryQuestions[0]}`)];
    }

    if (st.stage === "discovery") {
      if (intent === "decline" || intent === "busy") return this.handleNo(text, true);
      if (intent === "question") return [this.say(`${await this.answer(text)} ${sc.brief.discoveryQuestions[st.discoveryAsked] ?? ""}`.trim())];
      if (st.discoveryAsked < Math.min(2, sc.brief.discoveryQuestions.length)) {
        const ack = await this.bridge(text, "acknowledge what they said in one short sentence, without asking a question");
        const q = sc.brief.discoveryQuestions[st.discoveryAsked];
        st.discoveryAsked += 1;
        return [this.say(`${ack} ${q}`)];
      }
      st.stage = "close";
      const pitch = await this.pitch(text);
      return [this.say(`${pitch} ${this.offerSlots()}`)];
    }

    if (st.stage === "close") {
      // Confirming an alternative we proposed?
      if (st.pending && intent === "affirm") return this.book(st.pending);
      const m = matchSlot(text, st.offered, sc.freeSlots, sc.timeZone);
      if (m?.fromOffer) return this.book(m.iso);
      if (m) {
        st.pending = m.iso;
        return [this.say(`I can do ${this.label(m.iso)}. Shall I lock that in for you?`)];
      }
      if (intent === "affirm") return [this.say(`Great. Which suits you better, ${this.label(st.offered[0])} or ${this.label(st.offered[1] ?? st.offered[0])}?`)];
      if (intent === "question") return [this.say(`${await this.answer(text)} ${this.offerSlots(true)}`)];
      if (intent === "decline" || intent === "busy") return this.handleNo(text, false);
      const ack = await this.bridge(text, "respond helpfully in one sentence, then steer back to booking the meeting");
      return [this.say(`${ack} ${this.offerSlots(true)}`)];
    }
    return this.endWith("completed", `Thank you, ${name}. Goodbye.`);
  }

  /** A "no": handle the objection up to maxCloseAttempts times, then accept it gracefully. */
  private async handleNo(text: string, early: boolean): Promise<EngineAction[]> {
    const sc = this.cfg.sales!;
    const st = this.state.sales!;
    st.closeAttempts += 1;
    st.pending = undefined;
    if (st.closeAttempts > sc.maxCloseAttempts) {
      st.stage = "closed_no";
      return this.endWith("completed", `Understood, I won't take more of your time. Thank you, ${sc.brief.firstName}, and have a good day. Goodbye.`);
    }
    st.stage = "close";
    const response = await this.objection(text);
    const ask = early
      ? `Would a short ${sc.playbook.meetingLengthMin}-minute ${sc.playbook.meetingFormat} later this week be worth it? ${this.offerSlots()}`
      : this.offerSlots();
    return [this.say(`${response} ${ask}`)];
  }

  private book(iso: string): EngineAction[] {
    const sc = this.cfg.sales!;
    const st = this.state.sales!;
    st.stage = "booked";
    st.booked = iso;
    st.pending = undefined;
    const label = this.label(iso);
    const invite = sc.brief.email ? "You'll receive a calendar invite at the email address we have for you." : "We'll confirm the details with you shortly.";
    const confirm = this.say(`Perfect, you're booked for ${label}, a ${sc.playbook.meetingLengthMin}-minute ${sc.playbook.meetingFormat}. ${invite} Thank you, ${sc.brief.firstName}. Goodbye.`);
    return [confirm, { type: "book_meeting", startIso: iso, label }, ...this.finish("completed")];
  }

  private offerSlots(fresh = false): string {
    const sc = this.cfg.sales!;
    const st = this.state.sales!;
    const free = sc.freeSlots.map((s) => new Date(s));
    let two = pickTwo(free, sc.timeZone, fresh ? st.everOffered : []);
    if (!two.length) two = pickTwo(free, sc.timeZone);
    st.offered = two.map((d) => d.toISOString());
    st.everOffered = [...new Set([...st.everOffered, ...st.offered])];
    if (!two.length) return "I'll ask a colleague to send you some times by email.";
    if (two.length === 1) return `Would ${this.label(st.offered[0])} work for you?`;
    return `Would ${this.label(st.offered[0])} or ${this.label(st.offered[1])} work better for you?`;
  }

  private label(iso: string) {
    return slotLabel(new Date(iso), this.cfg.sales!.timeZone);
  }

  // Model calls for wording only; every one has a deterministic fallback.
  private async bridge(text: string, task: string): Promise<string> {
    return this.salesLlm(`They said: "${text}". In ONE short sentence: ${task}.`, "Thanks, that's helpful.");
  }

  private async pitch(text: string): Promise<string> {
    return this.salesLlm(
      `They said: "${text}". In at most 3 short sentences, connect the offer to what they said using the brief's pitch, then say the best next step is a short meeting. Don't ask for a time yet.`,
      this.cfg.sales!.brief.pitch,
    );
  }

  private async objection(text: string): Promise<string> {
    const b = this.cfg.sales!.brief;
    const t = text.toLowerCase();
    const known =
      b.objections.find((o) => o.objection.split(/\s+/).some((w) => w.length > 3 && t.includes(w.toLowerCase())))?.response ??
      b.objections[0]?.response ??
      "I understand.";
    return this.salesLlm(`They objected: "${text}". In at most 2 short sentences, acknowledge respectfully and give one reason a short meeting is still worthwhile. No pressure, no false urgency.`, known);
  }

  private async answer(text: string): Promise<string> {
    const p = this.cfg.sales!.playbook;
    if (isPriceQuestion(text)) return p.pricingGuidance;
    return this.salesLlm(`They asked: "${text}". Answer in at most 2 short sentences using only the playbook. If the playbook doesn't cover it, say you'll cover it in the meeting.`, "Good question. That's exactly what we'd cover in the meeting.");
  }

  private async salesLlm(task: string, fallback: string): Promise<string> {
    if (this.llm.name.startsWith("mock")) return fallback;
    const sc = this.cfg.sales!;
    this.state.phase = "thinking";
    try {
      const out = (
        await this.llm.chat(
          [
            {
              role: "system",
              content: [
                `You are an AI assistant on a phone call on behalf of ${sc.playbook.ownerName || this.cfg.businessName} at ${this.cfg.businessName}. ${this.cfg.persona}`,
                "Spoken style: natural, warm, confident, brief. Never claim to be human. Use only the facts below; never invent numbers, clients, prices or promises.",
                `PLAYBOOK: ${JSON.stringify(sc.playbook)}`,
                `LEAD BRIEF: ${JSON.stringify({ ...sc.brief, email: undefined })}`,
                `INSTRUCTIONS: ${this.cfg.instructions}`,
              ].join("\n"),
            },
            ...this.state.turns
              .filter((t) => t.speaker !== "system")
              .slice(-8)
              .map((t) => ({ role: (t.speaker === "agent" ? "assistant" : "user") as "assistant" | "user", content: t.text })),
            { role: "user", content: `[TASK] ${task}` },
          ],
          { temperature: 0.5, maxTokens: 120 },
        )
      ).trim();
      if (!out || CLAIMS_HUMAN_RE.test(out) || /\?$/.test(out.split(/(?<=[.!])\s/).pop() ?? "") && task.includes("without asking")) return fallback;
      return out.replace(/^["']|["']$/g, "");
    } catch {
      return fallback;
    }
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
