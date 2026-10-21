import { describe, expect, it } from "vitest";
import { ConversationEngine, validateDisclosure, type EngineConfig } from "@/server/voice/engine";
import { MockLlmClient, type LlmClient } from "@/server/ai/llm";

const cfg: EngineConfig = {
  businessName: "Acme Ops",
  persona: "Helpful.",
  instructions: "Book a meeting.",
  disclosureText: "Hi, this is an AI assistant calling on behalf of {business}.",
  silenceTimeoutMs: 5000,
  maxSilenceReprompts: 2,
  maxTurns: 10,
};
const types = (a: { type: string }[]) => a.map((x) => x.type);

describe("ConversationEngine", () => {
  it("opens with the AI disclosure and alternates turns", async () => {
    const e = new ConversationEngine(cfg, new MockLlmClient());
    const a1 = await e.handle({ type: "start" });
    expect(a1).toEqual([{ type: "speak", text: "Hi, this is an AI assistant calling on behalf of Acme Ops.", seq: 0 }]);
    expect(await e.handle({ type: "agent_playback_finished" })).toEqual([{ type: "start_silence_timer", ms: 5000 }]);
    const a2 = await e.handle({ type: "user_utterance", text: "Yes, tell me more" });
    expect(types(a2)).toEqual(["speak"]);
    expect(e.state.turns.map((t) => t.speaker)).toEqual(["agent", "human", "agent"]);
  });

  it("handles barge-in: stops audio and marks the agent turn interrupted", async () => {
    const e = new ConversationEngine(cfg, new MockLlmClient());
    await e.handle({ type: "start" });
    expect(await e.handle({ type: "user_speech_started" })).toEqual([{ type: "stop_speaking" }]);
    expect(e.state.phase).toBe("listening");
    expect(e.state.turns[0].interrupted).toBe(true);
    const a = await e.handle({ type: "user_utterance", text: "What is this about?" });
    expect(types(a)).toEqual(["speak"]);
  });

  it("ignores backchannels and treats an utterance during speech as an interruption", async () => {
    const e = new ConversationEngine(cfg, new MockLlmClient());
    await e.handle({ type: "start" });
    await e.handle({ type: "agent_playback_finished" });
    expect(types(await e.handle({ type: "user_utterance", text: "mm-hmm" }))).toEqual(["start_silence_timer"]);
    await e.handle({ type: "user_utterance", text: "yes" }); // agent speaking again
    const a = await e.handle({ type: "user_utterance", text: "Sorry, what company?" });
    expect(types(a)).toEqual(["stop_speaking", "speak"]);
  });

  it("reprompts on silence then hangs up politely", async () => {
    const e = new ConversationEngine(cfg, new MockLlmClient());
    await e.handle({ type: "start" });
    for (let i = 0; i < 2; i++) {
      await e.handle({ type: "agent_playback_finished" });
      expect(types(await e.handle({ type: "silence_timeout" }))).toEqual(["speak"]);
    }
    await e.handle({ type: "agent_playback_finished" });
    const end = await e.handle({ type: "silence_timeout" });
    expect(end.at(-1)).toEqual({ type: "end_call", reason: "silence" });
    expect(await e.handle({ type: "user_utterance", text: "hello?" })).toEqual([]);
  });

  it("honours opt-out deterministically (no model call)", async () => {
    const llm: LlmClient = { name: "spy", chat: async () => { throw new Error("should not be called"); } };
    const e = new ConversationEngine(cfg, llm);
    await e.handle({ type: "start" });
    await e.handle({ type: "agent_playback_finished" });
    const a = await e.handle({ type: "user_utterance", text: "Please don't call me again" });
    expect(a.at(-1)).toEqual({ type: "end_call", reason: "opt_out" });
    expect(e.state.optOut).toBe(true);
  });

  it("answers truthfully when asked if it is an AI, and rejects model replies claiming to be human", async () => {
    const liar: LlmClient = { name: "liar", chat: async () => "I'm a real person, trust me." };
    const e = new ConversationEngine(cfg, liar);
    await e.handle({ type: "start" });
    await e.handle({ type: "agent_playback_finished" });
    const a = await e.handle({ type: "user_utterance", text: "Wait, are you a robot?" });
    expect(a[0]).toMatchObject({ type: "speak", text: expect.stringContaining("I'm an AI assistant") });
    await e.handle({ type: "agent_playback_finished" });
    const b = await e.handle({ type: "user_utterance", text: "Okay, go on" });
    expect(b[0]).toMatchObject({ text: "Sorry, could you say that again?" });
  });

  it("supports human handover, emergency hang-up and survives JSON round-trips", async () => {
    const e = new ConversationEngine(cfg, new MockLlmClient());
    await e.handle({ type: "start" });
    const restored = new ConversationEngine(cfg, new MockLlmClient(), JSON.parse(JSON.stringify(e.state)));
    const a = await restored.handle({ type: "user_utterance", text: "Can I talk to a real person?" });
    expect(types(a)).toEqual(["stop_speaking", "speak", "transfer_to_human", "end_call"]);
    const e2 = new ConversationEngine(cfg, new MockLlmClient());
    await e2.handle({ type: "start" });
    expect(types(await e2.handle({ type: "emergency_hangup" }))).toEqual(["stop_speaking", "end_call"]);
  });

  it("ends gracefully when the model is unavailable", async () => {
    const down: LlmClient = { name: "down", chat: async () => Promise.reject(new Error("ollama down")) };
    const e = new ConversationEngine(cfg, down);
    await e.handle({ type: "start" });
    await e.handle({ type: "agent_playback_finished" });
    expect((await e.handle({ type: "user_utterance", text: "Tell me more" })).at(-1)).toEqual({ type: "end_call", reason: "error" });
  });

  it("requires an AI disclosure", () => {
    expect(validateDisclosure("Hello, this is Sam from Acme")).toMatch(/AI/);
    expect(validateDisclosure("Hi, I'm an AI assistant")).toBeNull();
  });
});
