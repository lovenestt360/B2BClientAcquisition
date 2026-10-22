import { describe, expect, it } from "vitest";
import { ConversationEngine, type EngineConfig, type EngineAction } from "@/server/voice/engine";
import { MockLlmClient } from "@/server/ai/llm";
import { classifyIntent, matchSlot, mentionedHour } from "@/server/sales/intent";
import { freeSlots, pickTwo, slotLabel, availabilitySchema, zonedTime } from "@/server/sales/availability";
import type { LeadBrief } from "@/server/sales/brief";
import { playbookSchema } from "@/server/sales/playbook";

const TZ = "Africa/Johannesburg";
const NOW = new Date("2026-10-21T08:00:00Z"); // Wed 10:00 SAST
const avail = availabilitySchema.parse({ timeZone: TZ });
const slots = freeSlots(NOW, avail, []).map((d) => d.toISOString());

const brief: LeadBrief = {
  contactId: "c1", firstName: "Thandi", lastName: "Mokoena", title: "Operations Director", company: "Karoo Logistics",
  industry: "Logistics", city: "Johannesburg", email: "thandi@karoo.example", facts: [], history: [],
  angle: "ops", opener: "I'm calling because we help logistics firms cut admin.", pitch: "We'd cut your dispatch admin in half.",
  discoveryQuestions: ["How do you handle dispatch today?", "What would you improve first?", "Who else decides?"],
  objections: [{ objection: "not interested", response: "Fair enough, the first meeting is short and no-obligation." }],
  generatedBy: "test",
};
const playbook = playbookSchema.parse({ ownerName: "Mario", offer: "Ops automation", valueProps: ["cut admin"], pricingGuidance: "From R5,000 a month depending on scope.", meetingLengthMin: 20, meetingFormat: "video call" });
const cfg: EngineConfig = {
  businessName: "Demo Co", persona: "Friendly.", instructions: "Book a meeting.",
  disclosureText: "Hi {name}, this is an AI assistant calling for {owner} at {business}, speaking in {owner}'s voice.",
  silenceTimeoutMs: 5000, maxSilenceReprompts: 2, maxTurns: 30,
  sales: { brief, playbook, freeSlots: slots, timeZone: TZ, maxCloseAttempts: 2 },
};
const say = (a: EngineAction[]) => a.filter((x) => x.type === "speak").map((x) => (x as { text: string }).text).join(" ");
const types = (a: EngineAction[]) => a.map((x) => x.type);

async function talk(e: ConversationEngine, line: string) {
  await e.handle({ type: "agent_playback_finished" });
  return e.handle({ type: "user_utterance", text: line });
}

