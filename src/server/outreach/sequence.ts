import { Prisma, type OutreachSend, type OutreachStep } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError } from "../errors";
import { now as clockNow } from "../clock";
import { getLlm, type LlmClient } from "../ai/llm";
import { listUnsubscribeHeader, newMessageId, UNSUBSCRIBE_LINE } from "../email/compose";
import { DryRunTransport, SmtpTransport, transportFor, wasDefinitelyNotSent, type MailTransport } from "../email/transport";
import { getCampaignConfigs, getLaunch, getOutreachSettings, resolveMode, type CampaignConfig, type OutreachSettings, type SendMode } from "./config";
import { evaluateGates, RESEARCH_CODES, type MemberWithLead } from "./gates";
import { buildGenerationInput, generateOutreachEmail, generationOutputSchema, type GenerationInput, type GenerationOutput, type PriorMessage } from "./generate";
import { validateOutreachEmail, type ValidationResult } from "./validate";
import { batchSlot, dayBounds, followUpDue, hourBounds, nextBatchAtOrAfter } from "./schedule";
import { holdMember, recheckStops } from "./stops";
import { assertMemberTransition, assertSendTransition, CONFIRMED, IN_FLIGHT, type SendStatus } from "./states";

type Actor = { id: string; role: string };
const json = (v: unknown) => v as Prisma.InputJsonValue;
const LOCK_KEY = 80_221_022; // pg advisory lock: one cap reservation at a time across workers

export const stepLabel = (n: number) => `S${String(n).padStart(2, "0")}`;

/** Durable idempotency key: one row per prospect + campaign + step (dry runs are namespaced). */
export function sendKey(contactId: string, campaignKey: string, step: number, dryRun: boolean) {
  return `${dryRun ? "dry:" : ""}${contactId}:${campaignKey}:${stepLabel(step)}`;
}

export interface Outcome {
  memberId: string;
  contactId: string;
  campaign: string;
  step: number | null;
  result: "SENT" | "DRY_RUN_SENT" | "GENERATED" | "AWAITING_APPROVAL" | "HELD" | "RESEARCH_REQUIRED" | "NOT_DUE" | "DEFERRED" | "STOPPED" | "COMPLETED" | "SKIPPED" | "FAILED" | "UNKNOWN";
  codes: string[];
  sendId?: string;
  dueAt?: string | null;
}

interface Ctx {
  db: Db;
  mode: SendMode;
  now: Date;
  slot: Date | null;
  settings: OutreachSettings;
  configs: CampaignConfig[];
  llm: LlmClient;
  transport?: MailTransport;
  send: boolean;
  actorId: string | null;
}

// ───── Sequence position (always derived from send records) ─────

async function position(db: Db, memberId: string, dryRun: boolean) {
  const sends = await db.outreachSend.findMany({ where: { memberId, dryRun }, orderBy: { step: "asc" } });
  const confirmed = sends.filter((s) => CONFIRMED.includes(s.status as SendStatus));
  const last = confirmed.at(-1) ?? null;
  return { sends, confirmed, last, lastStep: last?.step ?? 0, inFlight: sends.filter((s) => IN_FLIGHT.includes(s.status as SendStatus)) };
}

function priorMessages(confirmed: OutreachSend[]): PriorMessage[] {
  return confirmed.map((s) => {
    const g = s.generation as { output?: { chosenCommercialExposure?: string } } | null;
    return { step: s.step, subject: s.subject ?? "", body: s.body ?? "", exposure: g?.output?.chosenCommercialExposure ?? null };
  });
}

/** When step `step` becomes due, or a code explaining why it can't be computed. */
function dueAt(member: MemberWithLead, step: number, steps: OutreachStep[], last: OutreachSend | null, s: OutreachSettings): { at: Date | null; code?: string } {
  if (step === 1) return { at: member.approvedAt };
  const row = steps.find((x) => x.step === step);
  if (!row) return { at: null, code: "STEP_NOT_CONFIGURED" };
  if (!row.approved || row.waitDays == null) return { at: null, code: "STEP_WAIT_DAYS_UNAPPROVED" };
  if (!last?.confirmedAt) return { at: null, code: "PREVIOUS_STEP_UNCONFIRMED" };
  const at = followUpDue(last.confirmedAt, row.waitDays, s);
  return at ? { at } : { at: null, code: "NO_BATCH_SCHEDULE" };
}

