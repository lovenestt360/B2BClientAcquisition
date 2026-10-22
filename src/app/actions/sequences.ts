"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, requireRole } from "@/server/auth/current";
import { approveStepTiming, loadConfigFile, saveOutreachSettings, setLaunch, syncOutreachConfig } from "@/server/outreach/config";
import {
  approveMember,
  approveOutreachSend,
  enrollContacts,
  reconcileUnknownSend,
  regenerateOutreachSend,
  rejectOutreachSend,
  runOutreachBatch,
  setMemberHold,
} from "@/server/outreach/sequence";
import { runStopWatch } from "@/server/outreach/stops";
import { safe, type ActionResult } from "./util";

const done = () => revalidatePath("/outreach");
const str = (form: FormData, k: string) => String(form.get(k) ?? "");

export async function syncConfigAction(_p: ActionResult | undefined, _form: FormData): Promise<ActionResult> {
  const user = await requireRole("ADMIN");
  const res = await safe(() => syncOutreachConfig(prisma, loadConfigFile(), user.id), "Config loaded. Campaigns start as Draft; wait days stay unapproved.");
  done();
  return res;
}

export async function saveSequenceSettingsAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requireRole("ADMIN");
  const res = await safe(() => saveOutreachSettings(prisma, Object.fromEntries(form), user.id), "Settings saved");
  done();
  return res;
}

export async function setCampaignStatusAction(form: FormData) {
  const user = await requirePermission("outreach.approve");
  const status = str(form, "status") === "ACTIVE" ? "ACTIVE" : "PAUSED";
  await prisma.campaign.update({ where: { id: str(form, "id") }, data: { status } });
  const { audit } = await import("@/server/audit");
  await audit(prisma, { actorId: user.id, action: "campaign.status", entityType: "campaign", entityId: str(form, "id"), metadata: { status } });
  done();
}

export async function approveStepAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.approve");
  const res = await safe(() => approveStepTiming(prisma, str(form, "id"), Number(form.get("waitDays")), user.id), "Wait approved");
  done();
  return res;
}

export async function launchAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requireRole("ADMIN");
  const command = str(form, "command") === "START" ? "START" : "STOP";
  const res = await safe(() => setLaunch(prisma, command, user, str(form, "confirmation"), str(form, "note") || undefined), command === "START" ? "Launch Command set to Start" : "Launch Command set to Stop");
  done();
  return res;
}

export async function enrollAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.draft");
  const ids = form.getAll("contactId").map(String).filter(Boolean);
  if (!ids.length) return { ok: false, error: "Select at least one contact" };
  const res = await safe(async () => {
    const r = await enrollContacts(prisma, str(form, "campaign"), ids, user.id);
    return r;
  }, "Added. Each lead still needs final approval.");
  done();
  return res;
}

export async function approveLeadAction(form: FormData) {
  const user = await requirePermission("outreach.approve");
  await approveMember(prisma, str(form, "id"), user);
  done();
}

export async function holdLeadAction(form: FormData) {
  const user = await requirePermission("outreach.approve");
  await setMemberHold(prisma, str(form, "id"), user, str(form, "reason"));
  done();
}

export async function approveSendAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.approve");
  const res = await safe(() => approveOutreachSend(prisma, str(form, "id"), user, { subject: str(form, "subject"), body: str(form, "body") }), "Approved for the next batch");
  done();
  return res;
}

export async function rejectSendAction(form: FormData) {
  const user = await requirePermission("outreach.approve");
  await rejectOutreachSend(prisma, str(form, "id"), user, str(form, "reason"));
  done();
}

export async function regenerateSendAction(form: FormData) {
  const user = await requirePermission("outreach.draft");
  await regenerateOutreachSend(prisma, str(form, "id"), user);
  done();
}

export async function reconcileAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.approve");
  const res = await safe(() => reconcileUnknownSend(prisma, str(form, "id"), str(form, "outcome") === "accepted" ? "accepted" : "failed", str(form, "evidence"), user), "Reconciled");
  done();
  return res;
}

/** Runs one tick now. Prepares drafts; sends only in a batch window, and only live if every launch condition holds. */
export async function runBatchAction(_p: ActionResult | undefined, form: FormData): Promise<ActionResult> {
  const user = await requirePermission("outreach.approve");
  const res = await safe(async () => {
    await runStopWatch(prisma);
    const r = await runOutreachBatch(prisma, { actorId: user.id, forceDryRun: form.get("dryRun") === "on" });
    const tally = r.outcomes.reduce<Record<string, number>>((a, o) => ((a[o.result] = (a[o.result] ?? 0) + 1), a), {});
    return { mode: r.mode, tally };
  });
  done();
  if (!res.ok) return res;
  const d = res.data as { mode: string; tally: Record<string, number> };
  return { ok: true, message: `${d.mode === "live" ? "LIVE" : "Dry run"}: ${Object.entries(d.tally).map(([k, v]) => `${v} ${k.toLowerCase().replace(/_/g, " ")}`).join(", ") || "nothing to do"}` };
}
