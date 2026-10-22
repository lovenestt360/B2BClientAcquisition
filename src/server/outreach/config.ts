import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "../audit";
import { AppError } from "../errors";
import { now as clockNow } from "../clock";
import { automationBlockers } from "../providers/gate";
import { toRuntime } from "../providers/registry";

/** Provider row that carries the automation authorisation for scheduled sequence email. */
export const SEQUENCE_PROVIDER_KEY = "email_sequences";

const exposureSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  campaigns: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  consequence: z.string().min(1),
  stake: z.string().min(1),
  prevention: z.string().min(1),
  capability: z.string().min(1),
  subjectTopic: z.string().min(1).max(60),
});
export type Exposure = z.infer<typeof exposureSchema>;

export const outreachSettingsSchema = z.object({
  senderName: z.string().trim().default(""),
  signature: z.string().trim().default(""),
  businessName: z.string().trim().default(""),
  brandLine: z.string().trim().default(""),
  emailAccountId: z.string().nullable().default(null),
  bookingUrl: z.string().trim().url().startsWith("https://").nullable().default(null),
  approvedLinkDomains: z.array(z.string().trim().toLowerCase()).default([]),
  timezone: z.string().default("Africa/Maputo"),
  sendDays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  batchHours: z.array(z.number().int().min(0).max(23)).default([]),
  batchWindowMinutes: z.number().int().min(5).max(59).default(50),
  skipPublicHolidaysOf: z.string().nullable().default("ZA"),
  hourlyCap: z.number().int().min(0).max(500).default(0),
  dailyCap: z.number().int().min(0).max(5000).default(0),
  acceptedVerificationStatuses: z.array(z.string()).default(["Valid"]),
  minFactConfidence: z.number().min(0).max(1).default(0.7),
  meetingMinutes: z.number().int().min(5).max(60).default(15),
  wordRange: z
    .object({ min: z.number().int(), max: z.number().int(), hardMin: z.number().int(), hardMax: z.number().int() })
    .default({ min: 55, max: 90, hardMin: 40, hardMax: 130 }),
  prepareLookaheadHours: z.number().int().min(0).max(168).default(24),
  capabilities: z.array(z.object({ id: z.string(), text: z.string() })).default([]),
  bannedClaims: z.array(z.string()).default([]),
  exposures: z.array(exposureSchema).default([]),
});
export type OutreachSettings = z.infer<typeof outreachSettingsSchema>;

const campaignConfigSchema = z.object({
  key: z.string().regex(/^[A-Z0-9-]{2,20}$/),
  name: z.string().min(1),
  country: z.string().length(2),
  icpDescription: z.string().default(""),
  roleKeywords: z.array(z.string().toLowerCase()).min(1),
  steps: z
    .array(z.object({ step: z.number().int().min(1).max(10), waitDays: z.number().int().min(1).max(90).nullable().optional() }))
    .min(1),
});
export type CampaignConfig = z.infer<typeof campaignConfigSchema>;

export const outreachConfigSchema = z.object({
  settings: outreachSettingsSchema,
  campaigns: z.array(campaignConfigSchema).min(1),
});
export type OutreachConfig = z.infer<typeof outreachConfigSchema>;

export const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "config", "klyron-sa-outreach.json");
export const REFERENCE_EXAMPLES_PATH = path.join(process.cwd(), "config", "klyron-sa-reference-examples.md");