// ───── Generation ─────

async function generateFor(ctx: Ctx, m: MemberWithLead, step: number, totalSteps: number, prior: PriorMessage[]) {
  const input = await buildGenerationInput(ctx.db, {
    contactId: m.contactId,
    campaign: { key: m.campaign.key!, name: m.campaign.name, icpDescription: m.campaign.icpDescription },
    step,
    totalSteps,
    prior,
    settings: ctx.settings,
  });
  const gen = await generateOutreachEmail(ctx.llm, input, ctx.settings.exposures);
  const validation = validateOutreachEmail(gen.output, input, ctx.settings, ctx.settings.exposures);
  return { input, ...gen, validation };
}

function statusFor(v: ValidationResult): SendStatus {
  return v.decision === "APPROVE" ? "AWAITING_APPROVAL" : v.decision === "HOLD" ? "HELD" : "RESEARCH_REQUIRED";
}

function generationJson(input: GenerationInput, output: GenerationOutput, generatedBy: string, modelError?: string) {
  return json({ input, output, generatedBy, modelError: modelError ?? null });
}

// ───── Batch ─────

export interface BatchReport {
  mode: SendMode;
  blockers: string[];
  launch: string;
  slot: string | null;
  nextBatchAt: string | null;
  outcomes: Outcome[];
}

/**
 * One scheduler tick. Safe to invoke repeatedly: positions come from send records, every step
 * has one idempotent row, and sending goes through an atomic reservation. With `send: false`
 * (or outside a batch window) it only prepares drafts for human approval.
 */
export async function runOutreachBatch(
  db: Db,
  opts: { now?: Date; llm?: LlmClient; transport?: MailTransport; send?: boolean; actorId?: string | null; forceDryRun?: boolean; campaignKeys?: string[] } = {},
): Promise<BatchReport> {
  const now = opts.now ?? clockNow();
  const settings = await getOutreachSettings(db);
  const configs = await getCampaignConfigs(db);
  const resolved = await resolveMode(db);
  const mode: SendMode = opts.forceDryRun ? "dry_run" : resolved.mode;
  const blockers = opts.forceDryRun ? ["forced dry run", ...resolved.blockers] : resolved.blockers;
  const slot = batchSlot(now, settings);
  const ctx: Ctx = { db, mode, now, slot, settings, configs, llm: opts.llm ?? getLlm(), transport: opts.transport, send: opts.send ?? true, actorId: opts.actorId ?? null };

  const keys = (opts.campaignKeys ?? configs.map((c) => c.key)).filter((k) => configs.some((c) => c.key === k));
  const members = (await db.campaignMember.findMany({
    where: { campaign: { key: { in: keys } }, state: { in: ["ACTIVE", "PENDING_APPROVAL", "HOLD", "RESEARCH_REQUIRED"] } },
    include: { contact: { include: { company: true } }, campaign: true },
    orderBy: [{ approvedAt: "asc" }, { addedAt: "asc" }, { id: "asc" }],
  })) as MemberWithLead[];
  const stepsByCampaign = new Map<string, OutreachStep[]>();
  for (const k of keys) {
    const c = members.find((m) => m.campaign.key === k)?.campaign ?? (await db.campaign.findUnique({ where: { key: k } }));
    if (c) stepsByCampaign.set(k, await db.outreachStep.findMany({ where: { campaignId: c.id }, orderBy: { step: "asc" } }));
  }

  const outcomes: Outcome[] = [];
  for (const m of members) {
    try {
      outcomes.push(await processMember(ctx, m, stepsByCampaign.get(m.campaign.key!) ?? []));
    } catch (e) {
      outcomes.push({ memberId: m.id, contactId: m.contactId, campaign: m.campaign.key!, step: null, result: "FAILED", codes: [`ERROR: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`] });
    }
  }

  const report: BatchReport = {
    mode,
    blockers,
    launch: (await getLaunch(db)).command,
    slot: slot?.toISOString() ?? null,
    nextBatchAt: nextBatchAtOrAfter(now, settings, true)?.toISOString() ?? null,
    outcomes,
  };
  const tally = outcomes.reduce<Record<string, number>>((a, o) => ((a[o.result] = (a[o.result] ?? 0) + 1), a), {});
  await audit(db, { actorId: ctx.actorId, actorType: ctx.actorId ? "user" : "job", action: "outreach.batch", entityType: "system", metadata: json({ mode, slot: report.slot, tally, blockers }) });
  return report;
}

