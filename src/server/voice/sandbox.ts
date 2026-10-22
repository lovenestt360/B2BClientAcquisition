import { z } from "zod";
import type { Prisma, VoiceAgentConfig } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError } from "../errors";
import { getSenderProfile } from "../compliance/controls";
import { getLlm, type LlmClient } from "../ai/llm";
import { getProvider } from "../providers/registry";
import { ConversationEngine, validateDisclosure, type EngineAction, type EngineEvent, type EngineState, type SalesConfig } from "./engine";
import { getPlaybook, playbookReady } from "../sales/playbook";
import { busyMeetings, freeSlots, getAvailability, slotLabel } from "../sales/availability";
import { buildLeadBrief, type LeadBrief } from "../sales/brief";
import { bookFromCall } from "../sales/booking";
import { now as clockNow } from "../clock";
import { getStt, getTts, type SttClient, type TtsClient } from "./speech";

type Actor = { id: string; role: string };

export interface SandboxDeps {
  llm?: LlmClient;
  tts?: TtsClient;
  stt?: SttClient;
}

export interface SandboxResponse {
  callId: string;
  phase: EngineState["phase"];
  actions: (EngineAction & { audioBase64?: string; audioMime?: string })[];
  transcript: { seq: number; speaker: string; text: string; interrupted: boolean }[];
  silenceTimeoutMs: number;
  brief?: LeadBrief;
  booking?: { startIso: string; label: string; status: string };
}

interface CallGuidance {
  sales?: SalesConfig;
}

async function engineFor(db: Db, agent: VoiceAgentConfig, llm: LlmClient, state?: EngineState, sales?: SalesConfig) {
  const sender = await getSenderProfile(db);
  return new ConversationEngine(
    {
      businessName: sender.businessName,
      persona: agent.persona,
      instructions: agent.instructions,
      disclosureText: agent.disclosureText,
      silenceTimeoutMs: agent.silenceTimeoutMs,
      maxSilenceReprompts: agent.maxSilenceReprompts,
      maxTurns: agent.maxTurns,
      sales,
    },
    llm,
    state,
  );
}

/** Persist new turns and interruption flags; record engine events. */
async function persist(
  tx: Db,
  callId: string,
  before: EngineState | null,
  after: EngineState,
  actions: EngineAction[],
  event: EngineEvent,
  ctx: { sales?: SalesConfig; contactId?: string | null; businessName?: string } = {},
) {
  const known = new Map((before?.turns ?? []).map((t) => [t.seq, t]));
  for (const t of after.turns) {
    const prev = known.get(t.seq);
    if (!prev) {
      await tx.callTranscript.create({ data: { callId, seq: t.seq, speaker: t.speaker, text: t.text, interrupted: !!t.interrupted, startedMs: t.atMs } });
    } else if (!!prev.interrupted !== !!t.interrupted) {
      await tx.callTranscript.update({ where: { callId_seq: { callId, seq: t.seq } }, data: { interrupted: !!t.interrupted } });
    }
  }
  const type =
    event.type === "user_speech_started" && actions.some((a) => a.type === "stop_speaking") ? "barge_in" : event.type;
  await tx.callEvent.create({ data: { callId, type, evidence: "sandbox", data: { actions: actions.map((a) => a.type) } as Prisma.InputJsonValue } });
  const book = actions.find((a) => a.type === "book_meeting") as Extract<EngineAction, { type: "book_meeting" }> | undefined;
  if (book && ctx.sales && ctx.contactId) {
    await bookFromCall(tx, {
      callId,
      contactId: ctx.contactId,
      startIso: book.startIso,
      label: book.label,
      lengthMin: ctx.sales.playbook.meetingLengthMin,
      title: `${ctx.businessName || "Meeting"} × ${ctx.sales.brief.company ?? `${ctx.sales.brief.firstName} ${ctx.sales.brief.lastName ?? ""}`.trim()}`,
      simulated: true, // the sandbox is always a rehearsal
    });
  }
  const end = actions.find((a) => a.type === "end_call") as Extract<EngineAction, { type: "end_call" }> | undefined;
  const outcome = after.sales?.booked
    ? "MEETING_BOOKED"
    : after.optOut
      ? "OPT_OUT_REQUESTED"
      : after.sales?.stage === "closed_no"
        ? "CONNECTED_NOT_INTERESTED"
        : "OTHER";
  await tx.call.update({
    where: { id: callId },
    data: {
      engineState: after as unknown as Prisma.InputJsonValue,
      ...(end || after.phase === "human_takeover"
        ? { status: "COMPLETED", endedAt: new Date(), notes: `sandbox ended: ${end?.reason ?? "human_takeover"}`, outcome }
        : {}),
    },
  });
}

