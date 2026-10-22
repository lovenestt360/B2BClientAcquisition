import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, makeContact, resetDb, setupOutreach, BUSINESS_HOURS } from "./helpers";
import { sandboxEvent, startSandbox } from "@/server/voice/sandbox";
import { savePlaybook } from "@/server/sales/playbook";
import { bookFromCall } from "@/server/sales/booking";
import { busyMeetings } from "@/server/sales/availability";
import { MockLlmClient } from "@/server/ai/llm";
import { MockSttClient, MockTtsClient } from "@/server/voice/speech";
import { setClock } from "@/server/clock";

beforeEach(resetDb);
afterEach(() => setClock(null));
const deps = { llm: new MockLlmClient(), stt: new MockSttClient(), tts: new MockTtsClient() };

async function setup(isSimulated: boolean) {
  const { admin, actor } = await setupOutreach();
  await savePlaybook(db, { ownerName: "Mario", offer: "We automate dispatch admin for logistics firms.", valueProps: "Cut dispatch admin in half\nFewer delivery-note errors", proofPoints: "", meetingLengthMin: "20", meetingFormat: "video call" }, admin.id);
  const company = await db.company.create({ data: { name: "Karoo Logistics", normalizedName: "karoo logistics", industry: "Logistics", city: "Johannesburg" } });
  const lead = await makeContact({ isSimulated });
  await db.contact.update({ where: { id: lead.id }, data: { companyId: company.id, title: "Operations Director", notes: "Met at a logistics expo." } });
  await db.researchFact.create({ data: { companyId: company.id, field: "fleet_size", value: "about 40 trucks", sourceUrl: "https://karoo.example/about", confidence: 0.8, verifiedAt: new Date() } });
  const agent = await db.voiceAgentConfig.create({
    data: { name: "Mario AI", persona: "Warm, concise.", instructions: "Book a meeting.", disclosureText: "Hi {name}, this is an AI assistant calling for {owner} at {business}." },
  });
  return { actor, lead, agent };
}

const say = (r: { actions: { type: string; text?: string }[] }) => r.actions.filter((a) => a.type === "speak").map((a) => a.text).join(" ");

describe("AI sales call (sandbox)", () => {
  it("builds a lead brief, runs the call and records a simulated booking", async () => {
    const { actor, lead, agent } = await setup(true);
    const s = await startSandbox(db, { voiceAgentId: agent.id, contactId: lead.id }, actor, deps);
    expect(say(s)).toMatch(/AI assistant calling for Mario at Acme Ops\. I'm calling because .*Karoo Logistics/);
    expect(s.brief).toMatchObject({ company: "Karoo Logistics", facts: [{ field: "fleet_size", sourceUrl: "https://karoo.example/about" }] });
    expect(s.brief!.history[0]).toMatch(/Met at a logistics expo/);

    const step = (text: string) => sandboxEvent(db, s.callId, { type: "agent_playback_finished" }, actor, deps).then(() => sandboxEvent(db, s.callId, { type: "user_utterance", text }, actor, deps));
    await step("yes, go ahead");
    await step("spreadsheets mostly");
    const pitch = await step("fewer errors");
    expect(say(pitch)).toMatch(/Would .* or .* work better for you\?/);
    const done = await step("the first one");
    expect(done.phase).toBe("ended");
    expect(done.booking).toMatchObject({ status: "simulated" });

    const meeting = await db.meeting.findFirstOrThrow({ where: { contactId: lead.id } });
    expect(meeting).toMatchObject({ status: "simulated", source: "ai_sandbox", callId: s.callId, title: "Acme Ops × Karoo Logistics" });
    expect((meeting.endsAt.getTime() - meeting.startsAt.getTime()) / 60000).toBe(20);
    expect(await db.call.findUniqueOrThrow({ where: { id: s.callId } })).toMatchObject({ status: "COMPLETED", outcome: "MEETING_BOOKED" });
    expect((await db.contact.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("MEETING_BOOKED"); // dummy lead
    expect(await busyMeetings(db, BUSINESS_HOURS)).toHaveLength(0); // rehearsals never block the diary
  });

  it("a rehearsal with a real contact doesn't move their pipeline stage", async () => {
    const { actor, lead, agent } = await setup(false);
    const s = await startSandbox(db, { voiceAgentId: agent.id, contactId: lead.id }, actor, deps);
    const step = (text: string) => sandboxEvent(db, s.callId, { type: "agent_playback_finished" }, actor, deps).then(() => sandboxEvent(db, s.callId, { type: "user_utterance", text }, actor, deps));
    await step("I'm busy");
    await step("first one");
    expect((await db.contact.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("NEW");
    expect(await db.meeting.count({ where: { status: "simulated" } })).toBe(1);
  });

  it("refuses a lead call until the playbook describes the offer", async () => {
    const { actor } = await setupOutreach();
    const lead = await makeContact({ isSimulated: true });
    const agent = await db.voiceAgentConfig.create({ data: { name: "A", persona: "p", instructions: "i", disclosureText: "I am an AI." } });
    await expect(startSandbox(db, { voiceAgentId: agent.id, contactId: lead.id }, actor, deps)).rejects.toThrow(/sales playbook first.*describe what you sell/);
  });

  it("real bookings re-check the slot and flag clashes instead of double-booking", async () => {
    const { lead } = await setup(true);
    const call = await db.call.create({ data: { providerKey: "asterisk_sip_ai", mode: "AUTOMATED", contactId: lead.id, idempotencyKey: "k1" } });
    const startIso = "2026-10-22T08:00:00.000Z";
    const a = await bookFromCall(db, { callId: call.id, contactId: lead.id, startIso, lengthMin: 30, title: "T", simulated: false, label: "x" });
    const b = await bookFromCall(db, { callId: call.id, contactId: lead.id, startIso, lengthMin: 30, title: "T", simulated: false, label: "x" });
    expect([a.status, b.status]).toEqual(["tentative", "needs_reschedule"]);
  });
});