async function processMember(ctx: Ctx, m: MemberWithLead, steps: OutreachStep[]): Promise<Outcome> {
  const { db, settings } = ctx;
  const dry = ctx.mode === "dry_run";
  const base = { memberId: m.id, contactId: m.contactId, campaign: m.campaign.key! };
  const cfg = ctx.configs.find((c) => c.key === m.campaign.key);

  const state = await recheckStops(db, m.id);
  if (state === "STOPPED") return { ...base, step: null, result: "STOPPED", codes: [(await db.campaignMember.findUniqueOrThrow({ where: { id: m.id } })).stopReason ?? "STOPPED"] };
  if (state !== "ACTIVE") return { ...base, step: null, result: state === "RESEARCH_REQUIRED" ? "RESEARCH_REQUIRED" : state === "HOLD" ? "HELD" : "SKIPPED", codes: [m.holdReason ?? state] };
  const member = (await db.campaignMember.findUniqueOrThrow({ where: { id: m.id }, include: { contact: { include: { company: true } }, campaign: true } })) as MemberWithLead;

  const pos = await position(db, m.id, dry);
  if (pos.inFlight.length) {
    // An attempt whose outcome is unknown: never guess, never send the next step.
    if (!dry) await holdMember(db, m.id, "UNCONFIRMED_PRIOR_SEND", `step ${pos.inFlight[0].step} outcome unknown; reconcile from the Sent folder or provider logs`);
    return { ...base, step: pos.inFlight[0].step, result: "HELD", codes: ["UNCONFIRMED_PRIOR_SEND"], sendId: pos.inFlight[0].id };
  }
  const step = pos.lastStep + 1;
  const total = cfg?.steps.length ?? steps.length;
  if (step > total) {
    if (!dry && member.state === "ACTIVE") {
      assertMemberTransition(member.state, "COMPLETED");
      await db.campaignMember.update({ where: { id: m.id }, data: { state: "COMPLETED", nextDueAt: null } });
    }
    return { ...base, step: null, result: "COMPLETED", codes: [] };
  }

  const due = dueAt(member, step, steps, pos.last, settings);
  if (!due.at) return { ...base, step, result: "HELD", codes: [due.code ?? "NOT_DUE"] };
  if (!dry && member.nextDueAt?.getTime() !== due.at.getTime()) await db.campaignMember.update({ where: { id: m.id }, data: { nextDueAt: due.at } });
  if (due.at.getTime() > ctx.now.getTime() + settings.prepareLookaheadHours * 3_600_000) {
    return { ...base, step, result: "NOT_DUE", codes: ["NOT_DUE"], dueAt: due.at.toISOString() };
  }

  const gates = await evaluateGates(db, member, cfg, settings, ctx.now);
  if (gates.durable.length) {
    const research = gates.durable.every((c) => RESEARCH_CODES.has(c));
    await holdMember(db, m.id, gates.durable.join(","), gates.details.join("; "), research ? "RESEARCH_REQUIRED" : "HOLD");
    return { ...base, step, result: research ? "RESEARCH_REQUIRED" : "HELD", codes: gates.durable };
  }

  // One idempotent row per prospect + campaign + step.
  const key = sendKey(m.contactId, m.campaign.key!, step, dry);
  let row = await db.outreachSend.findUnique({ where: { idempotencyKey: key } });
  if (!row) {
    const g = await generateFor(ctx, member, step, total, priorMessages(pos.confirmed));
    try {
      row = await db.outreachSend.create({
        data: {
          idempotencyKey: key,
          campaignId: m.campaignId,
          memberId: m.id,
          contactId: m.contactId,
          step,
          dryRun: dry,
          status: statusFor(g.validation),
          reasonCodes: json(g.validation.reasons),
          subject: g.output.subject,
          body: g.output.body,
          generation: generationJson(g.input, g.output, g.generatedBy, g.modelError),
          validation: json(g.validation),
          generatedBy: g.generatedBy,
        },
      });
      await audit(db, { actorType: "job", action: "outreach.generate", entityType: "outreach_send", entityId: row.id, metadata: json({ key, decision: g.validation.decision, reasons: g.validation.reasons, generatedBy: g.generatedBy }) });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      row = await db.outreachSend.findUniqueOrThrow({ where: { idempotencyKey: key } }); // a concurrent tick created it
    }
    const r = row.status === "AWAITING_APPROVAL" ? "GENERATED" : row.status === "HELD" ? "HELD" : "RESEARCH_REQUIRED";
    return { ...base, step, result: r, codes: (row.reasonCodes as string[]) ?? [], sendId: row.id, dueAt: due.at.toISOString() };
  }

  if (CONFIRMED.includes(row.status as SendStatus)) return { ...base, step, result: "SKIPPED", codes: ["ALREADY_SENT"], sendId: row.id };
  if (row.status !== "APPROVED") {
    const r = row.status === "HELD" ? "HELD" : row.status === "RESEARCH_REQUIRED" ? "RESEARCH_REQUIRED" : "AWAITING_APPROVAL";
    return { ...base, step, result: r, codes: [row.status], sendId: row.id };
  }
  if (!ctx.send) return { ...base, step, result: "DEFERRED", codes: ["PREPARE_ONLY"], sendId: row.id };
  if (!ctx.slot) return { ...base, step, result: "DEFERRED", codes: ["OUTSIDE_BATCH_WINDOW"], sendId: row.id };
  if (due.at.getTime() > ctx.now.getTime()) return { ...base, step, result: "NOT_DUE", codes: ["NOT_DUE"], sendId: row.id, dueAt: due.at.toISOString() };
  if (gates.codes.length) return { ...base, step, result: "DEFERRED", codes: gates.codes, sendId: row.id };

  const res = await sendOutreach(db, row.id, { mode: ctx.mode, slot: ctx.slot, now: ctx.now, settings, transport: ctx.transport, steps, actorId: ctx.actorId });
  return { ...base, step, result: res.result, codes: res.codes, sendId: row.id };
}

