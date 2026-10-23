/**
 * Live call assist — the script brain for a call YOU make (iPhone on speaker, or the browser
 * softphone). Transport- and database-free so it can be unit tested.
 *
 *   opener ──yes/other──► discovery (≤2 questions, pain points collected) ──► pitch (sell the outcome)
 *      │                                                                       │
 *      ├─busy──► callback                                                      ▼
 *      └─no────► objection answer + meeting ask ◄──────────── meeting_ask: "Would <A> or <B> suit you?"
 *                                                              │ slot chosen → you press Book → booked
 *   opt-out phrase (any stage) → opt_out, deterministic apology   └ 2 refusals → closed_no
 *
 * Deterministic rules decide the stage, opt-outs and which meeting slot was agreed. The model only
 * rewords the lead-in of the next line and pulls short pain points out of what the lead said.
 * Fixed tails (slot offers, pricing line) are never left to the model.
 */
import { z } from "zod";
import type { LlmClient } from "../ai/llm";
import { findInventedDetails } from "../ai/drafts";
import type { LeadBrief } from "../sales/brief";
import type { Playbook } from "../sales/playbook";
import { classifyIntent, isPriceQuestion, matchSlot } from "../sales/intent";
import { pickTwo, slotLabel } from "../sales/availability";
import { BACKCHANNEL_RE, OPT_OUT_RE } from "./engine";
import { canAssistTransition, type AssistStage } from "./states";

export type Speaker = "caller" | "lead";
export type AssistSource = "speakerphone" | "softphone";

export interface AssistContext {
  brief: LeadBrief;
  playbook: Playbook;
  businessName: string;
  callerName: string;
  freeSlots: string[]; // ISO starts, earliest first
  timeZone: string;
}

export interface Suggestion {
  say: string;
  why: string;
  alternatives: string[];
  generatedBy: string;
}

/**
 * ZA (POPIA s18 openness; RICA s4 lets a party to the call monitor it): tell the lead before
 * transcribing. Elsewhere we apply the strictest common rule: every party must agree.
 */
export type ConsentRule = "disclose" | "agree";

export interface AssistState {
  source: AssistSource;
  stage: AssistStage;
  consent: { rule: ConsentRule; disclosedAt?: string; leadAgreedAt?: string; refusedAt?: string };
  painPoints: string[];
  objections: string[];
  discoveryAsked: number;
  objectionAnswers: number;
  offered: string[]; // ISO starts offered most recently
  everOffered: string[];
  pendingSlot?: string; // alternative the lead proposed, awaiting their yes
  agreedSlot?: string; // the lead accepted this time; you confirm with Book
  bookedMeetingId?: string;
  optOut: boolean;
  suggestion: Suggestion;
  recent: { speaker: Speaker; text: string }[]; // last turns, model context only
  nextSeq: number;
  finishedAt?: string;
}

export const DISCLOSURE_LINE =
  "Quick note before we start: I use a note-taking tool that transcribes this call so I can focus on you. Is that OK?";

const MAX_RECENT = 12;
const MAX_PAINS = 8;
const MAX_OBJECTION_ANSWERS = 2;

export function consentRuleFor(country: string | null | undefined): ConsentRule {
  return country === "ZA" ? "disclose" : "agree";
}

/** May the platform transcribe call audio right now? (Typed notes never need this.) */
export function canTranscribe(s: AssistState): boolean {
  if (s.consent.refusedAt || s.finishedAt) return false;
  return s.consent.rule === "disclose" ? !!s.consent.disclosedAt : !!s.consent.leadAgreedAt;
}

const lower1 = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const noDot = (t: string) => t.trim().replace(/[.!?]+$/, "");

function slotTail(ctx: AssistContext, offered: string[]) {
  const labels = offered.map((iso) => slotLabel(new Date(iso), ctx.timeZone));
  if (labels.length === 0) return "When would suit you best this week or next?";
  if (labels.length === 1) return `Would ${labels[0]} work for you?`;
  return `Would ${labels[0]} or ${labels[1]} work better for you?`;
}

function meetingPurpose(p: Playbook) {
  return `a ${p.meetingLengthMin}-minute ${p.meetingFormat} where you walk me through the project, and I come back with a proper technical and financial proposal`;
}

