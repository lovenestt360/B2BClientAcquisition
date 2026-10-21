import type { Prisma, SmsEventType } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError, ComplianceBlockedError } from "../errors";
import { checkEligibility, type Purpose } from "../compliance/eligibility";
import { getSenderProfile, isOptOutText, recordOptOut } from "../compliance/controls";
import { composeSms, findInventedDetails, generateSmsCore, validateSmsBody } from "../ai/drafts";
import { getLlm, type LlmClient } from "../ai/llm";
import { getProvider } from "../providers/registry";
import { recordEstimatedSpend } from "../providers/airtime";
import { smsSegments } from "../ai/drafts";
import type { MessagingProvider } from "../providers/types";
import { assertDeliveryTransition, assertDraftTransition, type Evidence } from "./states";

type Actor = { id: string; role: string };

async function smsEvent(
  db: Db,
  e: { contactId: string; draftId?: string; type: SmsEventType; direction: string; body?: string; evidence: Evidence; providerKey: string; recordedById?: string | null; occurredAt?: Date },
) {
  return db.smsEvent.create({ data: { ...e, recordedById: e.recordedById ?? null } });
}

function primaryMobile(phones: { e164: string; type: string; isPrimary: boolean }[]) {
  return phones.filter((p) => p.type === "MOBILE").sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0]?.e164 ?? null;
}

export interface DraftReport {
  created: string[];
  skipped: { contactId: string; reasons: string[] }[];
}

/** AI drafts for eligible contacts. Nothing is sent: every draft waits for human approval. */
export async function generateSmsDrafts(
  db: Db,
  p: { contactIds: string[]; userId: string; campaignId?: string; purpose?: Exclude<Purpose, "reply" | "transactional">; providerKey?: string },
  llm: LlmClient = getLlm(),
): Promise<DraftReport> {
  const purpose = p.purpose ?? "marketing";
  const providerKey = p.providerKey ?? "iphone_manual_sms";
  const { provider, config } = await getProvider<MessagingProvider>(db, providerKey);
  const sender = await getSenderProfile(db);
  if (!sender.businessName) throw new AppError("Set your business name (sender identity) on the Compliance page before drafting SMS");
  const campaign = p.campaignId ? await db.campaign.findUnique({ where: { id: p.campaignId } }) : null;
  const day = new Date().toISOString().slice(0, 10);

  const report: DraftReport = { created: [], skipped: [] };
  for (const contactId of p.contactIds) {
    const contact = await db.contact.findUnique({ where: { id: contactId }, include: { company: true, phoneNumbers: true } });
    if (!contact) {
      report.skipped.push({ contactId, reasons: ["contact not found"] });
      continue;
    }
    if (config.mode === "SIMULATED" && !contact.isSimulated) {
      report.skipped.push({ contactId, reasons: ["simulated providers may only target seeded dummy leads"] });
      continue;
    }
    const to = primaryMobile(contact.phoneNumbers);
    const recipientError = to ? provider.validateRecipient(to) : "no mobile number on record";
    if (recipientError) {
      report.skipped.push({ contactId, reasons: [recipientError] });
      continue;
    }
    const elig = await checkEligibility(db, { contactId, channel: "SMS", purpose, address: to, campaignId: p.campaignId, ignoreContactWindow: true });
    if (!elig.eligible) {
      report.skipped.push({ contactId, reasons: elig.reasons });
      continue;
    }
    const idempotencyKey = `sms:${providerKey}:${contactId}:${purpose}:${p.campaignId ?? "-"}:${day}`;
    if (await db.messageDraft.findUnique({ where: { idempotencyKey } })) {
      report.skipped.push({ contactId, reasons: ["already drafted today"] });
      continue;
    }
    const { core, generatedBy } = await generateSmsCore(
      llm,
      {
        firstName: contact.firstName,
        title: contact.title,
        company: contact.company?.name,
        industry: contact.company?.industry,
        instructions: campaign?.smsInstructions,
        purpose,
      },
      sender,
    );
    const draft = await db.messageDraft.create({
      data: {
        contactId,
        campaignId: p.campaignId,
        channel: "SMS",
        providerKey,
        toAddress: to!,
        body: composeSms(core, sender),
        generatedBy,
        purpose,
        status: "PENDING_APPROVAL",
        eligibility: elig as unknown as Prisma.InputJsonValue,
        idempotencyKey,
      },
    });
    await smsEvent(db, { contactId, draftId: draft.id, type: "DRAFT_CREATED", direction: "internal", evidence: "system", providerKey, recordedById: p.userId });
    await audit(db, { actorId: p.userId, action: "sms.draft_created", entityType: "message_draft", entityId: draft.id, metadata: { contactId, generatedBy } });
    report.created.push(draft.id);
  }
  return report;
}