// ───── Sending ─────

export function composeOutreachBody(core: string, s: Pick<OutreachSettings, "signature">) {
  return `${core.trim().replace(/\n{3,}/g, "\n\n")}\n\n${s.signature}\n\n${UNSUBSCRIBE_LINE}`;
}

/**
 * Send one approved step. Reserves the hourly/daily cap atomically, records the attempt before
 * the network call, and never resends an attempt whose outcome is unknown. SMTP acceptance is
 * PROVIDER_ACCEPTED, nothing more. In a dry run no connection is ever opened.
 */
export async function sendOutreach(
  db: Db,
  sendId: string,
  o: { mode: SendMode; slot: Date; now: Date; settings: OutreachSettings; transport?: MailTransport; steps: OutreachStep[]; actorId: string | null },
): Promise<{ result: Outcome["result"]; codes: string[] }> {
  const s = o.settings;
  const dry = o.mode === "dry_run";
  const account = s.emailAccountId ? await db.emailAccount.findUnique({ where: { id: s.emailAccountId } }) : null;
  if (!dry && !account) return { result: "DEFERRED", codes: ["MAILBOX_NOT_READY"] };
  const fromAddress = account?.fromAddress ?? "dry-run@outreach.invalid";

  // 1. Atomic reservation (caps, one step per recipient per batch, still approved).
  const reserved = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    const row = await tx.outreachSend.findUniqueOrThrow({ where: { id: sendId } });
    if (row.status !== "APPROVED") return { ok: false as const, code: `NOT_APPROVED:${row.status}` };
    if (row.dryRun !== dry) return { ok: false as const, code: "MODE_MISMATCH" };
    const [hs, he] = hourBounds(o.slot);
    const [ds, de] = dayBounds(o.now, s.timezone);
    const counted = (from: Date, to: Date): Prisma.OutreachSendWhereInput => ({
      dryRun: dry,
      OR: [
        { status: { in: CONFIRMED }, confirmedAt: { gte: from, lt: to } },
        { status: { in: IN_FLIGHT }, batchAt: { gte: from, lt: to } }, // unknown outcomes count, conservatively
      ],
    });
    if ((await tx.outreachSend.count({ where: counted(hs, he) })) >= s.hourlyCap) return { ok: false as const, code: "CAP_HOURLY" };
    if ((await tx.outreachSend.count({ where: counted(ds, de) })) >= s.dailyCap) return { ok: false as const, code: "CAP_DAILY" };
    if (await tx.outreachSend.count({ where: { memberId: row.memberId, dryRun: dry, batchAt: o.slot, id: { not: row.id } } })) return { ok: false as const, code: "ONE_STEP_PER_BATCH" };
    const messageId = row.providerMessageId ?? newMessageId(fromAddress);
    assertSendTransition(row.status, "SENDING");
    await tx.outreachSend.update({ where: { id: row.id, status: "APPROVED" }, data: { status: "SENDING", batchAt: o.slot, attempts: { increment: 1 }, providerMessageId: messageId } });
    return { ok: true as const, row, messageId };
  });
  if (!reserved.ok) return { result: "DEFERRED", codes: [reserved.code] };
  const row = reserved.row;

  // 2. Last-moment rechecks: stops, and (live) every launch condition.
  const revert = async (code: string) => {
    await db.outreachSend.update({ where: { id: row.id }, data: { status: "APPROVED", batchAt: null } });
    return { result: "DEFERRED" as const, codes: [code] };
  };
  if ((await recheckStops(db, row.memberId)) !== "ACTIVE") {
    await db.outreachSend.update({ where: { id: row.id }, data: { status: "HELD", batchAt: null, reasonCodes: json(["STOP_DETECTED_BEFORE_SEND"]) } });
    return { result: "HELD", codes: ["STOP_DETECTED_BEFORE_SEND"] };
  }
  if (!dry) {
    const live = await resolveMode(db);
    if (live.mode !== "live") return revert("LIVE_BLOCKED");
  }

  const contact = await db.contact.findUniqueOrThrow({ where: { id: row.contactId } });
  if (!contact.email) return revert("EMAIL_MISSING");
  const prior = (await db.outreachSend.findMany({ where: { memberId: row.memberId, dryRun: dry, step: { lt: row.step }, status: { in: CONFIRMED } }, orderBy: { step: "asc" } }))
    .map((p) => p.providerMessageId)
    .filter(Boolean) as string[];
  const text = composeOutreachBody(row.body ?? "", s);
  const transport = o.transport ?? (dry ? new DryRunTransport() : transportFor(account!));
  if (dry && transport instanceof SmtpTransport) throw new AppError("A dry run may never use a real SMTP transport");

  // 3. Record the attempt before the network call (crash-safe). Live only: the inbox thread.
  const outbound = !dry
    ? await db.emailMessage.create({
        data: { accountId: account!.id, contactId: contact.id, direction: "outbound", messageId: reserved.messageId, inReplyTo: prior.at(-1) ?? null, references: prior.join(" ") || null, fromAddress, toAddress: contact.email, subject: row.subject ?? "", bodyText: text, deliveryState: "ATTEMPTED", occurredAt: o.now },
      })
    : null;

  try {
    const res = await transport.send({
      fromName: s.senderName,
      fromAddress,
      to: contact.email,
      subject: row.subject ?? "",
      text,
      messageId: reserved.messageId,
      inReplyTo: prior.at(-1),
      references: prior,
      headers: { "List-Unsubscribe": listUnsubscribeHeader(fromAddress) },
    });
    const accepted = res.accepted.map((a) => a.toLowerCase()).includes(contact.email.toLowerCase());
    const status: SendStatus = accepted ? (dry ? "DRY_RUN" : "PROVIDER_ACCEPTED") : "FAILED";
    await db.outreachSend.update({ where: { id: row.id }, data: { status, confirmedAt: accepted ? o.now : null, smtpResponse: res.response?.slice(0, 500), reasonCodes: json(accepted ? [] : ["SMTP_REJECTED"]) } });
    if (outbound) await db.emailMessage.update({ where: { id: outbound.id }, data: { deliveryState: accepted ? "ACCEPTED" : "FAILED", deliveryEvidence: accepted ? "smtp_250" : "smtp_reject", smtpResponse: res.response?.slice(0, 500) } });
    if (accepted && !dry) await advanceMember(db, row, o.now, o.steps, s);
    await audit(db, { actorId: o.actorId, actorType: o.actorId ? "user" : "job", action: accepted ? (dry ? "outreach.dry_run_send" : "outreach.sent_accepted") : "outreach.rejected", entityType: "outreach_send", entityId: row.id, metadata: { step: row.step, messageId: reserved.messageId, response: res.response?.slice(0, 200) } });
    return { result: accepted ? (dry ? "DRY_RUN_SENT" : "SENT") : "FAILED", codes: accepted ? [] : ["SMTP_REJECTED"] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (wasDefinitelyNotSent(e)) {
      const rejectedRcpt = (e as { command?: string }).command === "RCPT TO" || (e as { code?: string }).code === "EENVELOPE";
      if (rejectedRcpt) {
        await db.outreachSend.update({ where: { id: row.id }, data: { status: "FAILED", smtpResponse: message.slice(0, 500), reasonCodes: json(["RECIPIENT_REJECTED"]) } });
        if (outbound) await db.emailMessage.update({ where: { id: outbound.id }, data: { deliveryState: "FAILED", deliveryEvidence: "smtp_reject", smtpResponse: message.slice(0, 500) } });
      } else {
        // Nothing left our side: release the reservation so a later batch can retry the same row.
        if (outbound) await db.emailMessage.delete({ where: { id: outbound.id } });
        await db.outreachSend.update({ where: { id: row.id }, data: { status: "APPROVED", batchAt: null, smtpResponse: message.slice(0, 500) } });
      }
      await audit(db, { actorType: "job", action: "outreach.send_error", entityType: "outreach_send", entityId: row.id, metadata: { message: message.slice(0, 200), retryable: !rejectedRcpt } });
      return { result: rejectedRcpt ? "FAILED" : "DEFERRED", codes: [rejectedRcpt ? "RECIPIENT_REJECTED" : "SMTP_NOT_SENT_RETRY"] };
    }
    // The server may or may not have taken it: do not guess, do not resend.
    await db.outreachSend.update({ where: { id: row.id }, data: { status: "UNKNOWN", smtpResponse: message.slice(0, 500), reasonCodes: json(["SMTP_OUTCOME_UNKNOWN"]) } });
    if (outbound) await db.emailMessage.update({ where: { id: outbound.id }, data: { deliveryState: "UNKNOWN", smtpResponse: message.slice(0, 500) } });
    if (!dry) await holdMember(db, row.memberId, "UNCONFIRMED_PRIOR_SEND", `step ${row.step}: ${message.slice(0, 120)}`);
    await audit(db, { actorType: "job", action: "outreach.send_unknown", entityType: "outreach_send", entityId: row.id, metadata: { message: message.slice(0, 200) } });
    return { result: "UNKNOWN", codes: ["SMTP_OUTCOME_UNKNOWN"] };
  }
}