describe("sales call flow", () => {
  it("discloses AI and owner voice, discovers, pitches, offers two slots and books the chosen one", async () => {
    const e = new ConversationEngine(cfg, new MockLlmClient());
    const open = say(await e.handle({ type: "start" }));
    expect(open).toMatch(/^Hi Thandi, this is an AI assistant calling for Mario at Demo Co, speaking in Mario's voice\. I'm calling because .* Do you have two minutes\?$/);
    expect(say(await talk(e, "Sure, go ahead"))).toMatch(/How do you handle dispatch today\?/);
    expect(say(await talk(e, "Mostly spreadsheets and WhatsApp"))).toMatch(/What would you improve first\?/);
    const pitch = say(await talk(e, "Fewer errors on delivery notes"));
    expect(pitch).toMatch(/We'd cut your dispatch admin in half\. Would .* at \d\d:\d\d or .* at \d\d:\d\d work better for you\?/);
    const offered = e.state.sales!.offered;
    expect(offered).toHaveLength(2);
    const done = await talk(e, "The second one works");
    expect(types(done)).toEqual(["speak", "book_meeting", "end_call"]);
    expect(done[1]).toMatchObject({ type: "book_meeting", startIso: offered[1] });
    expect(say(done)).toMatch(/you're booked for .* calendar invite/);
    expect(e.state.sales!.stage).toBe("booked");
  });

  it("busy prospect goes straight to booking; an alternative day is confirmed before booking", async () => {
    const e = new ConversationEngine(cfg, new MockLlmClient());
    await e.handle({ type: "start" });
    expect(say(await talk(e, "I'm driving, bad time"))).toMatch(/book a short 20-minute video call\? Would/);
    // Ask for a weekday that was NOT offered → agent proposes a concrete time and asks to confirm.
    const offeredDays = e.state.sales!.offered.map((iso) => slotLabel(new Date(iso), TZ).split(",")[0]);
    const other = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].find((d) => !offeredDays.includes(d))!;
    const alt = await talk(e, `Can we do ${other} afternoon?`);
    expect(say(alt)).toMatch(new RegExp(`I can do ${other}, .* at 1\\d:\\d\\d\\. Shall I lock that in`));
    expect(types(alt)).toEqual(["speak"]);
    const booked = await talk(e, "Yes please");
    expect(types(booked)).toEqual(["speak", "book_meeting", "end_call"]);
    expect(slotLabel(new Date((booked[1] as { startIso: string }).startIso), TZ)).toMatch(new RegExp(`^${other}`));
  });

  it("handles objections at most twice, then accepts the no without booking", async () => {
    const e = new ConversationEngine(cfg, new MockLlmClient());
    await e.handle({ type: "start" });
    const first = say(await talk(e, "Not interested"));
    expect(first).toMatch(/no-obligation\. Would a short 20-minute video call later this week be worth it\?/);
    expect(say(await talk(e, "No thanks"))).toMatch(/no-obligation/);
    const end = await talk(e, "I said no");
    expect(types(end)).toEqual(["speak", "end_call"]);
    expect(say(end)).toMatch(/I won't take more of your time/);
    expect(e.state.sales!.booked).toBeUndefined();
  });

  it("answers price from the playbook only, re-offers fresh slots, and opt-out still ends immediately", async () => {
    const e = new ConversationEngine(cfg, new MockLlmClient());
    await e.handle({ type: "start" });
    await talk(e, "busy now");
    const firstOffer = e.state.sales!.offered;
    expect(say(await talk(e, "How much does it cost?"))).toMatch(/^From R5,000 a month depending on scope\. Would/);
    expect(e.state.sales!.offered).not.toEqual(firstOffer);
    const out = await talk(e, "Please don't call me again");
    expect(out.at(-1)).toEqual({ type: "end_call", reason: "opt_out" });
    expect(e.state.optOut).toBe(true);
  });

  it("generic calls without a named owner read naturally", async () => {
    const e = new ConversationEngine({ ...cfg, sales: undefined, disclosureText: "Hi {name}, this is an AI assistant calling on behalf of {owner} at {business}, speaking in {owner}'s voice." }, new MockLlmClient());
    expect(say(await e.handle({ type: "start" }))).toBe("Hi there, this is an AI assistant calling on behalf of Demo Co.");
  });

  it("without a sales config behaves as before", async () => {
    const plain = new ConversationEngine({ ...cfg, sales: undefined, disclosureText: "Hi, I'm an AI for {business}." }, new MockLlmClient());
    expect(say(await plain.handle({ type: "start" }))).toBe("Hi, I'm an AI for Demo Co.");
  });
});

describe("intent and slot matching", () => {
  it.each([
    ["yes sure", "affirm"], ["No thanks", "decline"], ["we already have a supplier", "decline"], ["I'm in a meeting", "busy"],
    ["How much is it?", "question"], ["no problem, go ahead", "affirm"], ["hmm interesting", "other"],
  ])("%s → %s", (t, i) => expect(classifyIntent(t)).toBe(i));

  it("reads hours", () => {
    expect(mentionedHour("at 2pm")).toBe(14);
    expect(mentionedHour("10:30 works")).toBe(10);
    expect(mentionedHour("at 2")).toBe(14);
    expect(mentionedHour("nothing")).toBeNull();
  });

  it("matches ordinals and day/time against offered slots before alternatives", () => {
    const offered = pickTwo(slots.map((s) => new Date(s)), TZ).map((d) => d.toISOString());
    expect(matchSlot("the first one please", offered, slots, TZ)).toEqual({ iso: offered[0], fromOffer: true });
    const day = slotLabel(new Date(offered[1]), TZ).split(",")[0];
    expect(matchSlot(`${day} is good`, offered, slots, TZ)).toEqual({ iso: offered[1], fromOffer: true });
    const alt = matchSlot("monday at 11", offered, slots, TZ);
    expect(alt?.fromOffer).toBe(false);
    expect(slotLabel(new Date(alt!.iso), TZ)).toMatch(/^Monday, .* at 11:00$/);
  });
});

describe("availability", () => {
  it("respects working days, hours, notice, holidays and existing meetings with buffer", () => {
    expect(slots.length).toBeGreaterThan(10);
    expect(slotLabel(new Date(slots[0]), TZ)).toBe("Thursday, 22 October at 09:00"); // ≥18h notice from Wed 10:00
    for (const s of slots) {
      const l = slotLabel(new Date(s), TZ);
      expect(l).not.toMatch(/^(Saturday|Sunday)/);
      const h = Number(l.slice(-5, -3));
      expect(h >= 9 && h < 16).toBe(true);
    }
    const busy = [{ startsAt: zonedTime(2026, 10, 22, 9, 0, TZ), endsAt: zonedTime(2026, 10, 22, 9, 30, TZ) }];
    const after = freeSlots(NOW, avail, busy).map((d) => slotLabel(d, TZ));
    expect(after[0]).toBe("Thursday, 22 October at 10:00"); // 09:30 blocked by 15-min buffer
    const dec = freeSlots(new Date("2026-12-14T08:00:00Z"), avail, []).map((d) => slotLabel(d, TZ));
    expect(dec.some((l) => l.startsWith("Wednesday, 16 December"))).toBe(false); // Day of Reconciliation
  });
  it("picks two options on different days", () => {
    const [a, b] = pickTwo(slots.map((s) => new Date(s)), TZ);
    expect(slotLabel(a, TZ).split(" at")[0]).not.toBe(slotLabel(b, TZ).split(" at")[0]);
  });
});