function offerSlots(s: AssistState, ctx: AssistContext) {
  const two = pickTwo(ctx.freeSlots.map((d) => new Date(d)), ctx.timeZone, s.everOffered).map((d) => d.toISOString());
  s.offered = two;
  s.everOffered = [...new Set([...s.everOffered, ...two])];
  return slotTail(ctx, two);
}

export function initialAssistState(ctx: AssistContext, source: AssistSource, rule: ConsentRule): AssistState {
  const { brief, businessName, callerName } = ctx;
  const say = `Hi ${brief.firstName}, it's ${callerName || "<your name>"} from ${businessName || "<your company>"}. ${brief.opener} Have you got two minutes?`;
  return {
    source,
    stage: "opener",
    consent: { rule },
    painPoints: [],
    objections: [],
    discoveryAsked: 0,
    objectionAnswers: 0,
    offered: [],
    everOffered: [],
    optOut: false,
    suggestion: {
      say,
      why: "Say who you are, why you're calling them specifically, and ask permission to continue.",
      alternatives: [`Hi ${brief.firstName}, ${callerName || "<your name>"} here from ${businessName || "<your company>"}. Did I catch you at a bad time?`],
      generatedBy: "rules:v1",
    },
    recent: [],
    nextSeq: 0,
  };
}

/** Speakerphone mode hears both people on one mic. A line that echoes your script is probably you. */
export function guessSpeaker(text: string, s: AssistState): Speaker {
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z']{3,}/g) ?? []);
  const said = words(text);
  if (said.size < 3) return "lead";
  for (const line of [s.suggestion.say, ...s.suggestion.alternatives]) {
    const script = words(line);
    let hit = 0;
    for (const w of said) if (script.has(w)) hit++;
    if (hit / said.size >= 0.6) return "caller";
  }
  return "lead";
}

function matchObjection(text: string, brief: LeadBrief) {
  const t = text.toLowerCase();
  const scored = brief.objections
    .map((o) => ({ o, hits: (o.objection.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => t.includes(w)).length }))
    .sort((a, b) => b.hits - a.hits);
  return scored[0]?.hits ? scored[0].o : null;
}

/** Deterministic next step after the lead speaks. `lead` may be reworded by the model; `tail` may not. */
export interface RuleStep {
  stage: AssistStage;
  lead: string;
  tail: string;
  why: string;
  alternatives: string[];
  rewordable: boolean;
}

export function addPain(s: AssistState, pain: string) {
  const p = noDot(pain).slice(0, 160);
  if (p.split(/\s+/).length < 3) return;
  if (s.painPoints.some((x) => x.toLowerCase() === p.toLowerCase())) return;
  s.painPoints = [...s.painPoints, p].slice(-MAX_PAINS);
}

function objectionOrClose(s: AssistState, ctx: AssistContext, text: string): RuleStep {
  const { brief, playbook } = ctx;
  if (s.objectionAnswers >= MAX_OBJECTION_ANSWERS) {
    return {
      stage: "closed_no",
      lead: `No problem at all, ${brief.firstName}. Thanks for your time.`,
      tail: "If anything changes, you know where to find us.",
      why: "Two objections answered already: accept the no and leave a good impression.",
      alternatives: [],
      rewordable: false,
    };
  }
  s.objectionAnswers++;
  s.objections = [...s.objections, noDot(text).slice(0, 120)].slice(-6);
  const o = matchObjection(text, brief) ?? brief.objections[0];
  return {
    stage: "meeting_ask",
    lead: `${o?.response ?? "Completely fair."} That's why I'd suggest ${meetingPurpose(playbook)}.`,
    tail: offerSlots(s, ctx),
    why: `Objection${o ? ` ("${o.objection}")` : ""}: acknowledge it, answer once, then make a low-commitment meeting ask.`,
    alternatives: brief.objections.filter((x) => x !== o).slice(0, 2).map((x) => x.response),
    rewordable: true,
  };
}

