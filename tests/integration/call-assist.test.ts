import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, grantConsent, makeContact, resetDb, setupOutreach } from "./helpers";
import { queueManualCall, recordCallOutcome } from "@/server/voice/calls";
import { assistAudio, assistEvent, startAssist } from "@/server/voice/assist";
import { savePlaybook } from "@/server/sales/playbook";
import { setEmergencyStop } from "@/server/compliance/controls";
import { MockLlmClient } from "@/server/ai/llm";
import { MockSttClient } from "@/server/voice/speech";
import { setClock } from "@/server/clock";

beforeEach(resetDb);
afterEach(() => setClock(null));
const deps = { llm: new MockLlmClient(), stt: new MockSttClient() };

async function setup(over: { country?: string | null; isSimulated?: boolean } = {}) {
  const { admin, actor } = await setupOutreach();
  await savePlaybook(db, { ownerName: "Mario", offer: "We automate dispatch admin for logistics firms.", valueProps: "Cut dispatch admin in half", proofPoints: "", meetingLengthMin: "30", meetingFormat: "video call" }, admin.id);
  const company = await db.company.create({ data: { name: "Karoo Logistics", normalizedName: "karoo logistics", industry: "Logistics" } });
  const lead = await makeContact(over);
  await db.contact.update({ where: { id: lead.id }, data: { companyId: company.id } });
  if (!over.isSimulated) await grantConsent(lead.id, "VOICE_MANUAL");
  const call = await queueManualCall(db, { contactId: lead.id }, actor, deps.llm);
  return { admin, actor, lead, call };
}

describe("live call assist", () => {
  it("runs a speakerphone call to a booked meeting, with notice before transcription and a prep summary", async () => {
    const { actor, lead, call } = await setup();
    const v = await startAssist(db, call.id, { source: "speakerphone" }, actor, deps);
    expect(v).toMatchObject({ status: "DIALING", stage: "opener", consent: { rule: "disclose", canTranscribe: false } });
    expect(v.suggestion.say).toMatch(/^Hi Lead\d+, it's Mario from Acme Ops/);

    // No transcription before the lead has been told.
    await expect(assistAudio(db, call.id, Buffer.from("hello"), "audio/webm", "auto", actor, deps)).rejects.toThrow(/tell the lead first/);
    await assistEvent(db, call.id, { type: "consent", answer: "told" }, actor, deps);

    const hear = (text: string) => assistAudio(db, call.id, Buffer.from(text), "audio/webm", "lead", actor, deps);
    await hear("Sure, go ahead");
    await hear("We do dispatch on spreadsheets and it breaks every morning");
    await hear("Drivers wait for paperwork for an hour");
    const ask = await hear("Yes, that sounds relevant");
    expect(ask.stage).toBe("meeting_ask");
    expect(ask.offered).toHaveLength(2);
    const agreed = await hear("The first one");
    expect(agreed.agreedSlot?.iso).toBe(ask.offered[0].iso);

    const booked = await assistEvent(db, call.id, { type: "book" }, actor, deps);
    expect(booked).toMatchObject({ stage: "booked", booked: { status: "tentative" } });
    const done = await assistEvent(db, call.id, { type: "finish" }, actor, deps);
    expect(done.finished).toBe(true);
    expect(done.summary!.painPoints).toContain("We do dispatch on spreadsheets and it breaks every morning");
    expect(done.transcript.map((t) => t.speaker)).toEqual(["lead", "lead", "lead", "lead", "lead"]);

    const meeting = await db.meeting.findFirstOrThrow({ where: { callId: call.id } });
    expect(meeting).toMatchObject({ source: "manual_call", status: "tentative" });
    expect(meeting.notes).toMatch(/Collect \(financial\):[\s\S]*Budget range/);
    expect((await db.contact.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("MEETING_BOOKED");

    await recordCallOutcome(db, call.id, { outcome: "MEETING_BOOKED" }, actor);
    expect(await db.call.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: "COMPLETED", outcome: "MEETING_BOOKED" });
    const actions = (await db.auditLog.findMany({ where: { entityId: { in: [call.id, meeting.id] } } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["call.assist_start", "call.transcription_consent", "meeting.booked_on_call", "call.assist_finish", "call.outcome"]));
  });

  it("outside ZA the lead must agree; a refusal keeps transcription off but typed notes still work", async () => {
    const { actor, call } = await setup({ country: "GB", isSimulated: true });
    await startAssist(db, call.id, { source: "speakerphone" }, actor, deps);
    const told = await assistEvent(db, call.id, { type: "consent", answer: "told" }, actor, deps);
    expect(told.consent.canTranscribe).toBe(false);
    await assistEvent(db, call.id, { type: "consent", answer: "refused" }, actor, deps);
    await expect(assistEvent(db, call.id, { type: "utterance", speaker: "lead", text: "hello", origin: "speech" }, actor, deps)).rejects.toThrow(/Transcription is off/);
    const typed = await assistEvent(db, call.id, { type: "utterance", speaker: "lead", text: "Sure, go ahead", origin: "typed" }, actor, deps);
    expect(typed.stage).toBe("discovery");
  });

  it("flags an opt-out, and only the outcome you save records the suppression", async () => {
    const { actor, lead, call } = await setup();
    await startAssist(db, call.id, { source: "speakerphone" }, actor, deps);
    const v = await assistEvent(db, call.id, { type: "utterance", speaker: "lead", text: "Take me off your list, don't call me again" }, actor, deps);
    expect(v).toMatchObject({ stage: "opt_out", optOut: true });
    await expect(assistEvent(db, call.id, { type: "stage", stage: "pitch" }, actor, deps)).rejects.toThrow(/Cannot move/);
    await recordCallOutcome(db, call.id, { outcome: "OPT_OUT_REQUESTED" }, actor);
    expect(await db.suppression.count({ where: { e164: lead.phoneNumbers[0].e164 } })).toBe(1);
  });

  it("refuses to start when outreach is halted, and the softphone stays off until enabled", async () => {
    const { admin, actor, call } = await setup();
    await expect(startAssist(db, call.id, { source: "softphone" }, actor, deps)).rejects.toThrow(/disabled/);
    await setEmergencyStop(db, true, { id: admin.id, role: admin.role }, "test");
    await expect(startAssist(db, call.id, { source: "speakerphone" }, actor, deps)).rejects.toThrow();
    expect((await db.call.findUniqueOrThrow({ where: { id: call.id } })).status).toBe("QUEUED");
  });
});