/** After a provider-confirmed live send: sequence position, next due, contact stage. */
async function advanceMember(db: Db, row: OutreachSend, confirmedAt: Date, steps: OutreachStep[], s: OutreachSettings) {
  const m = await db.campaignMember.findUniqueOrThrow({ where: { id: row.memberId } });
  const next = steps.find((x) => x.step === row.step + 1);
  const nextDueAt = next?.approved && next.waitDays != null ? followUpDue(confirmedAt, next.waitDays, s) : null;
  const done = !next;
  await db.campaignMember.update({
    where: { id: m.id },
    data: { lastStep: Math.max(m.lastStep, row.step), lastConfirmedSendAt: confirmedAt, nextDueAt, ...(done && m.state === "ACTIVE" ? { state: "COMPLETED" } : {}) },
  });
  await db.contact.updateMany({ where: { id: row.contactId, stage: { in: ["NEW", "RESEARCHING", "QUALIFIED"] } }, data: { stage: "CONTACTED" } });
}

// ───── Human actions ─────

/** Add contacts to a campaign. They wait for final human approval before anything is drafted. */
export async function enrollContacts(db: Db, campaignKey: string, contactIds: string[], actorId: string) {
  const campaign = await db.campaign.findUnique({ where: { key: campaignKey } });
  if (!campaign) throw new AppError(`Unknown campaign ${campaignKey}`);
  let added = 0;
  for (const contactId of contactIds) {
    const exists = await db.campaignMember.findUnique({ where: { campaignId_contactId: { campaignId: campaign.id, contactId } } });
    if (exists) continue;
    await db.campaignMember.create({ data: { campaignId: campaign.id, contactId } });
    added++;
  }
  await audit(db, { actorId, action: "outreach.enroll", entityType: "campaign", entityId: campaign.id, metadata: { count: contactIds.length } });
  return { added };
}