/** Returns null when the line needs no new suggestion (backchannel, or the call is over). */
export function ruleStep(s: AssistState, ctx: AssistContext, text: string): RuleStep | null {
  const { brief, playbook } = ctx;
  const t = text.trim();
  if (!t || BACKCHANNEL_RE.test(t)) return null;
  if (s.stage === "opt_out") return null;

  if (OPT_OUT_RE.test(t)) {
    s.optOut = true;
    return {
      stage: "opt_out",
      lead: `Understood, ${brief.firstName}. I'll make sure we don't contact you again.`,
      tail: "Sorry for the interruption, and have a good day.",
      why: "The lead asked not to be contacted. Confirm, apologise and end the call. Record the opt-out when you save the outcome.",
      alternatives: [],
      rewordable: false,
    };
  }

  const intent = classifyIntent(t);
  if (isPriceQuestion(t)) {
    const tail = s.stage === "meeting_ask" ? offerSlots(s, ctx) : `That's exactly what we'd scope properly in ${meetingPurpose(playbook)}.`;
    return {
      stage: s.stage === "opener" || s.stage === "discovery" || s.stage === "pitch" ? s.stage : "meeting_ask",
      lead: playbook.pricingGuidance,
      tail,
      why: "Price question: give only your pricing line, then bridge to the meeting where you'll quote properly.",
      alternatives: [],
      rewordable: false,
    };
  }
  if (intent === "busy" && s.stage !== "booked") {
    return {
      stage: "callback",
      lead: "No problem at all.",
      tail: "When's a better time for a quick five minutes, later today or tomorrow morning?",
      why: "Bad timing isn't a no. Get a specific callback time and note it in the outcome.",
      alternatives: [`Totally understand. Shall I just send a 20-minute invite so we're not playing phone tag? ${slotTail(ctx, s.offered)}`],
      rewordable: false,
    };
  }

  switch (s.stage) {
    case "opener":
    case "callback":
    case "closed_no": {
      if (intent === "decline") return objectionOrClose(s, ctx, t);
      s.discoveryAsked = 1;
      return {
        stage: "discovery",
        lead: "Thanks, I'll be quick.",
        tail: brief.discoveryQuestions[0] ?? "How are you handling that at the moment?",
        why: "Find their pain point before pitching anything. Let them talk; the pain points panel fills in as they answer.",
        alternatives: brief.discoveryQuestions.slice(1, 3),
        rewordable: true,
      };
    }
    case "discovery": {
      if (intent === "decline" && t.split(/\s+/).length <= 4) return objectionOrClose(s, ctx, t);
      addPain(s, t);
      const max = Math.min(2, brief.discoveryQuestions.length);
      if (s.discoveryAsked < max) {
        const q = brief.discoveryQuestions[s.discoveryAsked];
        s.discoveryAsked++;
        return {
          stage: "discovery",
          lead: "That makes sense.",
          tail: q,
          why: "Dig one level deeper into the pain: cost, frequency, who it affects.",
          alternatives: ["What does that cost you today, in time or money?", "What have you tried so far to fix it?"],
          rewordable: true,
        };
      }
      const pain = s.painPoints.at(-1);
      const vp = playbook.valueProps[0];
      const proof = playbook.proofPoints[0];
      return {
        stage: "pitch",
        lead: `${pain ? `So the real issue is ${lower1(noDot(pain))}. ` : ""}That's exactly where we help. ${brief.pitch}`,
        tail: "Does that sound like it could be relevant for you?",
        why: "Mirror their pain point, then sell the outcome (not features). Keep it under 30 seconds.",
        alternatives: [vp ? `In short: we ${lower1(noDot(vp))}.` : "", proof ? `For example, ${lower1(noDot(proof))}.` : ""].filter(Boolean),
        rewordable: true,
      };
    }
    case "pitch": {
      if (intent === "decline") return objectionOrClose(s, ctx, t);
      if (intent === "question") {
        return {
          stage: "pitch",
          lead: `Good question. In short: ${noDot(playbook.offer)}.`,
          tail: "The details depend on your setup, which is why a proper look at your project makes sense. Shall we set that up?",
          why: "Answer briefly from your playbook only, then steer back to the meeting.",
          alternatives: [],
          rewordable: true,
        };
      }
      addPain(s, t);
      return {
        stage: "meeting_ask",
        lead: `Great. The best next step is ${meetingPurpose(playbook)}.`,
        tail: offerSlots(s, ctx),
        why: "Ask for the meeting with two concrete options: it's easier to pick one than to say yes to 'sometime'.",
        alternatives: [],
        rewordable: true,
      };
    }
    case "meeting_ask": {
      const pick = matchSlot(t, s.offered, ctx.freeSlots, ctx.timeZone);
      const confirming = s.pendingSlot && (intent === "affirm" || pick?.iso === s.pendingSlot);
      const iso = confirming ? s.pendingSlot! : pick?.fromOffer ? pick.iso : undefined;
      if (iso) {
        s.agreedSlot = iso;
        s.pendingSlot = undefined;
        return {
          stage: "meeting_ask",
          lead: `Perfect, ${slotLabel(new Date(iso), ctx.timeZone)} it is. I'll send you an invite.`,
          tail: "To make it count, could you have the project details ready: what's not working, what you use today, your timeline and a rough budget range?",
          why: "Press Book now to hold the slot, then set expectations so you leave the meeting with everything you need for the proposal.",
          alternatives: [],
          rewordable: false,
        };
      }
      if (pick && !pick.fromOffer) {
        s.pendingSlot = pick.iso;
        return {
          stage: "meeting_ask",
          lead: `I can do ${slotLabel(new Date(pick.iso), ctx.timeZone)}.`,
          tail: "Shall I lock that in?",
          why: "They proposed another time that's free in your diary: confirm it before booking.",
          alternatives: [],
          rewordable: false,
        };
      }
      if (intent === "decline") return objectionOrClose(s, ctx, t);
      if (intent === "affirm") {
        return { stage: "meeting_ask", lead: "Great.", tail: `Which suits you better? ${slotTail(ctx, s.offered)}`, why: "They agreed in principle: pin down a specific time.", alternatives: [], rewordable: false };
      }
      return {
        stage: "meeting_ask",
        lead: "Understood.",
        tail: s.offered.length ? `${slotTail(ctx, s.offered)} Or tell me what suits you.` : offerSlots(s, ctx),
        why: "Keep the meeting ask open with concrete times.",
        alternatives: [],
        rewordable: true,
      };
    }
    case "booked":
      return {
        stage: "booked",
        lead: "Brilliant.",
        tail: `Thanks ${brief.firstName}, speak on ${s.agreedSlot ? slotLabel(new Date(s.agreedSlot), ctx.timeZone) : "the day"}.`,
        why: "The meeting is booked. Wrap up politely; don't keep selling.",
        alternatives: [],
        rewordable: false,
      };
    default:
      return null;
  }
}

