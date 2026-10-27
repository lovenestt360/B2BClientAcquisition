import { describe, expect, it } from "vitest";
import { MockLlmClient, type LlmClient } from "@/server/ai/llm";
import { freeSlots, availabilitySchema } from "@/server/sales/availability";
import type { LeadBrief } from "@/server/sales/brief";
import { playbookSchema } from "@/server/sales/playbook";
import {
  applyRefinement,
  applyUtterance,
  refineWithModel,
  buildCallSummary,
  canTranscribe,
  consentRuleFor,
  guessSpeaker,
  initialAssistState,
  type AssistContext,
} from "@/server/voice/assist-script";
import { ASSIST_TRANSITIONS, canAssistTransition } from "@/server/voice/states";
import { SipSoftphoneAdapter } from "@/server/providers/softphone";

const TZ = "Africa/Johannesburg";
const NOW = new Date("2026-10-21T08:00:00Z"); // Wed 10:00 SAST
const slots = freeSlots(NOW, availabilitySchema.parse({ timeZone: TZ }), []).map((d) => d.toISOString());

const brief: LeadBrief = {
  contactId: "c1", firstName: "Thandi", lastName: "Mokoena", title: "Operations Director", company: "Karoo Logistics",
  industry: "Logistics", city: "Johannesburg", email: null, facts: [], history: [],
  angle: "ops", opener: "I'm calling because we help logistics firms cut admin.", pitch: "We'd cut your dispatch admin in half.",
  discoveryQuestions: ["How do you handle dispatch today?", "What would you improve first?"],
  objections: [
    { objection: "not interested", response: "Fair enough, the first meeting is short and no-obligation." },
    { objection: "send me an email", response: "Happy to, though a quick call is faster to see if it's relevant." },
  ],
  generatedBy: "test",
};
const playbook = playbookSchema.parse({ ownerName: "Mario", offer: "Ops automation for logistics firms", valueProps: ["cut admin"], proofPoints: ["a 30-truck fleet halved its dispatch time"], pricingGuidance: "It depends on scope; we quote after the meeting.", meetingLengthMin: 30, meetingFormat: "video call" });
const ctx: AssistContext = { brief, playbook, businessName: "Demo Co", callerName: "Mario", freeSlots: slots, timeZone: TZ };
const llm = new MockLlmClient();
const fresh = () => initialAssistState(ctx, "speakerphone", "disclose");

