import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError, ComplianceBlockedError } from "../errors";
import { checkEligibility } from "../compliance/eligibility";
import { getSenderProfile, recordOptOut } from "../compliance/controls";
import { getLlm, type LlmClient } from "../ai/llm";
import { getProvider } from "../providers/registry";
import { recordEstimatedSpend } from "../providers/airtime";
import type { VoiceProvider } from "../providers/types";
import { generateCallGuidance } from "./guidance";
import { assertCallTransition, statusForOutcome } from "./states";

type Actor = { id: string; role: string };

async function callEvent(db: Db, callId: string, type: string, evidence: string, data?: Prisma.InputJsonValue) {
  return db.callEvent.create({ data: { callId, type, evidence, data } });
}

function bestNumber(phones: { e164: string; type: string; isPrimary: boolean }[]) {
  return [...phones].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || Number(b.type === "MOBILE") - Number(a.type === "MOBILE"))[0]?.e164 ?? null;
}

/** Add a contact to the manual call queue with AI talking points. */
export async function queueManualCall(db: Db, p: { contactId: string; campaignId?: string }, actor: Actor, llm: LlmClient = getLlm()) {
  const { provider } = await getProvider<VoiceProvider>(db, "iphone_manual_call");
  const contact = await db.contact.findUniqueOrThrow({ where: { id: p.contactId }, include: { company: true, phoneNumbers: true } });
  const to = bestNumber(contact.phoneNumbers);
  if (!to) throw new AppError("Contact has no phone number");
  const err = provider.validateRecipient(to);
  if (err && !contact.isSimulated) throw new AppError(err);

  const elig = await checkEligibility(db, { contactId: contact.id, channel: "VOICE_MANUAL", address: to, campaignId: p.campaignId, ignoreContactWindow: true });
  if (!elig.eligible) throw new ComplianceBlockedError(elig.reasons);

  const day = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `call:iphone_manual_call:${contact.id}:${p.campaignId ?? "-"}:${day}`;
  const existing = await db.call.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  const campaign = p.campaignId ? await db.campaign.findUnique({ where: { id: p.campaignId } }) : null;
  const sender = await getSenderProfile(db);
  const guidance = await generateCallGuidance(llm, {
    firstName: contact.firstName,
    title: contact.title,
    company: contact.company?.name,
    industry: contact.company?.industry,
    notes: contact.notes,
    instructions: campaign?.callInstructions,
    businessName: sender.businessName,
  });
  const call = await db.call.create({
    data: {
      contactId: contact.id,
      campaignId: p.campaignId,
      providerKey: "iphone_manual_call",
      mode: "MANUAL",
      toE164: to,
      status: "QUEUED",
      guidance: guidance as unknown as Prisma.InputJsonValue,
      idempotencyKey,
      createdById: actor.id,
    },
  });
  await callEvent(db, call.id, "queued", "system", { eligibility: elig as unknown as Prisma.InputJsonValue });
  await audit(db, { actorId: actor.id, action: "call.queue", entityType: "call", entityId: call.id, metadata: { contactId: contact.id } });
  return call;
}

/** Returns the tel: URL to open the iPhone dialer. The platform never hears the call. */
export async function openDialer(db: Db, callId: string, actor: Actor) {
  const call = await db.call.findUniqueOrThrow({ where: { id: callId }, include: { contact: true } });
  if (call.status !== "DIALING") assertCallTransition(call.status, "DIALING");
  if (!call.contactId) throw new AppError("Call has no contact");
  const elig = await checkEligibility(db, { contactId: call.contactId, channel: "VOICE_MANUAL", address: call.toE164, campaignId: call.campaignId });
  if (!elig.eligible) throw new ComplianceBlockedError(elig.reasons);

  const { provider, config } = await getProvider<VoiceProvider>(db, call.providerKey);
  let target = call.toE164;
  let note: string | undefined;
  if (call.contact?.isSimulated) {
    target = config.line?.testNumberE164 ?? null;
    if (!target) throw new AppError("Dummy lead: set a test number on the Providers page to test the dial button. Fictional numbers are never dialled.");
    note = `Dummy lead: dialling your test number ${target}.`;
  }
  const h = await provider.prepareCall(target);
  if (h.kind !== "native_dialer") throw new AppError("Unexpected provider response");
  if (call.status !== "DIALING") {
    await db.call.update({ where: { id: callId, status: call.status }, data: { status: "DIALING", startedAt: new Date() } });
    await callEvent(db, callId, "dial_link_opened", "system", { testRedirect: !!call.contact?.isSimulated });
    await audit(db, { actorId: actor.id, action: "call.dial", entityType: "call", entityId: callId });
  }
  return { url: h.url, note };
}