const llmReply = z.object({
  say: z.string().min(2).max(400),
  painPoints: z.array(z.string().min(3).max(160)).max(4).default([]),
});

/**
 * Let the model reword the lead-in using the conversation so far. Any failure, invented detail or
 * human-unlike output falls back to the rule text. Never called for fixed lines.
 */
export async function rewordWithModel(llm: LlmClient, ctx: AssistContext, s: AssistState, step: RuleStep, lastLead: string): Promise<{ lead: string; pains: string[] } | null> {
  if (llm.name.startsWith("mock")) return null;
  try {
    const raw = await llm.chat(
      [
        {
          role: "system",
          content: [
            "TASK: CALL_ASSIST. You write the NEXT LINE a human salesperson will say on a live B2B phone call.",
            "Output strict JSON {\"say\": string, \"painPoints\": string[]}.",
            "say: 1-2 short spoken sentences that respond to what the lead just said and lead naturally into the FIXED ENDING (do not repeat the ending).",
            "painPoints: up to 3 short phrases naming business problems the lead just described (empty if none).",
            "Use ONLY the playbook and lead data. Never invent facts, numbers, clients, prices, links, emails or phone numbers.",
            `GOAL OF THIS STEP (${step.stage}): ${step.why}`,
            `DRAFT LINE: ${step.lead}`,
            `FIXED ENDING: ${step.tail}`,
            `PLAYBOOK: ${JSON.stringify({ offer: ctx.playbook.offer, valueProps: ctx.playbook.valueProps, proofPoints: ctx.playbook.proofPoints })}`,
            `LEAD: ${JSON.stringify({ name: ctx.brief.firstName, title: ctx.brief.title, company: ctx.brief.company, industry: ctx.brief.industry })}`,
            `PAIN POINTS SO FAR: ${JSON.stringify(s.painPoints)}`,
            `CONVERSATION: ${s.recent.map((r) => `${r.speaker === "caller" ? "YOU" : "LEAD"}: ${r.text}`).join(" | ")}`,
          ].join("\n"),
        },
        { role: "user", content: `The lead just said: "${lastLead.slice(0, 500)}". JSON only.` },
      ],
      { temperature: 0.4, maxTokens: 220, signal: AbortSignal.timeout(8000) },
    );
    const r = llmReply.parse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
    if (findInventedDetails(r.say).length || /\b(as an ai|language model)\b/i.test(r.say)) return null;
    return { lead: r.say.trim(), pains: r.painPoints };
  } catch {
    return null;
  }
}