describe("live call assist script", () => {
  it("opens with who you are, why you're calling and a permission question", () => {
    const s = fresh();
    expect(s.stage).toBe("opener");
    expect(s.suggestion.say).toMatch(/^Hi Thandi, it's Mario from Demo Co\. I'm calling because .* Have you got two minutes\?$/);
  });

  it("runs opener → pain point discovery → outcome pitch → meeting ask → agreed slot", async () => {
    const s = fresh();
    applyUtterance(s, ctx, "lead", "Sure, go ahead");
    expect(s.stage).toBe("discovery");
    expect(s.suggestion.say).toMatch(/How do you handle dispatch today\?/);

    applyUtterance(s, ctx, "lead", "Mostly on spreadsheets and WhatsApp, it's chaos every morning");
    expect(s.stage).toBe("discovery");
    expect(s.suggestion.say).toMatch(/What would you improve first\?/);

    applyUtterance(s, ctx, "lead", "Drivers waiting for paperwork, we lose about an hour a day");
    expect(s.stage).toBe("pitch");
    expect(s.painPoints).toEqual(["Mostly on spreadsheets and WhatsApp, it's chaos every morning", "Drivers waiting for paperwork, we lose about an hour a day"]);
    expect(s.suggestion.say).toMatch(/^You mentioned mostly on spreadsheets and WhatsApp, it's chaos every morning. That's exactly where we help. We'd cut your dispatch admin in half./); // the most descriptive pain point

    applyUtterance(s, ctx, "lead", "Yes that sounds relevant");
    expect(s.stage).toBe("meeting_ask");
    expect(s.suggestion.say).toMatch(/30-minute video call where you walk me through the project.*technical and financial proposal.*Would .* or .* work better for you\?/);
    expect(s.offered).toHaveLength(2);

    applyUtterance(s, ctx, "lead", "The first one works");
    expect(s.agreedSlot).toBe(s.offered[0]);
    expect(s.suggestion.say).toMatch(/project details ready.*timeline and a rough budget range/);
  });

  it("your own lines are transcribed but don't move the script", async () => {
    const s = fresh();
    const before = s.suggestion.say;
    expect(applyUtterance(s, ctx, "caller", "Sure, go ahead")).toBe(false);
    expect(s.stage).toBe("opener");
    expect(s.suggestion.say).toBe(before);
  });

  it("handles an objection once with the playbook answer, then accepts a second no", async () => {
    const s = fresh();
    applyUtterance(s, ctx, "lead", "Not interested, thanks");
    expect(s.stage).toBe("meeting_ask");
    expect(s.suggestion.say).toMatch(/first meeting is short and no-obligation/);
    applyUtterance(s, ctx, "lead", "No thanks");
    expect(s.stage).toBe("meeting_ask");
    applyUtterance(s, ctx, "lead", "No");
    expect(s.stage).toBe("closed_no");
    expect(s.objections).toHaveLength(2);
  });

  it("busy → callback, price → pricing line only, opt-out → final", async () => {
    const busy = fresh();
    applyUtterance(busy, ctx, "lead", "I'm driving, call me later");
    expect(busy.stage).toBe("callback");

    const price = fresh();
    applyUtterance(price, ctx, "lead", "How much does it cost?");
    expect(price.suggestion.say).toMatch(/^It depends on scope; we quote after the meeting\./);

    const out = fresh();
    applyUtterance(out, ctx, "lead", "Please remove me from your list and don't call again");
    expect(out.stage).toBe("opt_out");
    expect(out.optOut).toBe(true);
    expect(applyUtterance(out, ctx, "lead", "Yes sure")).toBe(false);
    expect(out.stage).toBe("opt_out");
  });

  it("never lets the model touch fixed lines, and drops model text with invented contact details", async () => {
    const calls: string[] = [];
    const sneaky: LlmClient = {
      name: "ollama:test",
      async chat(m) {
        calls.push(m[0].content);
        return JSON.stringify({ say: "Call me on +27 82 123 4567 or see https://x.example", painPoints: [] });
      },
    };
    const s = fresh();
    applyUtterance(s, ctx, "lead", "Sure, go ahead");
    expect(calls).toHaveLength(0); // the rule line is instant; the model runs separately
    expect(await refineWithModel(sneaky, ctx, s)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(s.suggestion.generatedBy).toBe("rules:v1");
    expect(s.suggestion.say).not.toMatch(/\+27|https/);

    const out = fresh();
    applyUtterance(out, ctx, "lead", "Stop calling me");
    expect(out.refine).toBeUndefined(); // opt-out wording is deterministic, nothing to refine
    expect(await refineWithModel(sneaky, ctx, out)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("applies the model's wording and pain points only while the line is still current", async () => {
    const good: LlmClient = { name: "ollama:test", chat: async () => JSON.stringify({ say: "Got it, mornings sound painful.", painPoints: ["Morning dispatch chaos"] }) };
    const s = fresh();
    applyUtterance(s, ctx, "lead", "Sure");
    applyUtterance(s, ctx, "lead", "Mornings are chaos with dispatch");
    expect(s.suggestion.say).toMatch(/^That makes sense\. What would you improve first\?$/);
    const r = await refineWithModel(good, ctx, s);
    expect(applyRefinement(s, r!, good.name)).toBe(true);
    expect(s.suggestion.say).toBe("Got it, mornings sound painful. What would you improve first?");
    expect(s.painPoints).toContain("Morning dispatch chaos");
    expect(s.suggestion.generatedBy).toBe("ollama:test");

    // The lead spoke again before the model answered: the late rewording is dropped.
    const t = fresh();
    applyUtterance(t, ctx, "lead", "Sure");
    const late = await refineWithModel(good, ctx, t);
    applyUtterance(t, ctx, "lead", "We use spreadsheets for everything");
    expect(applyRefinement(t, late!, good.name)).toBe(false);
    expect(t.suggestion.generatedBy).toBe("rules:v1");
  });

  it("guesses speakerphone speakers: a line that echoes the script is you", () => {
    const s = fresh();
    expect(guessSpeaker("Hi Thandi it's Mario from Demo Co, have you got two minutes", s)).toBe("caller");
    expect(guessSpeaker("Who is this? We already have a supplier", s)).toBe("lead");
    expect(guessSpeaker("yes", s)).toBe("lead");
  });

  it("transcription needs a notice in ZA and agreement elsewhere; a refusal turns it off", () => {
    expect(consentRuleFor("ZA")).toBe("disclose");
    expect(consentRuleFor("GB")).toBe("agree");
    expect(consentRuleFor(null)).toBe("agree");
    const za = fresh();
    expect(canTranscribe(za)).toBe(false);
    za.consent.disclosedAt = "t";
    expect(canTranscribe(za)).toBe(true);
    za.consent.refusedAt = "t";
    expect(canTranscribe(za)).toBe(false);
    const gb = initialAssistState(ctx, "softphone", "agree");
    gb.consent.disclosedAt = "t";
    expect(canTranscribe(gb)).toBe(false);
    gb.consent.leadAgreedAt = "t";
    expect(canTranscribe(gb)).toBe(true);
  });

  it("stage transitions: opt-out is final and reachable from every other stage", () => {
    for (const [from, tos] of Object.entries(ASSIST_TRANSITIONS)) {
      if (from === "opt_out") expect(tos).toEqual([]);
      else expect(tos).toContain("opt_out");
    }
    expect(canAssistTransition("opener", "booked")).toBe(false);
    expect(canAssistTransition("meeting_ask", "booked")).toBe(true);
  });

  it("summary always lists what to collect for the technical and financial proposal", async () => {
    const s = fresh();
    s.painPoints = ["Drivers wait for paperwork every morning"];
    const sum = await buildCallSummary(llm, ctx, s, [{ speaker: "lead", text: "Drivers wait for paperwork every morning" }]);
    expect(sum.painPoints).toEqual(["Drivers wait for paperwork every morning"]);
    expect(sum.meetingPrep.technical.join(" ")).toMatch(/Scope/);
    expect(sum.meetingPrep.financial.join(" ")).toMatch(/Budget range/);
  });
});

describe("softphone provider", () => {
  it("is manual, validates E.164 and refuses to dial without SIP settings", async () => {
    const p = new SipSoftphoneAdapter();
    expect(p.capabilities).toMatchObject({ mode: "MANUAL", automatedSend: false, callRecording: false });
    expect(p.validateRecipient("+447700900123")).toBeNull();
    expect(p.validateRecipient("0821234567")).toMatch(/E\.164/);
    delete process.env.SIP_WSS_URL;
    await expect(p.prepareCall("+27821234567")).rejects.toThrow(/not configured/);
    Object.assign(process.env, { SIP_WSS_URL: "wss://pbx.example:8089/ws", SIP_URI: "sip:201@pbx.example", SIP_PASSWORD: "x" });
    await expect(p.prepareCall("+27821234567")).resolves.toEqual({ kind: "softphone", target: "sip:+27821234567@pbx.example" });
    delete process.env.SIP_WSS_URL;
  });
});
