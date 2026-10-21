import { z } from "zod";
import type { Channel, Prisma } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError } from "../errors";
import { normalizeDomain, normalizeEmail } from "../normalize";
import { parsePhone } from "../phone";

const HALT_KEY = "outreach.emergency_stop";
const SENDER_KEY = "sender.profile";

// ───── Emergency stop ─────

export interface HaltState {
  halted: boolean;
  reason?: string;
  by?: string;
  at?: string;
}

export async function getHalt(db: Db): Promise<HaltState> {
  const s = await db.systemSetting.findUnique({ where: { key: HALT_KEY } });
  return (s?.value as unknown as HaltState) ?? { halted: false };
}

/** Returns a blocking reason when global or campaign-level outreach is stopped. */
export async function isOutreachHalted(db: Db, campaignId?: string | null): Promise<string | null> {
  const h = await getHalt(db);
  if (h.halted) return `global emergency stop active${h.reason ? `: ${h.reason}` : ""}`;
  if (campaignId) {
    const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true, emergencyStopped: true } });
    if (c?.emergencyStopped) return "campaign emergency-stopped";
    if (c && c.status !== "ACTIVE") return `campaign is ${c.status.toLowerCase()}`;
  }
  return null;
}

export async function setEmergencyStop(db: Db, halted: boolean, actor: { id: string; role: string }, reason?: string) {
  if (!halted && actor.role !== "ADMIN" && actor.role !== "MANAGER") {
    throw new AppError("Only a manager or admin can resume outreach", "forbidden", 403);
  }
  const value: HaltState = halted ? { halted, reason, by: actor.id, at: new Date().toISOString() } : { halted: false };
  await db.systemSetting.upsert({
    where: { key: HALT_KEY },
    update: { value: value as unknown as Prisma.InputJsonValue, updatedBy: actor.id },
    create: { key: HALT_KEY, value: value as unknown as Prisma.InputJsonValue, updatedBy: actor.id },
  });
  if (halted) {
    // Cancel everything that has not yet been handed to a device or provider.
    await db.messageDraft.updateMany({
      where: { status: { in: ["PENDING_APPROVAL", "APPROVED"] } },
      data: { status: "CANCELLED" },
    });
    await db.call.updateMany({ where: { status: "QUEUED" }, data: { status: "CANCELLED" } });
  }
  await audit(db, { actorId: actor.id, action: halted ? "outreach.emergency_stop" : "outreach.resume", entityType: "system", metadata: { reason } });
}

// ───── Suppression ─────

export async function findSuppression(
  db: Db,
  q: { email?: string | null; e164?: string | null; domain?: string | null; channel: Channel },
) {
  const or: Prisma.SuppressionWhereInput[] = [];
  if (q.email) or.push({ email: q.email.toLowerCase() });
  if (q.e164) or.push({ e164: q.e164 });
  if (q.domain) or.push({ domain: q.domain.toLowerCase() });
  if (!or.length) return null;
  return db.suppression.findFirst({ where: { AND: [{ OR: or }, { OR: [{ channel: null }, { channel: q.channel }] }] } });
}

export const suppressionInput = z.object({
  value: z.string().trim().min(3),
  channel: z.enum(["EMAIL", "SMS", "VOICE_MANUAL", "VOICE_AUTOMATED", "LINKEDIN", ""]).optional(),
  reason: z.string().trim().min(1).default("manual"),
});

export async function addSuppression(db: Db, raw: unknown, actorId: string | null, source = "manual") {
  const input = suppressionInput.parse(raw);
  const v = input.value;
  const data: Prisma.SuppressionCreateInput = { reason: input.reason, source, channel: (input.channel || null) as Channel | null };
  if (v.includes("@")) {
    const email = normalizeEmail(v);
    if (!email) throw new AppError("Invalid email");
    data.email = email;
  } else if (/^[+\d\s()-]+$/.test(v)) {
    const p = parsePhone(v);
    if (!p.valid) throw new AppError("Invalid phone number");
    data.e164 = p.e164;
  } else {
    const d = normalizeDomain(v);
    if (!d) throw new AppError("Enter an email, phone number or domain");
    data.domain = d;
  }
  const s = await db.suppression.create({ data });
  await audit(db, { actorId, action: "suppression.add", entityType: "suppression", entityId: s.id, metadata: { ...data } as Prisma.InputJsonValue });
  return s;
}