/** Apply one utterance. Returns true when the suggestion changed. */
export async function applyUtterance(s: AssistState, ctx: AssistContext, speaker: Speaker, text: string, llm: LlmClient): Promise<boolean> {
  s.recent = [...s.recent, { speaker, text: text.slice(0, 500) }].slice(-MAX_RECENT);
  if (speaker === "caller") return false; // your own lines don't move the script; the lead's replies do
  const step = ruleStep(s, ctx, text);
  if (!step) return false;
  if (!canAssistTransition(s.stage, step.stage)) return false;
  let lead = step.lead;
  let generatedBy = "rules:v1";
  if (step.rewordable) {
    const m = await rewordWithModel(llm, ctx, s, step, text);
    if (m) {
      lead = m.lead;
      generatedBy = llm.name;
      for (const p of m.pains) addPain(s, p);
    }
  }
  s.stage = step.stage;
  s.suggestion = { say: `${lead} ${step.tail}`.trim(), why: step.why, alternatives: step.alternatives, generatedBy };
  return true;
}

/** You jumped stages by hand: give a sensible line for the new stage. */
export function suggestionForStage(s: AssistState, ctx: AssistContext, stage: AssistStage): Suggestion {
  const { brief, playbook } = ctx;
  const g = "rules:v1";
  switch (stage) {
    case "opener":
      return initialAssistState(ctx, s.source, s.consent.rule).suggestion;
    case "discovery": {
      const q = brief.discoveryQuestions[Math.min(s.discoveryAsked, brief.discoveryQuestions.length - 1)] ?? "How are you handling that today?";
      s.discoveryAsked = Math.max(1, s.discoveryAsked + 1);
      return { say: q, why: "Find the pain point: let them talk.", alternatives: brief.discoveryQuestions.filter((x) => x !== q).slice(0, 2), generatedBy: g };
    }
    case "pitch":
      return { say: `That's exactly where we help. ${brief.pitch}`, why: "Sell the outcome, tied to their pain points.", alternatives: playbook.proofPoints.slice(0, 2), generatedBy: g };
    case "meeting_ask":
      return { say: `The best next step is ${meetingPurpose(playbook)}. ${offerSlots(s, ctx)}`, why: "Ask for the meeting with two concrete times.", alternatives: [], generatedBy: g };
    case "callback":
      return { say: "When's a better time for a quick five minutes?", why: "Get a specific callback time.", alternatives: [], generatedBy: g };
    case "closed_no":
      return { say: `No problem, ${brief.firstName}. Thanks for your time.`, why: "Leave a good impression.", alternatives: [], generatedBy: g };
    case "booked":
      return {
        say: "Thanks, I'll send the invite now. Please bring what's not working, what you use today, your timeline and a rough budget range.",
        why: "Booked: set expectations for the meeting and wrap up.",
        alternatives: [],
        generatedBy: g,
      };
    case "opt_out":
      return { say: `Understood, ${brief.firstName}. I'll make sure we don't contact you again. Sorry for the interruption.`, why: "Confirm the opt-out and end the call.", alternatives: [], generatedBy: g };
  }
}

// ───── After the call: what to collect in the meeting for the proposal ─────

export interface CallSummary {
  painPoints: string[];
  projectHints: string[];
  objections: string[];
  meetingPrep: { technical: string[]; financial: string[] };
  nextStep: string;
  generatedBy: string;
}