/** Human approval, optionally with an edited body. Re-validates content and eligibility. */
export async function approveDraft(db: Db, draftId: string, actor: Actor, editedBody?: string) {
  const draft = await db.messageDraft.findUniqueOrThrow({ where: { id: draftId } });
  assertDraftTransition(draft.status, "APPROVED");
  const body = (editedBody ?? draft.body).trim();
  const sender = await getSenderProfile(db);
  const errors = [...validateSmsBody(body, sender), ...findInventedDetails(body).map((d) => `remove contact detail or link "${d}"`)];
  if (errors.length) throw new AppError(errors.join("; "), "invalid_content");
  const elig = await checkEligibility(db, { contactId: draft.contactId, channel: "SMS", purpose: draft.purpose as Purpose, address: draft.toAddress, campaignId: draft.campaignId, ignoreContactWindow: true });
  if (!elig.eligible) throw new ComplianceBlockedError(elig.reasons);

  const updated = await db.messageDraft.update({
    where: { id: draftId, status: draft.status }, // optimistic concurrency
    data: { status: "APPROVED", body, approvedById: actor.id, approvedAt: new Date(), eligibility: elig as unknown as Prisma.InputJsonValue },
  });
  await smsEvent(db, { contactId: draft.contactId, draftId, type: "APPROVED", direction: "internal", evidence: "system", providerKey: draft.providerKey, recordedById: actor.id });
  await audit(db, { actorId: actor.id, action: "sms.approve", entityType: "message_draft", entityId: draftId, metadata: { edited: body !== draft.body } });
  return updated;
}

export async function rejectDraft(db: Db, draftId: string, actor: Actor, reason?: string) {
  const draft = await db.messageDraft.findUniqueOrThrow({ where: { id: draftId } });
  assertDraftTransition(draft.status, "REJECTED");
  await db.messageDraft.update({ where: { id: draftId }, data: { status: "REJECTED" } });
  await smsEvent(db, { contactId: draft.contactId, draftId, type: "REJECTED", direction: "internal", body: reason, evidence: "system", providerKey: draft.providerKey, recordedById: actor.id });
  await audit(db, { actorId: actor.id, action: "sms.reject", entityType: "message_draft", entityId: draftId, metadata: { reason } });
}

export interface HandOffResult {
  kind: "native_app" | "submitted";
  url?: string;
  copyText?: string;
  /** For simulated leads the real recipient is replaced; explain why to the user. */
  note?: string;
}

/**
 * Hand an approved draft to the provider. For the iPhone this returns an sms: URL for the user
 * to open; nothing is sent until the user presses Send in Messages.
 */