// ───── Consent / permissions ─────

export const permissionInput = z.object({
  contactId: z.string().min(1),
  channel: z.enum(["EMAIL", "SMS", "VOICE_MANUAL", "VOICE_AUTOMATED", "LINKEDIN"]),
  status: z.enum(["GRANTED", "WITHDRAWN", "REFUSED", "CONSENT_REQUESTED"]),
  basis: z.enum(["CONSENT", "EXISTING_CUSTOMER", "LEGITIMATE_INTEREST", ""]).optional(),
  evidence: z.string().trim().min(5, "Describe how and where consent was captured"),
  capturedAt: z.coerce.date().optional(),
});

export async function recordPermission(db: Db, raw: unknown, actorId: string | null) {
  const input = permissionInput.parse(raw);
  if (input.status === "GRANTED" && !input.basis) throw new AppError("A lawful basis is required when granting");
  const p = await db.marketingPermission.create({
    data: {
      contactId: input.contactId,
      channel: input.channel,
      status: input.status,
      basis: input.basis || null,
      evidence: input.evidence,
      capturedAt: input.capturedAt ?? new Date(),
      recordedById: actorId,
    },
  });
  await audit(db, {
    actorId,
    action: `consent.${input.status.toLowerCase()}`,
    entityType: "contact",
    entityId: input.contactId,
    metadata: { channel: input.channel, basis: input.basis, evidence: input.evidence },
  });
  return p;
}

/** Opt-out: withdraw consent on the channel AND suppress the address on every marketing channel. */
export async function recordOptOut(
  db: Db,
  input: { contactId: string; channel: Channel; address: string | null; evidence: string },
  actorId: string | null,
) {
  await recordPermission(db, { contactId: input.contactId, channel: input.channel, status: "WITHDRAWN", evidence: input.evidence }, actorId);
  if (input.address) {
    const isEmail = input.address.includes("@");
    const existing = await db.suppression.findFirst({ where: isEmail ? { email: input.address } : { e164: input.address } });
    if (!existing) {
      await db.suppression.create({
        data: { ...(isEmail ? { email: input.address } : { e164: input.address }), reason: "opt_out", source: input.evidence, channel: null },
      });
    }
  }
  await audit(db, { actorId, action: "consent.opt_out", entityType: "contact", entityId: input.contactId, metadata: { channel: input.channel } });
}

/** Opt-out keywords for SMS replies (EN + Afrikaans + isiZulu basics). */
const OPT_OUT_RE = /^\s*(stop|stopp|unsubscribe|opt[\s-]?out|remove me|cancel|end|quit|moenie|hou op|yeka)\b/i;
export function isOptOutText(text: string): boolean {
  return OPT_OUT_RE.test(text);
}

// ───── Sender identity (POPIA s69(4)) ─────

export interface SenderProfile {
  businessName: string;
  optOutText: string;
}

const DEFAULT_SENDER: SenderProfile = { businessName: "", optOutText: "Reply STOP to opt out" };

export async function getSenderProfile(db: Db): Promise<SenderProfile> {
  const s = await db.systemSetting.findUnique({ where: { key: SENDER_KEY } });
  return { ...DEFAULT_SENDER, ...((s?.value as object) ?? {}) };
}

export async function setSenderProfile(db: Db, raw: unknown, actorId: string) {
  const v = z
    .object({ businessName: z.string().trim().min(2).max(40), optOutText: z.string().trim().min(5).max(60) })
    .parse(raw);
  if (!/stop/i.test(v.optOutText)) throw new AppError('Opt-out text must tell the recipient how to opt out (e.g. "Reply STOP")');
  await db.systemSetting.upsert({ where: { key: SENDER_KEY }, update: { value: v, updatedBy: actorId }, create: { key: SENDER_KEY, value: v, updatedBy: actorId } });
  await audit(db, { actorId, action: "settings.sender_profile", entityType: "system", metadata: v });
}
