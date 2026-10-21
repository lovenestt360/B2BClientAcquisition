"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/current";
import { enqueue } from "@/server/jobs";
import { approveDraft, confirmSendOutcome, handOffDraft, recordCopy, recordManualReply, rejectDraft } from "@/server/messaging/sms";
import { openDialer, queueManualCall, recordCallOutcome } from "@/server/voice/calls";
import { addSuppression, recordPermission, setEmergencyStop, setSenderProfile } from "@/server/compliance/controls";
import { updateProvider } from "@/server/providers/registry";
import { recordAirtime } from "@/server/providers/airtime";
import { saveVoiceAgent } from "@/server/voice/sandbox";
import { sha256 } from "@/server/crypto";
import { parsePhone } from "@/server/phone";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { safe, type ActionResult } from "./util";

const fd = (form: FormData) => Object.fromEntries(form) as Record<string, string>;

// ───── SMS ─────

export async function generateDraftsAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.draft");
  const contactIds = form.getAll("contactId").map(String).filter(Boolean);
  if (!contactIds.length) return { ok: false, error: "Select at least one contact" };
  const purpose = form.get("purpose") === "consent_request" ? "consent_request" : "marketing";
  const providerKey = String(form.get("providerKey") || "iphone_manual_sms");
  const res = await safe(async () => {
    const key = `drafts:${sha256([...contactIds].sort().join(",") + purpose + providerKey + new Date().toISOString().slice(0, 10))}`;
    const job = await enqueue(prisma, "sms.generate_drafts", { contactIds, userId: user.id, purpose, providerKey }, key);
    if (job.status === "failed") throw new AppError(job.lastError ?? "Draft generation failed");
    return job.result as { created: string[]; skipped: { contactId: string; reasons: string[] }[] } | null;
  });
  revalidatePath("/sms");
  if (!res.ok) return res;
  const r = res.data;
  return { ok: true, message: r ? `${r.created.length} draft(s) created, ${r.skipped.length} skipped${r.skipped.length ? `: ${[...new Set(r.skipped.flatMap((s) => s.reasons))].slice(0, 3).join("; ")}` : ""}` : "Drafting queued" };
}

export async function approveDraftAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.approve");
  const res = await safe(() => approveDraft(prisma, String(form.get("draftId")), user, String(form.get("body") ?? "") || undefined), "Approved");
  revalidatePath("/sms");
  return res;
}

export async function rejectDraftAction(form: FormData) {
  const user = await requirePermission("outreach.approve");
  await rejectDraft(prisma, String(form.get("draftId")), user, String(form.get("reason") ?? ""));
  revalidatePath("/sms");
}

export async function handOffAction(draftId: string, platform: "ios" | "android" | "other") {
  const user = await requirePermission("outreach.execute");
  const res = await safe(() => handOffDraft(prisma, draftId, user, platform));
  revalidatePath("/sms");
  return res;
}

export async function copyDraftAction(draftId: string) {
  const user = await requirePermission("outreach.execute");
  await recordCopy(prisma, draftId, user);
}

export async function confirmOutcomeAction(draftId: string, outcome: "sent" | "failed" | "not_sent") {
  const user = await requirePermission("outreach.execute");
  const res = await safe(() => confirmSendOutcome(prisma, draftId, outcome, user));
  revalidatePath("/sms");
  return res;
}

export async function manualReplyAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.execute");
  const contactId = String(form.get("contactId"));
  const receivedAt = form.get("receivedAt") ? new Date(String(form.get("receivedAt"))) : undefined;
  const res = await safe(async () => {
    const r = await recordManualReply(prisma, { contactId, body: String(form.get("body") ?? ""), receivedAt }, user);
    return r.optedOut;
  });
  revalidatePath(`/sms/${contactId}`);
  if (!res.ok) return res;
  return { ok: true, message: res.data ? "Opt-out recorded: number suppressed and pending drafts cancelled" : "Reply recorded" };
}

// ───── Calls ─────

export async function queueCallAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.draft");
  const res = await safe(() => queueManualCall(prisma, { contactId: String(form.get("contactId")) }, user), "Added to call queue");
  revalidatePath("/calls");
  return res;
}

export async function dialAction(callId: string) {
  const user = await requirePermission("outreach.execute");
  const res = await safe(() => openDialer(prisma, callId, user));
  revalidatePath("/calls");
  return res;
}

export async function callOutcomeAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.execute");
  const res = await safe(() => recordCallOutcome(prisma, String(form.get("callId")), fd(form), user), "Outcome saved");
  revalidatePath("/calls");
  return res;
}

// ───── Compliance ─────

export async function emergencyStopAction(form: FormData) {
  const user = await requirePermission("emergency_stop");
  await setEmergencyStop(prisma, form.get("halt") === "true", user, String(form.get("reason") ?? "") || undefined);
  revalidatePath("/", "layout");
}

export async function permissionAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("compliance.manage");
  const res = await safe(() => recordPermission(prisma, fd(form), user.id), "Recorded");
  revalidatePath(`/contacts/${form.get("contactId")}`);
  return res;
}

export async function suppressionAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("compliance.manage");
  const res = await safe(() => addSuppression(prisma, fd(form), user.id), "Suppressed");
  revalidatePath("/compliance");
  return res;
}

export async function senderProfileAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("compliance.manage");
  const res = await safe(() => setSenderProfile(prisma, fd(form), user.id), "Saved");
  revalidatePath("/compliance");
  return res;
}

// ───── Providers ─────

export async function providerAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("providers.manage");
  const res = await safe(() => updateProvider(prisma, String(form.get("key")), fd(form), user.id), "Saved");
  revalidatePath("/providers");
  return res;
}

export async function lineAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("providers.manage");
  const res = await safe(async () => {
    const f = fd(form);
    const phone = (v: string) => {
      if (!v) return null;
      const p = parsePhone(v, "ZA");
      if (!p.valid) throw new AppError(`Invalid number ${v}`);
      return p.e164!;
    };
    const cents = (v: string) => (v ? Math.round(Number(v) * 100) : null);
    const data = {
      ownNumberE164: phone(f.ownNumberE164 ?? ""),
      testNumberE164: phone(f.testNumberE164 ?? ""),
      smsRateCents: cents(f.smsRate ?? ""),
      callRatePerMinCents: cents(f.callRate ?? ""),
    };
    await prisma.carrierLine.update({ where: { id: f.lineId }, data });
    await audit(prisma, { actorId: user.id, action: "carrier_line.update", entityType: "carrier_line", entityId: f.lineId, metadata: data });
  }, "Saved");
  revalidatePath("/providers");
  return res;
}

export async function airtimeAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.execute");
  const res = await safe(() => recordAirtime(prisma, fd(form), user.id), "Recorded");
  revalidatePath("/providers");
  return res;
}

// ───── Voice agents ─────

export async function voiceAgentAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("providers.manage");
  const id = String(form.get("id") || "") || null;
  const res = await safe(() => saveVoiceAgent(prisma, id, fd(form), user), "Saved");
  revalidatePath("/voice");
  return res;
}