export async function handOffDraft(db: Db, draftId: string, actor: Actor, platform: "ios" | "android" | "other" = "ios"): Promise<HandOffResult> {
  const draft = await db.messageDraft.findUniqueOrThrow({ where: { id: draftId }, include: { contact: true } });
  if (draft.status === "HANDED_OFF") {
    // Idempotent re-open (e.g. user tapped twice): same URL, no duplicate state change.
  } else {
    assertDraftTransition(draft.status, "HANDED_OFF");
  }
  const elig = await checkEligibility(db, { contactId: draft.contactId, channel: "SMS", purpose: draft.purpose as Purpose, address: draft.toAddress, campaignId: draft.campaignId });
  if (!elig.eligible) throw new ComplianceBlockedError(elig.reasons);

  const { provider, config } = await getProvider<MessagingProvider>(db, draft.providerKey);

  if (config.mode === "SIMULATED") {
    if (!draft.contact.isSimulated) throw new AppError("Simulated provider cannot message real contacts");
    const h = await provider.prepareSend({ to: draft.toAddress, body: draft.body });
    assertDeliveryTransition(draft.deliveryState, "ACCEPTED", "system");
    await db.messageDraft.update({ where: { id: draftId }, data: { status: "SENT_CONFIRMED", deliveryState: "ACCEPTED" } });
    await smsEvent(db, { contactId: draft.contactId, draftId, type: "PROVIDER_ACCEPTED", direction: "outbound", body: draft.body, evidence: "system", providerKey: draft.providerKey, recordedById: actor.id });
    // The simulator fabricates a receipt; it is labelled simulated so it is never confused with real evidence.
    assertDeliveryTransition("ACCEPTED", "DELIVERED", "simulated_receipt");
    await db.messageDraft.update({ where: { id: draftId }, data: { deliveryState: "DELIVERED" } });
    await smsEvent(db, { contactId: draft.contactId, draftId, type: "PROVIDER_DELIVERY_REPORT", direction: "internal", body: `SIMULATED receipt ${h.kind === "submitted" ? h.providerMessageId : ""}`, evidence: "simulated_receipt", providerKey: draft.providerKey });
    await audit(db, { actorId: actor.id, action: "sms.simulated_send", entityType: "message_draft", entityId: draftId });
    return { kind: "submitted", note: "Simulated: no real SMS was sent." };
  }

  // Manual iPhone hand-off. Dummy leads never get their (fictional) number used.
  let target: string | null = draft.toAddress;
  let note: string | undefined;
  if (draft.contact.isSimulated) {
    target = config.line?.testNumberE164 ?? null;
    note = target
      ? `Dummy lead: Messages opens addressed to your test number ${target}, not the dummy number.`
      : "Dummy lead: Messages opens with no recipient so nothing can reach a real person. Set a test number on the Providers page to test end to end.";
  }
  const h = target
    ? await provider.prepareSend({ to: target, body: draft.body }, { platform })
    : { kind: "native_app" as const, url: `sms:${platform === "ios" ? "&" : "?"}body=${encodeURIComponent(draft.body)}`, copyText: draft.body };
  if (h.kind !== "native_app") throw new AppError("Unexpected provider response");

  if (draft.status !== "HANDED_OFF") {
    await db.messageDraft.update({ where: { id: draftId, status: draft.status }, data: { status: "HANDED_OFF" } });
    await smsEvent(db, { contactId: draft.contactId, draftId, type: "OPENED_IN_NATIVE_APP", direction: "internal", evidence: "system", providerKey: draft.providerKey, recordedById: actor.id });
    await audit(db, { actorId: actor.id, action: "sms.handoff", entityType: "message_draft", entityId: draftId, metadata: { platform, testRedirect: draft.contact.isSimulated } });
  }
  return { kind: "native_app", url: h.url, copyText: h.copyText, note };
}

export async function recordCopy(db: Db, draftId: string, actor: Actor) {
  const d = await db.messageDraft.findUniqueOrThrow({ where: { id: draftId } });
  await smsEvent(db, { contactId: d.contactId, draftId, type: "COPIED_TO_CLIPBOARD", direction: "internal", evidence: "system", providerKey: d.providerKey, recordedById: actor.id });
}

/**
 * The user reports what happened in Messages.
 *  - sent:     SENT_CONFIRMED, delivery UNKNOWN (no independent evidence exists)
 *  - failed:   SEND_FAILED, delivery FAILED (user saw "Not Delivered")
 *  - not_sent: back to APPROVED
 */