/** Final SA approval of a lead (also releases a reviewed hold). Gates still run before every send. */
export async function approveMember(db: Db, memberId: string, actor: Actor) {
  const m = await db.campaignMember.findUniqueOrThrow({ where: { id: memberId } });
  assertMemberTransition(m.state, "ACTIVE");
  await db.campaignMember.update({ where: { id: memberId }, data: { state: "ACTIVE", approvedAt: m.approvedAt ?? clockNow(), approvedById: actor.id, holdReason: null } });
  await audit(db, { actorId: actor.id, action: "outreach.approve_lead", entityType: "campaign_member", entityId: memberId, metadata: { from: m.state, holdReason: m.holdReason } });
}

export async function setMemberHold(db: Db, memberId: string, actor: Actor, reason: string) {
  await holdMember(db, memberId, "MANUAL", reason || "held by a person", "HOLD", actor.id);
}

/** Approve one generated email (optionally edited). Edited text is validated again. */
export async function approveOutreachSend(db: Db, sendId: string, actor: Actor, edit?: { subject?: string; body?: string }) {
  const row = await db.outreachSend.findUniqueOrThrow({ where: { id: sendId }, include: { member: true } });
  if (row.member.state !== "ACTIVE") throw new AppError(`Recipient is ${row.member.state}; approve the lead first`, "invalid_state", 409);
  const g = row.generation as { input: GenerationInput; output: GenerationOutput } | null;
  if (!g) throw new AppError("Nothing to approve");
  const output = generationOutputSchema.parse({ ...g.output, subject: (edit?.subject ?? row.subject ?? "").trim(), body: (edit?.body ?? row.body ?? "").trim(), decision: "APPROVE", riskFlags: [] });
  const settings = await getOutreachSettings(db);
  const v = validateOutreachEmail(output, g.input, settings, settings.exposures);
  if (v.decision !== "APPROVE") throw new AppError(`Not approvable: ${v.reasons.join("; ")}`, "invalid_content");
  if (row.status !== "AWAITING_APPROVAL") {
    assertSendTransition(row.status, "AWAITING_APPROVAL");
  }
  assertSendTransition("AWAITING_APPROVAL", "APPROVED");
  const edited = output.subject !== row.subject || output.body !== row.body;
  await db.outreachSend.update({
    where: { id: sendId, status: row.status },
    data: { status: "APPROVED", subject: output.subject, body: output.body, approvedById: actor.id, approvedAt: clockNow(), validation: json(v), reasonCodes: json([]), generation: json({ ...g, output }) },
  });
  await audit(db, { actorId: actor.id, action: "outreach.approve_email", entityType: "outreach_send", entityId: sendId, metadata: { step: row.step, edited, dryRun: row.dryRun } });
}