const summaryReply = z.object({
  painPoints: z.array(z.string().min(3).max(200)).max(8),
  projectHints: z.array(z.string().min(3).max(200)).max(6),
  technical: z.array(z.string().min(3).max(200)).max(4),
  financial: z.array(z.string().min(3).max(200)).max(4),
});

const BASE_TECHNICAL = [
  "Walk-through of the current process or system, and exactly where it breaks",
  "Scope: what's in and out for this project",
  "Systems, tools and integrations involved",
  "Who uses it, and how many people or sites",
  "Timeline and any hard deadlines",
  "Success criteria: what 'fixed' looks like for them",
];
const BASE_FINANCIAL = [
  "Budget range, or how they will judge the cost",
  "What the problem costs them today (time, money, errors, lost sales)",
  "Who decides and who signs off",
  "Procurement needs (formal quote, vendor registration, B-BBEE certificate, PO)",
  "Preferred payment structure (once-off, phased, monthly)",
];

export async function buildCallSummary(llm: LlmClient, ctx: AssistContext, s: AssistState, transcript: { speaker: string; text: string }[]): Promise<CallSummary> {
  const nextStep =
    s.stage === "booked" && s.agreedSlot
      ? `Meeting on ${slotLabel(new Date(s.agreedSlot), ctx.timeZone)}: the lead presents the project; you collect the data for the proposal.`
      : s.stage === "callback"
        ? "Call back at the time they gave."
        : s.stage === "opt_out"
          ? "Do not contact again. Save the outcome as 'Asked not to be contacted'."
          : s.stage === "closed_no"
            ? "No meeting. Leave it, or try again in a few months if it fits."
            : "Follow up to agree a meeting time.";
  const fallback: CallSummary = {
    painPoints: s.painPoints,
    projectHints: [],
    objections: s.objections,
    meetingPrep: { technical: BASE_TECHNICAL, financial: BASE_FINANCIAL },
    nextStep,
    generatedBy: "rules:v1",
  };
  const leadLines = transcript.filter((t) => t.speaker === "lead");
  if (llm.name.startsWith("mock") || leadLines.length === 0) return fallback;
  try {
    const raw = await llm.chat(
      [
        {
          role: "system",
          content: [
            "TASK: CALL_SUMMARY. Summarise a B2B sales call to prepare the follow-up meeting where the lead presents a project and the seller collects data for a technical and financial proposal.",
            "Output strict JSON {painPoints[], projectHints[], technical[], financial[]}.",
            "painPoints: business problems the LEAD stated. projectHints: concrete project details the lead mentioned (systems, volumes, deadlines).",
            "technical / financial: up to 4 extra questions specific to THIS lead to ask in the meeting (generic ones are already covered).",
            "Use only what was said. Never invent facts, numbers, names, links, emails or phone numbers.",
            `SELLER OFFER: ${ctx.playbook.offer}`,
            `TRANSCRIPT: ${transcript.slice(-60).map((t) => `${t.speaker === "caller" ? "SELLER" : t.speaker === "lead" ? "LEAD" : "NOTE"}: ${t.text}`).join("\n")}`,
          ].join("\n"),
        },
        { role: "user", content: "JSON only." },
      ],
      { temperature: 0.2, maxTokens: 600, signal: AbortSignal.timeout(30_000) },
    );
    const r = summaryReply.parse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
    const all = [...r.painPoints, ...r.projectHints, ...r.technical, ...r.financial].join("\n");
    if (findInventedDetails(all).length) return fallback;
    const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])];
    return {
      painPoints: merge(s.painPoints, r.painPoints).slice(0, MAX_PAINS),
      projectHints: r.projectHints,
      objections: s.objections,
      meetingPrep: { technical: [...r.technical, ...BASE_TECHNICAL], financial: [...r.financial, ...BASE_FINANCIAL] },
      nextStep,
      generatedBy: llm.name,
    };
  } catch {
    return fallback;
  }
}

export function summaryAsNotes(sum: CallSummary): string {
  const list = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : "");
  return [
    list("Pain points from the call", sum.painPoints),
    list("Project details mentioned", sum.projectHints),
    list("Collect (technical)", sum.meetingPrep.technical),
    list("Collect (financial)", sum.meetingPrep.financial),
  ]
    .filter(Boolean)
    .join("\n\n");
}