export async function confirmSendOutcome(db: Db, draftId: string, outcome: "sent" | "failed" | "not_sent", actor: Actor) {
  const draft = await db.messageDraft.findUniqueOrThrow({ where: { id: draftId }, include: { contact: true } });
  if (outcome === "sent" && draft.status === "SENT_CONFIRMED") return draft; // idempotent
  const { config } = await getProvider(db, draft.providerKey);
  if (config.mode !== "MANUAL") throw new AppError("Only manual providers take user-confirmed outcomes");

  if (outcome === "not_sent") {
    assertDraftTransition(draft.status, "APPROVED");
    const d = await db.messageDraft.update({ where: { id: draftId }, data: { status: "APPROVED" } });
    await audit(db, { actorId: actor.id, action: "sms.not_sent", entityType: "message_draft", entityId: draftId });
    return d;
  }
  const status = outcome === "sent" ? "SENT_CONFIRMED" : "SEND_FAILED";
  const delivery = outcome === "sent" ? "UNKNOWN" : "FAILED";
  assertDraftTransition(draft.status, status);
  assertDeliveryTransition(draft.deliveryState, delivery, "user_attestation");

  const d = await db.messageDraft.update({ where: { id: draftId, status: draft.status }, data: { status, deliveryState: delivery } });
  await smsEvent(db, {
    contactId: draft.contactId,
    draftId,
    type: outcome === "sent" ? "USER_CONFIRMED_SENT" : "USER_REPORTED_FAILED",
    direction: "outbound",
    body: draft.body,
    evidence: "user_attestation",
    providerKey: draft.providerKey,
    recordedById: actor.id,
  });
  if (outcome === "sent") {
    if (draft.purpose === "consent_request") {
      await db.marketingPermission.create({
        data: { contactId: draft.contactId, channel: "SMS", status: "CONSENT_REQUESTED", evidence: `consent request SMS ${draftId} (user confirmed sent)`, capturedAt: new Date(), recordedById: actor.id },
      });
    }
    if (!draft.contact.isSimulated) {
      await recordEstimatedSpend(db, config.lineId, "sms_estimate", smsSegments(draft.body).segments, { type: "message_draft", id: draftId });
    }
    if (["NEW", "RESEARCHING", "QUALIFIED"].includes(draft.contact.stage)) {
      await db.contact.update({ where: { id: draft.contactId }, data: { stage: "CONTACTED" } });
    }
  }
  await audit(db, { actorId: actor.id, action: `sms.user_confirmed_${outcome}`, entityType: "message_draft", entityId: draftId, metadata: { deliveryState: delivery, evidence: "user_attestation" } });
  return d;
}

/** Replies seen on the iPhone are typed/pasted in by the user until an authorised integration exists. */
export async function recordManualReply(db: Db, input: { contactId: string; body: string; receivedAt?: Date }, actor: Actor) {
  const body = input.body.trim();
  if (!body) throw new AppError("Reply text is required");
  const contact = await db.contact.findUniqueOrThrow({ where: { id: input.contactId }, include: { phoneNumbers: true } });
  const ev = await smsEvent(db, {
    contactId: contact.id,
    type: "INBOUND_REPLY_MANUAL",
    direction: "inbound",
    body,
    evidence: "user_attestation",
    providerKey: "iphone_manual_sms",
    recordedById: actor.id,
    occurredAt: input.receivedAt ?? new Date(),
  });
  let optedOut = false;
  if (isOptOutText(body)) {
    optedOut = true;
    await recordOptOut(db, { contactId: contact.id, channel: "SMS", address: primaryMobile(contact.phoneNumbers), evidence: `SMS reply "${body.slice(0, 40)}" (manual entry ${ev.id})` }, actor.id);
    await smsEvent(db, { contactId: contact.id, type: "OPT_OUT_RECORDED", direction: "internal", evidence: "user_attestation", providerKey: "iphone_manual_sms", recordedById: actor.id });
    // Cancel anything still queued for this contact.
    await db.messageDraft.updateMany({ where: { contactId: contact.id, status: { in: ["PENDING_APPROVAL", "APPROVED"] } }, data: { status: "CANCELLED" } });
  } else if (contact.stage === "CONTACTED") {
    await db.contact.update({ where: { id: contact.id }, data: { stage: "ENGAGED" } });
  }
  await audit(db, { actorId: actor.id, action: "sms.manual_reply", entityType: "contact", entityId: contact.id, metadata: { optedOut } });
  return { event: ev, optedOut };
}
