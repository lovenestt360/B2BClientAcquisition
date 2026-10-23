import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError, ComplianceBlockedError } from "../errors";
import { checkEligibility } from "../compliance/eligibility";
import { getSenderProfile } from "../compliance/controls";
import { getLlm, type LlmClient } from "../ai/llm";
import { getProvider } from "../providers/registry";
import type { VoiceProvider } from "../providers/types";
import { getPlaybook, playbookReady } from "../sales/playbook";
import { busyMeetings, freeSlots, getAvailability, slotLabel } from "../sales/availability";
import { buildLeadBrief, type LeadBrief } from "../sales/brief";
import { bookFromCall } from "../sales/booking";
import { now as clockNow } from "../clock";
import { getStt, type SttClient } from "./speech";
import { assertAssistTransition, assertCallTransition, type AssistStage } from "./states";
import {
  DISCLOSURE_LINE,
  applyUtterance,
  buildCallSummary,
  canTranscribe,
  consentRuleFor,
  guessSpeaker,
  initialAssistState,
  suggestionForStage,
  summaryAsNotes,
  type AssistContext,
  type AssistSource,
  type AssistState,
  type CallSummary,
  type Suggestion,
} from "./assist-script";

type Actor = { id: string; role: string };

export interface AssistDeps {
  llm?: LlmClient;
  stt?: SttClient;
}

/** Stored in calls.engineState for manual calls run with live assist. */
interface AssistSnapshot {
  kind: "assist";
  ctx: AssistContext;
  state: AssistState;
}

export interface AssistView {
  callId: string;
  status: string;
  source: AssistSource;
  stage: AssistStage;
  consent: AssistState["consent"] & { canTranscribe: boolean; line: string };
  suggestion: Suggestion;
  painPoints: string[];
  objections: string[];
  offered: { iso: string; label: string }[];
  agreedSlot: { iso: string; label: string } | null;
  booked: { startIso: string; label: string; status: string } | null;
  optOut: boolean;
  finished: boolean;
  summary: CallSummary | null;
  transcript: { seq: number; speaker: string; text: string }[];
  brief: Pick<LeadBrief, "firstName" | "lastName" | "title" | "company" | "industry" | "angle" | "facts" | "history" | "objections" | "generatedBy">;
  /** Softphone only: the SIP target to dial (null for dummy leads, which are never dialled). */
  dialTarget?: string | null;
}

function snapshotOf(engineState: unknown): AssistSnapshot | null {
  const s = engineState as AssistSnapshot | null;
  return s?.kind === "assist" ? s : null;
}

async function view(db: Db, callId: string, extra: Partial<AssistView> = {}): Promise<AssistView> {
  const call = await db.call.findUniqueOrThrow({ where: { id: callId }, include: { transcripts: { orderBy: { seq: "asc" } } } });
  const snap = snapshotOf(call.engineState);
  if (!snap) throw new AppError("Live assist has not been started for this call", "not_started", 409);
  const { ctx, state: s } = snap;
  const meeting = s.bookedMeetingId ? await db.meeting.findUnique({ where: { id: s.bookedMeetingId } }) : null;
  const label = (iso: string) => slotLabel(new Date(iso), ctx.timeZone);
  const b = ctx.brief;
  return {
    callId,
    status: call.status,
    source: s.source,
    stage: s.stage,
    consent: { ...s.consent, canTranscribe: canTranscribe(s), line: DISCLOSURE_LINE },
    suggestion: s.suggestion,
    painPoints: s.painPoints,
    objections: s.objections,
    offered: s.offered.map((iso) => ({ iso, label: label(iso) })),
    agreedSlot: s.agreedSlot && !meeting ? { iso: s.agreedSlot, label: label(s.agreedSlot) } : null,
    booked: meeting ? { startIso: meeting.startsAt.toISOString(), label: label(meeting.startsAt.toISOString()), status: meeting.status } : null,
    optOut: s.optOut,
    finished: !!s.finishedAt,
    summary: (call.summary as unknown as CallSummary | null) ?? null,
    transcript: call.transcripts.map((t) => ({ seq: t.seq, speaker: t.speaker, text: t.text })),
    brief: { firstName: b.firstName, lastName: b.lastName, title: b.title, company: b.company, industry: b.industry, angle: b.angle, facts: b.facts, history: b.history, objections: b.objections, generatedBy: b.generatedBy },
    ...extra,
  };
}

export function getAssistView(db: Db, callId: string) {
  return view(db, callId);
}

export const startAssistInput = z.object({ source: z.enum(["speakerphone", "softphone"]) });

/**
 * Start live assist on a queued manual call: compliance check, lead brief, free slots, opening
 * line. Re-opening an assisted call returns the current state instead of starting over.
 */
