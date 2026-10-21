import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, makeContact, resetDb, setupOutreach } from "./helpers";
import { openDialer, queueManualCall, recordCallOutcome } from "@/server/voice/calls";
import { sandboxAudio, sandboxEvent, saveVoiceAgent, startSandbox } from "@/server/voice/sandbox";
import { MockLlmClient } from "@/server/ai/llm";
import { MockSttClient, MockTtsClient } from "@/server/voice/speech";
import { setClock } from "@/server/clock";

beforeEach(resetDb);
afterEach(() => setClock(null));

const deps = { llm: new MockLlmClient(), stt: new MockSttClient(), tts: new MockTtsClient() };

describe("iPhone manual calling", () => {
  it("queue → tel: link → user-entered outcome, with cost estimate and stage update", async () => {
    const { actor } = await setupOutreach();
    await db.carrierLine.updateMany({ data: { callRatePerMinCents: 99 } });
    const c = await makeContact();
    const call = await queueManualCall(db, { contactId: c.id }, actor);
    expect(call).toMatchObject({ status: "QUEUED", mode: "MANUAL", providerKey: "iphone_manual_call" });
    expect((call.guidance as { complianceNotes: string[] }).complianceNotes.join(" ")).toMatch(/cannot access iPhone call audio/);
    expect((await queueManualCall(db, { contactId: c.id }, actor)).id).toBe(call.id); // idempotent

    const { url } = await openDialer(db, call.id, actor);
    expect(url).toBe(`tel:${c.phoneNumbers[0].e164}`);
    await recordCallOutcome(db, call.id, { outcome: "MEETING_BOOKED", notes: "Tue 10:00", durationMin: "4.5" }, actor);

    const done = await db.call.findUniqueOrThrow({ where: { id: call.id }, include: { events: true } });
    expect(done).toMatchObject({ status: "COMPLETED", outcome: "MEETING_BOOKED", durationSec: 270, costCents: 495 });
    expect(done.events.map((e) => `${e.type}:${e.evidence}`)).toEqual(["queued:system", "dial_link_opened:system", "outcome_recorded:user_attestation"]);
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe("MEETING_BOOKED");
    await expect(recordCallOutcome(db, call.id, { outcome: "NO_ANSWER" }, actor)).rejects.toThrow(/Cannot move call/);
  });

  it("verbal opt-out suppresses the number and cancels queued calls", async () => {
    const { actor } = await setupOutreach();
    const c = await makeContact();
    const call = await queueManualCall(db, { contactId: c.id }, actor);
    await openDialer(db, call.id, actor);
    await recordCallOutcome(db, call.id, { outcome: "OPT_OUT_REQUESTED" }, actor);
    expect(await db.suppression.count({ where: { e164: c.phoneNumbers[0].e164 } })).toBe(1);
    await expect(queueManualCall(db, { contactId: c.id }, actor)).rejects.toThrow(/suppressed|withdrawn/);
  });

  it("dummy leads never dial their fictional number", async () => {
    const { actor } = await setupOutreach();
    const dummy = await makeContact({ isSimulated: true });
    const call = await queueManualCall(db, { contactId: dummy.id }, actor);
    await expect(openDialer(db, call.id, actor)).rejects.toThrow(/test number/);
    await db.carrierLine.updateMany({ data: { testNumberE164: "+27829990000" } });
    expect((await openDialer(db, call.id, actor)).url).toBe("tel:+27829990000");
  });
});

describe("local AI voice sandbox", () => {
  it("runs a simulated conversation with disclosure, barge-in and transcripts", async () => {
    const { actor } = await setupOutreach();
    const agent = await db.voiceAgentConfig.create({
      data: { name: "T", persona: "Helpful assistant", instructions: "Book a meeting", disclosureText: "Hello, I am an AI assistant for {business}.", silenceTimeoutMs: 4000 },
    });
    const s = await startSandbox(db, { voiceAgentId: agent.id }, actor, deps);
    expect(s.actions[0]).toMatchObject({ type: "speak", text: "Hello, I am an AI assistant for Acme Ops." });

    const b = await sandboxEvent(db, s.callId, { type: "user_speech_started" }, actor, deps);
    expect(b.actions).toEqual([{ type: "stop_speaking" }]);
    const u = await sandboxAudio(db, s.callId, Buffer.from("yes, tell me more"), "text/plain", actor, deps);
    expect(u.actions[0]).toMatchObject({ type: "speak" });
    await sandboxEvent(db, s.callId, { type: "agent_playback_finished" }, actor, deps);
    const end = await sandboxEvent(db, s.callId, { type: "user_utterance", text: "please remove me from your list" }, actor, deps);
    expect(end.phase).toBe("ended");

    const call = await db.call.findUniqueOrThrow({ where: { id: s.callId }, include: { transcripts: { orderBy: { seq: "asc" } }, events: true } });
    expect(call).toMatchObject({ status: "COMPLETED", mode: "SIMULATED", outcome: "OPT_OUT_REQUESTED" });
    expect(call.transcripts.map((t) => [t.speaker, t.interrupted])).toEqual([["agent", true], ["human", false], ["agent", false], ["human", false], ["agent", false]]);
    expect(call.events.map((e) => e.type)).toContain("barge_in");
  });

  it("validates agent configs: AI disclosure and voice-owner consent", async () => {
    const { actor } = await setupOutreach();
    const base = { name: "Agent", persona: "A friendly assistant", instructions: "Qualify and book meetings", llmModel: "llama3.1:8b" };
    await expect(saveVoiceAgent(db, null, { ...base, disclosureText: "Hello this is Sam from Acme" }, actor)).rejects.toThrow(/AI/);
    await expect(saveVoiceAgent(db, null, { ...base, disclosureText: "Hi, I'm an AI assistant", ttsVoiceRef: "me.wav" }, actor)).rejects.toThrow(/your own voice/);
    const ok = await saveVoiceAgent(db, null, { ...base, disclosureText: "Hi, I'm an AI assistant", ttsVoiceRef: "me.wav", voiceOwnerConsent: "on" }, actor);
    expect(ok).toMatchObject({ voiceOwnerConsent: true, ttsVoiceRef: "me.wav" });
  });

  it("emergency hang-up ends the call immediately", async () => {
    const { actor } = await setupOutreach();
    const agent = await db.voiceAgentConfig.create({ data: { name: "T", persona: "p", instructions: "i", disclosureText: "I am an AI." } });
    const s = await startSandbox(db, { voiceAgentId: agent.id }, actor, deps);
    const r = await sandboxEvent(db, s.callId, { type: "emergency_hangup" }, actor, deps);
    expect(r.actions.map((a) => a.type)).toEqual(["stop_speaking", "end_call"]);
    expect(await db.auditLog.count({ where: { action: "voice.emergency_hangup" } })).toBe(1);
  });
});