export async function rejectOutreachSend(db: Db, sendId: string, actor: Actor, reason?: string) {
  const row = await db.outreachSend.findUniqueOrThrow({ where: { id: sendId } });
  assertSendTransition(row.status, "REJECTED");
  await db.outreachSend.update({ where: { id: sendId, status: row.status }, data: { status: "REJECTED", reasonCodes: json([`REJECTED: ${reason || "by reviewer"}`]) } });
  await audit(db, { actorId: actor.id, action: "outreach.reject_email", entityType: "outreach_send", entityId: sendId, metadata: { reason } });
}

/** Write the step again from fresh evidence (after more research or a rejection). */
export async function regenerateOutreachSend(db: Db, sendId: string, actor: Actor, llm: LlmClient = getLlm()) {
  const row = await db.outreachSend.findUniqueOrThrow({ where: { id: sendId }, include: { member: { include: { contact: { include: { company: true } }, campaign: true } } } });
  if (!["AWAITING_APPROVAL", "HELD", "RESEARCH_REQUIRED", "REJECTED"].includes(row.status)) throw new AppError(`Cannot regenerate a ${row.status} email`, "invalid_state", 409);
  const settings = await getOutreachSettings(db);
  const configs = await getCampaignConfigs(db);
  const pos = await position(db, row.memberId, row.dryRun);
  const ctx: Ctx = { db, mode: row.dryRun ? "dry_run" : "live", now: clockNow(), slot: null, settings, configs, llm, send: false, actorId: actor.id };
  const total = configs.find((c) => c.key === row.member.campaign.key)?.steps.length ?? 5;
  const g = await generateFor(ctx, row.member as MemberWithLead, row.step, total, priorMessages(pos.confirmed.filter((c) => c.step < row.step)));
  const status = statusFor(g.validation);
  if (row.status !== "AWAITING_APPROVAL" || status !== "AWAITING_APPROVAL") assertSendTransition(row.status, status);
  await db.outreachSend.update({
    where: { id: sendId, status: row.status },
    data: { status, subject: g.output.subject, body: g.output.body, generation: generationJson(g.input, g.output, g.generatedBy, g.modelError), validation: json(g.validation), reasonCodes: json(g.validation.reasons), generatedBy: g.generatedBy, approvedAt: null, approvedById: null },
  });
  await audit(db, { actorId: actor.id, action: "outreach.regenerate", entityType: "outreach_send", entityId: sendId, metadata: { decision: g.validation.decision } });
  return status;
}