export async function startAssist(db: Db, callId: string, raw: unknown, actor: Actor, deps: AssistDeps = {}): Promise<AssistView> {
  const { source } = startAssistInput.parse(raw);
  const call = await db.call.findUniqueOrThrow({ where: { id: callId }, include: { contact: true } });
  if (call.mode !== "MANUAL") throw new AppError("Live assist is for calls you make yourself");
  if (!call.contactId || !call.contact) throw new AppError("Call has no contact");
  const existing = snapshotOf(call.engineState);
  if (existing && !existing.state.finishedAt && ["QUEUED", "DIALING"].includes(call.status)) {
    return view(db, callId, existing.state.source === "softphone" ? { dialTarget: await softphoneTarget(db, call.toE164, call.contact.isSimulated) } : {});
  }
  if (call.status !== "QUEUED" && call.status !== "DIALING") throw new AppError("This call is already finished");

  const elig = await checkEligibility(db, { contactId: call.contactId, channel: "VOICE_MANUAL", address: call.toE164, campaignId: call.campaignId });
  if (!elig.eligible) throw new ComplianceBlockedError(elig.reasons);

  const providerKey = source === "softphone" ? "sip_softphone" : "iphone_manual_call";
  await getProvider<VoiceProvider>(db, providerKey); // must be enabled
  const dialTarget = source === "softphone" ? await softphoneTarget(db, call.toE164, call.contact.isSimulated) : undefined;

  const playbook = await getPlaybook(db);
  const missing = playbookReady(playbook);
  if (missing.length) throw new AppError(`Set up your sales playbook first: ${missing.join(", ")}`);
  const llm = deps.llm ?? getLlm();
  const avail = await getAvailability(db);
  const t = clockNow();
  const slots = freeSlots(t, avail, await busyMeetings(db, t), 40).map((d) => d.toISOString());
  const brief = await buildLeadBrief(db, call.contactId, playbook, llm);
  const sender = await getSenderProfile(db);
  const user = await db.user.findUnique({ where: { id: actor.id }, select: { name: true } });
  const ctx: AssistContext = {
    brief,
    playbook,
    businessName: sender.businessName,
    callerName: playbook.ownerName || user?.name || "",
    freeSlots: slots,
    timeZone: avail.timeZone,
  };
  const state = initialAssistState(ctx, source, consentRuleFor(call.contact.country));
  const snap: AssistSnapshot = { kind: "assist", ctx, state };

  if (call.status === "QUEUED") assertCallTransition(call.status, "DIALING");
  await db.call.update({
    where: { id: callId, status: call.status },
    data: { status: "DIALING", startedAt: call.startedAt ?? new Date(), providerKey, engineState: snap as unknown as Prisma.InputJsonValue },
  });
  await db.callEvent.create({ data: { callId, type: "assist_started", evidence: "user_attestation", data: { source, consentRule: state.consent.rule } } });
  await audit(db, { actorId: actor.id, action: "call.assist_start", entityType: "call", entityId: callId, metadata: { source, llm: llm.name } });
  return view(db, callId, { dialTarget });
}

async function softphoneTarget(db: Db, to: string | null, simulated: boolean): Promise<string | null> {
  if (simulated) return null; // dummy leads: rehearse without dialling a fictional number
  const { provider } = await getProvider<VoiceProvider>(db, "sip_softphone");
  const h = await provider.prepareCall(to);
  if (h.kind !== "softphone") throw new AppError("Unexpected provider response");
  return h.target;
}

export const assistEventInput = z.discriminatedUnion("type", [
  // told: you read the disclosure. leadAgreed / refused: their answer (agreement is required outside ZA).
  z.object({ type: z.literal("consent"), answer: z.enum(["told", "agreed", "refused"]) }),
  z.object({ type: z.literal("utterance"), speaker: z.enum(["caller", "lead", "auto"]), text: z.string().trim().min(1).max(2000), origin: z.enum(["typed", "speech"]).default("typed") }),
  z.object({ type: z.literal("stage"), stage: z.enum(["opener", "discovery", "pitch", "meeting_ask", "booked", "callback", "closed_no", "opt_out"]) }),
  z.object({ type: z.literal("book") }),
  z.object({ type: z.literal("finish") }),
]);
export type AssistEvent = z.infer<typeof assistEventInput>;