export function loadConfigFile(file = DEFAULT_CONFIG_PATH): OutreachConfig {
  return outreachConfigSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function loadReferenceExamples(file = REFERENCE_EXAMPLES_PATH): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const SETTINGS_KEY = "outreach.settings";
const CAMPAIGNS_KEY = "outreach.campaigns";
const LAUNCH_KEY = "outreach.launch";

export async function getOutreachSettings(db: Db): Promise<OutreachSettings> {
  const s = await db.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
  return outreachSettingsSchema.parse(s?.value ?? {});
}

export async function getCampaignConfigs(db: Db): Promise<CampaignConfig[]> {
  const s = await db.systemSetting.findUnique({ where: { key: CAMPAIGNS_KEY } });
  return z.array(campaignConfigSchema).parse(s?.value ?? []);
}

/**
 * Load the config into the database. Creates missing campaigns (as DRAFT) and steps; never
 * changes a step a human already approved, never touches members, sends or suppressions.
 * Settings an admin edited on /outreach (mailbox, booking URL) are kept.
 */
export async function syncOutreachConfig(db: Db, cfg: OutreachConfig, actorId: string | null) {
  const current = await db.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
  const prev = current ? outreachSettingsSchema.parse(current.value) : null;
  const settings: OutreachSettings = {
    ...cfg.settings,
    emailAccountId: prev?.emailAccountId ?? cfg.settings.emailAccountId,
    bookingUrl: prev?.bookingUrl ?? cfg.settings.bookingUrl,
  };
  await db.systemSetting.upsert({ where: { key: SETTINGS_KEY }, update: { value: settings, updatedBy: actorId }, create: { key: SETTINGS_KEY, value: settings, updatedBy: actorId } });
  await db.systemSetting.upsert({ where: { key: CAMPAIGNS_KEY }, update: { value: cfg.campaigns, updatedBy: actorId }, create: { key: CAMPAIGNS_KEY, value: cfg.campaigns, updatedBy: actorId } });
  for (const c of cfg.campaigns) {
    const campaign = await db.campaign.upsert({
      where: { key: c.key },
      update: { name: c.name, country: c.country, icpDescription: c.icpDescription },
      create: { key: c.key, name: c.name, country: c.country, icpDescription: c.icpDescription, requireApproval: true },
    });
    for (const s of c.steps) {
      const existing = await db.outreachStep.findUnique({ where: { campaignId_step: { campaignId: campaign.id, step: s.step } } });
      if (!existing) {
        await db.outreachStep.create({ data: { campaignId: campaign.id, step: s.step, waitDays: s.step === 1 ? null : (s.waitDays ?? null), approved: s.step === 1 } });
      } else if (!existing.approved && s.step > 1 && s.waitDays != null) {
        await db.outreachStep.update({ where: { id: existing.id }, data: { waitDays: s.waitDays } });
      }
    }
  }
  await getLaunch(db); // materialise the default (STOP)
  await audit(db, { actorId, action: "outreach.config_sync", entityType: "system", metadata: { campaigns: cfg.campaigns.map((c) => c.key) } });
  return settings;
}

export const editableSettingsInput = z.object({
  emailAccountId: z.string().trim().optional().transform((v) => v || null),
  bookingUrl: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v === null || /^https:\/\/[^\s]+$/.test(v), "booking URL must start with https://"),
  approvedLinkDomains: z.string().optional(),
  hourlyCap: z.coerce.number().int().min(0).max(500),
  dailyCap: z.coerce.number().int().min(0).max(5000),
});

/** The fields an admin may change on /outreach. */
export async function saveOutreachSettings(db: Db, raw: Record<string, unknown>, actorId: string) {
  const input = editableSettingsInput.parse(raw);
  const s = await getOutreachSettings(db);
  const domains = (input.approvedLinkDomains ?? s.approvedLinkDomains.join("\n"))
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  if (input.bookingUrl) {
    const host = new URL(input.bookingUrl).hostname.toLowerCase();
    if (!domains.some((d) => host === d || host.endsWith(`.${d}`))) domains.push(host); // the booking host is approved by saving it
  }
  if (input.emailAccountId) {
    const a = await db.emailAccount.findUnique({ where: { id: input.emailAccountId } });
    if (!a) throw new AppError("Unknown mailbox");
  }
  const next = outreachSettingsSchema.parse({ ...s, ...input, approvedLinkDomains: [...new Set(domains)] });
  await db.systemSetting.update({ where: { key: SETTINGS_KEY }, data: { value: next, updatedBy: actorId } });
  await audit(db, { actorId, action: "outreach.settings", entityType: "system", metadata: { from: pick(s), to: pick(next) } });
  return next;
}
const pick = (s: OutreachSettings) => ({ emailAccountId: s.emailAccountId, bookingUrl: s.bookingUrl, approvedLinkDomains: s.approvedLinkDomains, hourlyCap: s.hourlyCap, dailyCap: s.dailyCap });

/** Approve the wait before a follow-up step. Until approved, that step is held. */
export async function approveStepTiming(db: Db, stepId: string, waitDays: number, actorId: string) {
  const days = z.coerce.number().int().min(1).max(90).parse(waitDays);
  const s = await db.outreachStep.findUniqueOrThrow({ where: { id: stepId } });
  if (s.step === 1) throw new AppError("The first step has no wait");
  await db.outreachStep.update({ where: { id: stepId }, data: { waitDays: days, approved: true } });
  await audit(db, { actorId, action: "outreach.step_timing", entityType: "outreach_step", entityId: stepId, metadata: { step: s.step, from: s.waitDays, to: days } });
}