/** Resolve an UNKNOWN attempt from independent evidence (Sent folder, provider log, bounce). */
export async function reconcileUnknownSend(db: Db, sendId: string, outcome: "accepted" | "failed", evidence: string, actor: Actor) {
  if (!evidence.trim()) throw new AppError("Describe the evidence (e.g. message found in the Sent folder at 10:02)");
  const row = await db.outreachSend.findUniqueOrThrow({ where: { id: sendId } });
  const to: SendStatus = outcome === "accepted" ? "PROVIDER_ACCEPTED" : "FAILED";
  assertSendTransition(row.status, to);
  const confirmedAt = outcome === "accepted" ? (row.batchAt ?? row.updatedAt) : null;
  await db.outreachSend.update({ where: { id: sendId }, data: { status: to, confirmedAt, reasonCodes: json([`RECONCILED: ${evidence.slice(0, 200)}`]) } });
  if (to === "PROVIDER_ACCEPTED" && !row.dryRun) {
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id: row.campaignId } });
    const steps = await db.outreachStep.findMany({ where: { campaignId: campaign.id } });
    await advanceMember(db, row, confirmedAt!, steps, await getOutreachSettings(db));
  }
  await audit(db, { actorId: actor.id, action: "outreach.reconcile", entityType: "outreach_send", entityId: sendId, metadata: { outcome, evidence: evidence.slice(0, 200) } });
}