/** One event, serialised per call with a row lock (speech segments can arrive back to back). */
export async function assistEvent(db: Db, callId: string, raw: unknown, actor: Actor, deps: AssistDeps = {}): Promise<AssistView> {
  const ev = assistEventInput.parse(raw);
  const llm = deps.llm ?? getLlm();
  await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM calls WHERE id = ${callId} FOR UPDATE`;
      const call = await tx.call.findUniqueOrThrow({ where: { id: callId }, include: { contact: true } });
      const snap = snapshotOf(call.engineState);
      if (!snap) throw new AppError("Live assist has not been started for this call", "not_started", 409);
      const { ctx, state: s } = snap;
      if (s.finishedAt && ev.type !== "finish") throw new AppError("This call has been wrapped up");
      const at = new Date().toISOString();

      switch (ev.type) {
        case "consent": {
          if (ev.answer === "refused") s.consent.refusedAt = at;
          else {
            s.consent.disclosedAt ??= at;
            if (ev.answer === "agreed") s.consent.leadAgreedAt = at;
          }
          await tx.callEvent.create({ data: { callId, type: `transcription_${ev.answer}`, evidence: "user_attestation", data: { rule: s.consent.rule } } });
          await audit(tx as Db, { actorId: actor.id, action: "call.transcription_consent", entityType: "call", entityId: callId, metadata: { answer: ev.answer, rule: s.consent.rule } });
          break;
        }
        case "utterance": {
          if (ev.origin === "speech" && !canTranscribe(s)) throw new AppError("Transcription is off: tell the lead first (and outside South Africa, they must agree)", "consent_required", 403);
          const speaker = ev.speaker === "auto" ? guessSpeaker(ev.text, s) : ev.speaker;
          await tx.callTranscript.create({ data: { callId, seq: s.nextSeq++, speaker, text: ev.text } });
          await applyUtterance(s, ctx, speaker, ev.text, llm);
          break;
        }
        case "stage": {
          if (ev.stage === "booked") throw new AppError("Use Book to confirm a meeting time");
          assertAssistTransition(s.stage, ev.stage);
          s.suggestion = suggestionForStage(s, ctx, ev.stage);
          if (ev.stage === "opt_out") s.optOut = true;
          s.stage = ev.stage;
          await tx.callEvent.create({ data: { callId, type: "assist_stage", evidence: "user_attestation", data: { stage: ev.stage } } });
          break;
        }
        case "book": {
          if (!s.agreedSlot) throw new AppError("No time has been agreed yet");
          if (!call.contactId) throw new AppError("Call has no contact");
          assertAssistTransition(s.stage, "booked");
          const meeting = await bookFromCall(tx as Db, {
            callId,
            contactId: call.contactId,
            startIso: s.agreedSlot,
            label: slotLabel(new Date(s.agreedSlot), ctx.timeZone),
            lengthMin: ctx.playbook.meetingLengthMin,
            title: `${ctx.businessName || "Meeting"} × ${ctx.brief.company ?? `${ctx.brief.firstName} ${ctx.brief.lastName ?? ""}`.trim()}`,
            simulated: !!call.contact?.isSimulated, // dummy leads never block the diary
            bookedBy: "user",
          });
          s.bookedMeetingId = meeting.id;
          s.suggestion = suggestionForStage(s, ctx, "booked");
          s.stage = "booked";
          await audit(tx as Db, { actorId: actor.id, action: "meeting.booked_on_call", entityType: "meeting", entityId: meeting.id, metadata: { callId, status: meeting.status } });
          break;
        }
        case "finish": {
          if (s.finishedAt) break;
          s.finishedAt = at;
          const transcript = await tx.callTranscript.findMany({ where: { callId }, orderBy: { seq: "asc" } });
          const summary = await buildCallSummary(llm, ctx, s, transcript);
          await tx.call.update({ where: { id: callId }, data: { summary: summary as unknown as Prisma.InputJsonValue } });
          if (s.bookedMeetingId) {
            const m = await tx.meeting.findUnique({ where: { id: s.bookedMeetingId } });
            if (m) await tx.meeting.update({ where: { id: m.id }, data: { notes: [m.notes, summaryAsNotes(summary)].filter(Boolean).join("\n\n") } });
          }
          await tx.callEvent.create({ data: { callId, type: "assist_finished", evidence: "user_attestation", data: { stage: s.stage, summaryBy: summary.generatedBy } } });
          await audit(tx as Db, { actorId: actor.id, action: "call.assist_finish", entityType: "call", entityId: callId, metadata: { stage: s.stage } });
          break;
        }
      }
      await tx.call.update({ where: { id: callId }, data: { engineState: snap as unknown as Prisma.InputJsonValue } });
    },
    { timeout: 90_000 },
  );
  return view(db, callId);
}

/**
 * One speech segment from the browser. Consent is checked BEFORE the audio is processed; the
 * audio is transcribed and discarded, only the text is kept.
 */
export async function assistAudio(db: Db, callId: string, audio: Buffer, mime: string, speaker: "caller" | "lead" | "auto", actor: Actor, deps: AssistDeps = {}) {
  const call = await db.call.findUniqueOrThrow({ where: { id: callId } });
  const snap = snapshotOf(call.engineState);
  if (!snap || !canTranscribe(snap.state)) throw new AppError("Transcription is off: tell the lead first (and outside South Africa, they must agree)", "consent_required", 403);
  const { text } = await (deps.stt ?? getStt()).transcribe(audio, mime);
  if (!text.trim()) return view(db, callId);
  return assistEvent(db, callId, { type: "utterance", speaker, text, origin: "speech" }, actor, deps);
}

/** Outcome to preselect in the form, from where the script ended. */
export function suggestedOutcome(stage: AssistStage) {
  return (
    { booked: "MEETING_BOOKED", callback: "CONNECTED_CALLBACK", closed_no: "CONNECTED_NOT_INTERESTED", opt_out: "OPT_OUT_REQUESTED" } as Partial<Record<AssistStage, string>>
  )[stage] ?? "CONNECTED_INTERESTED";
}