async function withAudio(actions: EngineAction[], tts: TtsClient, agent: VoiceAgentConfig): Promise<SandboxResponse["actions"]> {
  const out: SandboxResponse["actions"] = [];
  for (const a of actions) {
    if (a.type === "speak") {
      const voiceRef = agent.voiceOwnerConsent ? agent.ttsVoiceRef : null; // cloned voice only with owner consent
      const audio = await tts.synthesize(a.text, { voiceRef }).catch(() => null);
      out.push(audio ? { ...a, audioBase64: audio.audio.toString("base64"), audioMime: audio.mime } : a);
    } else out.push(a);
  }
  return out;
}

async function respond(
  db: Db,
  callId: string,
  agent: VoiceAgentConfig,
  actions: SandboxResponse["actions"],
  state: EngineState,
  sales?: SalesConfig,
): Promise<SandboxResponse> {
  const transcript = await db.callTranscript.findMany({ where: { callId }, orderBy: { seq: "asc" } });
  const meeting = state.sales?.booked ? await db.meeting.findFirst({ where: { callId }, orderBy: { createdAt: "desc" } }) : null;
  return {
    callId,
    phase: state.phase,
    actions,
    transcript: transcript.map((t) => ({ seq: t.seq, speaker: t.speaker, text: t.text, interrupted: t.interrupted })),
    silenceTimeoutMs: agent.silenceTimeoutMs,
    brief: sales?.brief,
    booking: meeting
      ? { startIso: meeting.startsAt.toISOString(), label: slotLabel(meeting.startsAt, sales?.timeZone), status: meeting.status }
      : undefined,
  };
}

/** Freeze everything the sales call needs at the start, so every turn uses the same brief and slots. */
async function prepareSales(db: Db, contactId: string, llm: LlmClient): Promise<SalesConfig> {
  const playbook = await getPlaybook(db);
  const missing = playbookReady(playbook);
  if (missing.length) throw new AppError(`Set up your sales playbook first (AI voice → Sales playbook): ${missing.join(", ")}`);
  const avail = await getAvailability(db);
  const t = clockNow();
  const slots = freeSlots(t, avail, await busyMeetings(db, t), 40).map((d) => d.toISOString());
  const brief = await buildLeadBrief(db, contactId, playbook, llm);
  return { brief, playbook, freeSlots: slots, timeZone: avail.timeZone, maxCloseAttempts: 2 };
}

export async function startSandbox(db: Db, p: { voiceAgentId: string; contactId?: string | null }, actor: Actor, deps: SandboxDeps = {}) {
  await getProvider(db, "local_ai_sandbox"); // must be enabled
  const agent = await db.voiceAgentConfig.findUniqueOrThrow({ where: { id: p.voiceAgentId } });
  const err = validateDisclosure(agent.disclosureText);
  if (err) throw new AppError(err);
  const llm = deps.llm ?? getLlm();
  const sales = p.contactId ? await prepareSales(db, p.contactId, llm) : undefined;
  const engine = await engineFor(db, agent, llm, undefined, sales);
  // Close this user's earlier sessions that were left open (tab closed / navigated away).
  const stale = await db.call.findMany({ where: { providerKey: "local_ai_sandbox", status: "IN_PROGRESS", createdById: actor.id }, select: { id: true } });
  for (const s of stale) {
    await db.call.update({ where: { id: s.id }, data: { status: "COMPLETED", endedAt: new Date(), outcome: "OTHER", notes: "sandbox ended: abandoned" } });
    await db.callEvent.create({ data: { callId: s.id, type: "abandoned", evidence: "sandbox" } });
  }
  const call = await db.call.create({
    data: {
      providerKey: "local_ai_sandbox",
      mode: "SIMULATED",
      status: "IN_PROGRESS",
      contactId: p.contactId || null,
      voiceAgentId: agent.id,
      startedAt: new Date(),
      idempotencyKey: `sandbox:${crypto.randomUUID()}`,
      createdById: actor.id,
      guidance: (sales ? { sales } : {}) as unknown as Prisma.InputJsonValue,
    },
  });
  const ev: EngineEvent = { type: "start" };
  const actions = await engine.handle(ev);
  await persist(db, call.id, null, engine.state, actions, ev);
  await audit(db, { actorId: actor.id, action: "voice.sandbox_start", entityType: "call", entityId: call.id, metadata: { agent: agent.name, llm: llm.name, lead: p.contactId ?? null } });
  return respond(db, call.id, agent, await withAudio(actions, deps.tts ?? getTts(), agent), engine.state, sales);
}

