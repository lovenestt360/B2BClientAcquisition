"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/server/auth/current";
import { enqueue } from "@/server/jobs";
import { sha256 } from "@/server/crypto";
import { AppError } from "@/server/errors";
import { saveEmailAccount, setEmailAccountEnabled, testEmailAccount } from "@/server/email/accounts";
import { generateEmailDrafts } from "@/server/email/drafts";
import { approveEmailDraft, rejectEmailDraft } from "@/server/email/send";
import { syncAccount } from "@/server/email/sync";
import { simulateReply, type SimulatedReply } from "@/server/email/simulate";
import { setHandled } from "@/server/inbox";
import { safe, type ActionResult } from "./util";

const fd = (form: FormData) => Object.fromEntries(form) as Record<string, string>;

// ───── Mailboxes (admin) ─────

export async function saveAccountAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("providers.manage");
  const id = String(form.get("id") || "") || null;
  const res = await safe(() => saveEmailAccount(prisma, id, fd(form), user.id));
  if (res.ok && !id) redirect(`/email/accounts?saved=${(res.data as { id: string }).id}`);
  revalidatePath("/email/accounts");
  return res.ok ? { ok: true, message: "Saved" } : res;
}

export async function testAccountAction(form: FormData) {
  const user = await requirePermission("providers.manage");
  await testEmailAccount(prisma, String(form.get("id")), user.id);
  revalidatePath("/email/accounts");
}

export async function toggleAccountAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("providers.manage");
  const res = await safe(() => setEmailAccountEnabled(prisma, String(form.get("id")), form.get("enabled") === "true", user.id), "Saved");
  revalidatePath("/email/accounts");
  revalidatePath("/email");
  return res;
}

export async function syncNowAction(form: FormData) {
  await requirePermission("outreach.execute");
  await syncAccount(prisma, String(form.get("id"))).catch(() => undefined); // error is stored on the account
  revalidatePath("/email");
  revalidatePath("/inbox");
}

// ───── Drafts & sending ─────

export async function generateEmailDraftsAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.draft");
  const contactIds = form.getAll("contactId").map(String).filter(Boolean);
  if (!contactIds.length) return { ok: false, error: "Select at least one contact" };
  const accountId = String(form.get("accountId") ?? "");
  const purpose = form.get("purpose") === "consent_request" ? "consent_request" : "marketing";
  const res = await safe(() => generateEmailDrafts(prisma, { contactIds, accountId, userId: user.id, purpose }));
  revalidatePath("/email");
  if (!res.ok) return res;
  const r = res.data!;
  const reasons = [...new Set(r.skipped.flatMap((s) => s.reasons))].slice(0, 3).join("; ");
  return { ok: true, message: `${r.created.length} draft(s) created, ${r.skipped.length} skipped${reasons ? `: ${reasons}` : ""}` };
}

export async function approveEmailAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.approve");
  const res = await safe(
    () => approveEmailDraft(prisma, String(form.get("draftId")), user, { subject: String(form.get("subject") ?? ""), body: String(form.get("body") ?? "") }),
    "Approved",
  );
  revalidatePath("/email");
  return res;
}

export async function rejectEmailAction(form: FormData) {
  const user = await requirePermission("outreach.approve");
  await rejectEmailDraft(prisma, String(form.get("draftId")), user);
  revalidatePath("/email");
}

/** A person clicks Send for each email; the job sends it once (idempotency key per draft). */
export async function sendEmailAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.execute");
  const draftId = String(form.get("draftId"));
  const res = await safe(async () => {
    const key = `email.send:${draftId}:${sha256((await prisma.messageDraft.findUniqueOrThrow({ where: { id: draftId } })).updatedAt.toISOString()).slice(0, 8)}`;
    const job = await enqueue(prisma, "email.send", { draftId, userId: user.id, role: user.role }, key);
    if (job.status === "failed") throw new AppError(job.lastError ?? "Sending failed");
    return job.status;
  });
  revalidatePath("/email");
  revalidatePath("/today");
  if (!res.ok) return res;
  return { ok: true, message: res.data === "succeeded" ? "Sent: accepted by your mail server" : "Queued for sending" };
}

export async function simulateReplyAction(form: FormData) {
  await requirePermission("outreach.execute");
  await simulateReply(prisma, String(form.get("messageId")), String(form.get("kind")) as SimulatedReply);
  revalidatePath("/email");
  revalidatePath("/inbox");
}

// ───── Inbox ─────

export async function setHandledAction(form: FormData) {
  const user = await requirePermission("outreach.execute");
  await setHandled(prisma, form.get("kind") === "sms" ? "sms" : "email", String(form.get("id")), form.get("handled") === "true", user.id);
  revalidatePath("/inbox");
}