// ───── Launch command ─────

export type LaunchCommand = "STOP" | "START";
export interface LaunchState {
  command: LaunchCommand;
  changedBy: string | null;
  changedAt: string | null;
  note?: string;
}
const launchSchema = z.object({ command: z.enum(["STOP", "START"]), changedBy: z.string().nullable(), changedAt: z.string().nullable(), note: z.string().optional() });

export async function getLaunch(db: Db): Promise<LaunchState> {
  const s = await db.systemSetting.findUnique({ where: { key: LAUNCH_KEY } });
  if (!s) {
    const v: LaunchState = { command: "STOP", changedBy: null, changedAt: null };
    await db.systemSetting.create({ data: { key: LAUNCH_KEY, value: { ...v } } }).catch(() => undefined);
    return v;
  }
  const parsed = launchSchema.safeParse(s.value);
  return parsed.success ? parsed.data : { command: "STOP", changedBy: null, changedAt: null }; // unreadable = Stop
}

export const LAUNCH_CONFIRMATION = "START LIVE OUTREACH";

/** Only an admin, typing the confirmation phrase, can set Start. Stop is always allowed. */
export async function setLaunch(db: Db, command: LaunchCommand, actor: { id: string; role: string }, confirmation?: string, note?: string) {
  if (command === "START") {
    if (actor.role !== "ADMIN") throw new AppError("Only an admin can start live outreach", "forbidden", 403);
    if (confirmation !== LAUNCH_CONFIRMATION) throw new AppError(`Type "${LAUNCH_CONFIRMATION}" to confirm`, "confirmation_required");
  }
  const prev = await getLaunch(db);
  const v: LaunchState = { command, changedBy: actor.id, changedAt: clockNow().toISOString(), note };
  await db.systemSetting.upsert({ where: { key: LAUNCH_KEY }, update: { value: { ...v }, updatedBy: actor.id }, create: { key: LAUNCH_KEY, value: { ...v }, updatedBy: actor.id } });
  await audit(db, { actorId: actor.id, action: "outreach.launch", entityType: "system", metadata: { from: prev.command, to: command, note } });
  return v;
}

// ───── Send mode ─────

export type SendMode = "dry_run" | "live";

/**
 * Everything that must hold before a real email leaves. Any blocker means the batch runs as a
 * dry run: full pipeline, no network connection to a mail server.
 */
export async function liveBlockers(db: Db): Promise<string[]> {
  const out: string[] = [];
  const launch = await getLaunch(db);
  if (launch.command !== "START") out.push("Launch Command is Stop");
  if (process.env.OUTREACH_LIVE_SEND !== "true") out.push("OUTREACH_LIVE_SEND is not true in the environment");
  if (env().SIMULATION_MODE) out.push("SIMULATION_MODE is on");
  const provider = await db.providerConfig.findUnique({ where: { key: SEQUENCE_PROVIDER_KEY } });
  if (!provider) out.push(`provider ${SEQUENCE_PROVIDER_KEY} is not configured`);
  else out.push(...automationBlockers(toRuntime(provider)));
  const s = await getOutreachSettings(db);
  if (!s.emailAccountId) out.push("no sending mailbox selected");
  else {
    const a = await db.emailAccount.findUnique({ where: { id: s.emailAccountId } });
    if (!a) out.push("selected mailbox no longer exists");
    else {
      if (a.isSimulated) out.push("selected mailbox is simulated");
      if (!a.enabled) out.push("selected mailbox is disabled");
      if (a.lastTestResult !== "ok") out.push("selected mailbox has not passed a connection test");
    }
  }
  if (!s.signature || !s.businessName) out.push("sender signature/business name not set");
  if (!s.batchHours.length || !s.hourlyCap || !s.dailyCap) out.push("schedule or caps not configured");
  return out;
}

export async function resolveMode(db: Db): Promise<{ mode: SendMode; blockers: string[] }> {
  const blockers = await liveBlockers(db);
  return { mode: blockers.length ? "dry_run" : "live", blockers };
}