export const sandboxEventInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_playback_finished") }),
  z.object({ type: z.literal("user_speech_started") }),
  z.object({ type: z.literal("user_utterance"), text: z.string().max(2000) }),
  z.object({ type: z.literal("silence_timeout") }),
  z.object({ type: z.literal("hangup") }),
  z.object({ type: z.literal("human_takeover") }),
  z.object({ type: z.literal("emergency_hangup") }),
]);

/**
 * Apply one event. A row lock serialises concurrent events for the same call
 * (e.g. barge-in arriving while an utterance is being processed).
 */
export async function sandboxEvent(db: Db, callId: string, raw: unknown, actor: Actor, deps: SandboxDeps = {}) {
  const event = sandboxEventInput.parse(raw);
  const llm = deps.llm ?? getLlm();
  const { agent, actions, state, sales } = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM calls WHERE id = ${callId} FOR UPDATE`;
      const call = await tx.call.findUniqueOrThrow({ where: { id: callId }, include: { voiceAgent: true } });
      if (call.providerKey !== "local_ai_sandbox") throw new AppError("Not a sandbox call");
      if (!call.voiceAgent) throw new AppError("Voice agent missing");
      const before = call.engineState as unknown as EngineState;
      const sales = (call.guidance as CallGuidance | null)?.sales;
      const engine = await engineFor(tx as Db, call.voiceAgent, llm, before, sales);
      const actions = await engine.handle(event as EngineEvent);
      const { businessName } = await getSenderProfile(tx as Db);
      await persist(tx as Db, callId, before, engine.state, actions, event as EngineEvent, { sales, contactId: call.contactId, businessName });
      return { agent: call.voiceAgent, actions, state: engine.state, sales };
    },
    { timeout: 90_000 },
  );
  if (event.type === "emergency_hangup" || event.type === "human_takeover") {
    await audit(db, { actorId: actor.id, action: `voice.${event.type}`, entityType: "call", entityId: callId });
  }
  return respond(db, callId, agent, await withAudio(actions, deps.tts ?? getTts(), agent), state, sales);
}

export async function sandboxAudio(db: Db, callId: string, audio: Buffer, mime: string, actor: Actor, deps: SandboxDeps = {}) {
  const stt = deps.stt ?? getStt();
  const { text } = await stt.transcribe(audio, mime);
  return sandboxEvent(db, callId, { type: "user_utterance", text }, actor, deps);
}

export const voiceAgentInput = z.object({
  name: z.string().trim().min(2).max(80),
  persona: z.string().trim().min(10).max(1000),
  instructions: z.string().trim().min(10).max(4000),
  disclosureText: z.string().trim().min(10).max(300),
  llmModel: z.string().trim().min(1).default("llama3.1:8b"),
  ttsVoiceRef: z.string().trim().max(200).optional().or(z.literal("")),
  voiceOwnerConsent: z.union([z.literal("on"), z.literal("true"), z.literal("")]).optional(),
  silenceTimeoutMs: z.coerce.number().int().min(2000).max(30000).default(6000),
  maxSilenceReprompts: z.coerce.number().int().min(0).max(5).default(2),
  maxTurns: z.coerce.number().int().min(2).max(100).default(30),
});

export async function saveVoiceAgent(db: Db, id: string | null, raw: unknown, actor: Actor) {
  const i = voiceAgentInput.parse(raw);
  const err = validateDisclosure(i.disclosureText);
  if (err) throw new AppError(err);
  const consent = i.voiceOwnerConsent === "on" || i.voiceOwnerConsent === "true";
  if (i.ttsVoiceRef && !consent) throw new AppError("A cloned voice reference requires confirmation that it is your own voice or you hold written permission");
  if (i.ttsVoiceRef && !/^[\w.-]+\.(wav|mp3|flac)$/i.test(i.ttsVoiceRef)) throw new AppError("Voice reference must be a file name in the TTS service's voices/ folder");
  const data = { ...i, ttsVoiceRef: i.ttsVoiceRef || null, voiceOwnerConsent: consent };
  const saved = id ? await db.voiceAgentConfig.update({ where: { id }, data }) : await db.voiceAgentConfig.create({ data });
  await audit(db, { actorId: actor.id, action: id ? "voice.agent_update" : "voice.agent_create", entityType: "voice_agent_config", entityId: saved.id, metadata: { voiceRef: !!data.ttsVoiceRef, consent } });
  return saved;
}