export const outcomeInput = z.object({
  outcome: z.enum([
    "CONNECTED_INTERESTED",
    "CONNECTED_NOT_INTERESTED",
    "CONNECTED_CALLBACK",
    "MEETING_BOOKED",
    "VOICEMAIL",
    "NO_ANSWER",
    "BUSY",
    "WRONG_NUMBER",
    "OPT_OUT_REQUESTED",
    "OTHER",
    "DID_NOT_CALL",
  ]),
  notes: z.string().max(5000).optional(),
  durationMin: z.coerce.number().min(0).max(600).optional(),
});

/** Outcome as reported by the person who made the call (evidence: user_attestation). */
export async function recordCallOutcome(db: Db, callId: string, raw: unknown, actor: Actor) {
  const input = outcomeInput.parse(raw);
  const call = await db.call.findUniqueOrThrow({ where: { id: callId }, include: { contact: true } });
  if (call.mode !== "MANUAL") throw new AppError("Only manual calls take user-entered outcomes");
  if (input.outcome === "DID_NOT_CALL") {
    assertCallTransition(call.status, "QUEUED");
    await db.call.update({ where: { id: callId }, data: { status: "QUEUED", startedAt: null } });
    await callEvent(db, callId, "not_called", "user_attestation");
    return db.call.findUniqueOrThrow({ where: { id: callId } });
  }
  const status = statusForOutcome(input.outcome);
  assertCallTransition(call.status, status);
  const durationSec = input.durationMin != null ? Math.round(input.durationMin * 60) : null;

  const updated = await db.call.update({
    where: { id: callId, status: call.status },
    data: { status, outcome: input.outcome, notes: input.notes, durationSec, endedAt: new Date() },
  });
  await callEvent(db, callId, "outcome_recorded", "user_attestation", { outcome: input.outcome, durationSec });

  if (call.contactId) {
    if (input.outcome === "OPT_OUT_REQUESTED") {
      await recordOptOut(db, { contactId: call.contactId, channel: "VOICE_MANUAL", address: call.toE164, evidence: `verbal opt-out on call ${callId}` }, actor.id);
      await db.call.updateMany({ where: { contactId: call.contactId, status: "QUEUED" }, data: { status: "CANCELLED" } });
    }
    const stage =
      input.outcome === "MEETING_BOOKED" ? "MEETING_BOOKED" : input.outcome === "CONNECTED_INTERESTED" || input.outcome === "CONNECTED_CALLBACK" ? "ENGAGED" : null;
    if (stage) await db.contact.update({ where: { id: call.contactId }, data: { stage } });
    else if (call.contact && ["NEW", "RESEARCHING", "QUALIFIED"].includes(call.contact.stage) && status === "COMPLETED") {
      await db.contact.update({ where: { id: call.contactId }, data: { stage: "CONTACTED" } });
    }
  }
  if (durationSec && !call.contact?.isSimulated) {
    const { config } = await getProvider(db, call.providerKey);
    const minutes = Math.ceil(durationSec / 60);
    const entry = await recordEstimatedSpend(db, config.lineId, "call_estimate", minutes, { type: "call", id: callId });
    if (entry) await db.call.update({ where: { id: callId }, data: { costCents: -entry.amountCents } });
  }
  await audit(db, { actorId: actor.id, action: "call.outcome", entityType: "call", entityId: callId, metadata: { outcome: input.outcome, evidence: "user_attestation" } });
  return updated;
}
