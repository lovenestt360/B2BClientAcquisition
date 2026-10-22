import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { findSuppression } from "../compliance/controls";
import { canMoveMember, canMoveSend, type MemberState } from "./states";

export type StopReason = "REPLY" | "BOOKED" | "OPT_OUT" | "HARD_BOUNCE" | "SUPPRESSED" | "MANUAL";

const GENUINE_REPLY = new Set(["interested", "not_interested", "question"]);
const PENDING = ["AWAITING_APPROVAL", "APPROVED", "HELD", "RESEARCH_REQUIRED"];
const CONFIRMED_MEETING = ["scheduled", "completed"];
const TENTATIVE_MEETING = ["tentative", "needs_reschedule"];

const ACTIVE_STATES: MemberState[] = ["PENDING_APPROVAL", "ACTIVE", "HOLD", "RESEARCH_REQUIRED", "COMPLETED"];

/** Stop a recipient's sequence for good and withdraw anything not yet sent. */
export async function stopMember(db: Db, memberId: string, reason: StopReason, detail: string, actorId: string | null = null) {
  const m = await db.campaignMember.findUniqueOrThrow({ where: { id: memberId } });
  if (m.state === "STOPPED") return false;
  if (!canMoveMember(m.state, "STOPPED")) return false;
  await db.campaignMember.update({ where: { id: m.id }, data: { state: "STOPPED", stopReason: reason, holdReason: null, nextDueAt: null } });
  const pending = await db.outreachSend.findMany({ where: { memberId, status: { in: PENDING } } });
  for (const p of pending) {
    if (canMoveSend(p.status, "REJECTED")) {
      await db.outreachSend.update({ where: { id: p.id }, data: { status: "REJECTED", reasonCodes: [`STOPPED_${reason}`] as Prisma.InputJsonValue } });
    }
  }
  await audit(db, { actorId, actorType: actorId ? "user" : "job", action: "outreach.stop", entityType: "campaign_member", entityId: m.id, metadata: { reason, detail, withdrawn: pending.length } });
  return true;
}

/** Hold a recipient for human review; approved-but-unsent steps go back to held. */
export async function holdMember(db: Db, memberId: string, code: string, detail: string, target: "HOLD" | "RESEARCH_REQUIRED" = "HOLD", actorId: string | null = null) {
  const m = await db.campaignMember.findUniqueOrThrow({ where: { id: memberId } });
  if (m.state === target && m.holdReason === code) return false;
  if (!canMoveMember(m.state, target)) return false;
  await db.campaignMember.update({ where: { id: m.id }, data: { state: target, holdReason: code } });
  await db.outreachSend.updateMany({ where: { memberId, status: "APPROVED" }, data: { status: "HELD", reasonCodes: [code] as Prisma.InputJsonValue } });
  await audit(db, { actorId, actorType: actorId ? "user" : "job", action: "outreach.hold", entityType: "campaign_member", entityId: m.id, metadata: { code, detail, state: target } });
  return true;
}

/**
 * Apply one ingested inbound email to the contact's sequences.
 * Reply → stop; unsubscribe → stop (opt-out already recorded by ingest); hard bounce → suppress
 * and stop; soft bounce → hold; out-of-office → log only; anything uncertain → hold.
 */
export async function applyInboundToSequences(
  db: Db,
  inbound: { id: string; contactId: string | null; classification: string | null; fromAddress: string; bounceType: string | null; messageId: string },
  extra: { relatedMessageIds?: string[]; bounceRecipient?: string | null } = {},
) {
  const related = (extra.relatedMessageIds ?? []).filter(Boolean);
  const relatedSend = related.length ? await db.outreachSend.findFirst({ where: { providerMessageId: { in: related } }, orderBy: { step: "desc" } }) : null;
  let contactId = inbound.contactId ?? relatedSend?.contactId ?? null;
  if (!contactId && extra.bounceRecipient) contactId = (await db.contact.findUnique({ where: { email: extra.bounceRecipient.toLowerCase() } }))?.id ?? null;
  if (!contactId) return { applied: 0 };

  const label = inbound.classification ?? "other";
  const members = await db.campaignMember.findMany({ where: { contactId, campaign: { key: { not: null } }, state: { in: ACTIVE_STATES } } });

  // Resolve an unconfirmed attempt from the recipient's own evidence.
  if (relatedSend?.status === "UNKNOWN") {
    if (label === "bounce" && inbound.bounceType === "hard") {
      await db.outreachSend.update({ where: { id: relatedSend.id }, data: { status: "FAILED", reasonCodes: ["HARD_BOUNCE"] as Prisma.InputJsonValue } });
    } else if (label !== "bounce") {
      await db.outreachSend.update({ where: { id: relatedSend.id }, data: { status: "PROVIDER_ACCEPTED", confirmedAt: relatedSend.batchAt ?? relatedSend.updatedAt, reasonCodes: ["CONFIRMED_BY_RECIPIENT_RESPONSE"] as Prisma.InputJsonValue } });
    }
  }

  if (label === "bounce" && inbound.bounceType === "hard") {
    // Preserve suppression first, then stop.
    const addr = (extra.bounceRecipient ?? (await db.contact.findUnique({ where: { id: contactId } }))?.email ?? "").toLowerCase();
    if (addr && !(await db.suppression.findFirst({ where: { email: addr } }))) {
      await db.suppression.create({ data: { email: addr, reason: "bounce", source: `hard bounce ${inbound.messageId}`, channel: "EMAIL" } });
    }
  }

  let applied = 0;
  for (const m of members) {
    let changed = false;
    if (label === "unsubscribe") changed = await stopMember(db, m.id, "OPT_OUT", `opt-out email ${inbound.messageId}`);
    else if (label === "bounce" && inbound.bounceType === "hard") changed = await stopMember(db, m.id, "HARD_BOUNCE", `hard bounce ${inbound.messageId}`);
    else if (label === "bounce") changed = await holdMember(db, m.id, "SOFT_BOUNCE", `temporary bounce ${inbound.messageId}; review before the next step`);
    else if (label === "out_of_office") {
      await audit(db, { actorType: "job", action: "outreach.auto_reply", entityType: "campaign_member", entityId: m.id, metadata: { messageId: inbound.messageId } });
    } else if (GENUINE_REPLY.has(label)) changed = await stopMember(db, m.id, "REPLY", `${label} reply ${inbound.messageId}; route to a human`);
    else changed = await holdMember(db, m.id, "REPLY_UNCERTAIN", `unclassified reply ${inbound.messageId}; review before any follow-up`);
    if (changed) applied++;
  }
  return { applied };
}

/**
 * Re-derive stops from the database (run immediately before every send and by the watch):
 * meetings, suppressions and replies that may have arrived through any path.
 */
export async function recheckStops(db: Db, memberId: string): Promise<string> {
  const m = await db.campaignMember.findUniqueOrThrow({ where: { id: memberId }, include: { contact: true } });
  if (m.state === "STOPPED") return m.state;
  const c = m.contact;

  const meetings = await db.meeting.findMany({ where: { contactId: c.id, status: { in: [...CONFIRMED_MEETING, ...TENTATIVE_MEETING] } } });
  if (meetings.some((x) => CONFIRMED_MEETING.includes(x.status))) {
    await stopMember(db, m.id, "BOOKED", "confirmed meeting on record");
    return "STOPPED";
  }

  if (c.email) {
    const sup = await findSuppression(db, { email: c.email, domain: c.email.split("@")[1], channel: "EMAIL" });
    if (sup) {
      await stopMember(db, m.id, sup.reason === "bounce" ? "HARD_BOUNCE" : sup.reason === "opt_out" ? "OPT_OUT" : "SUPPRESSED", `suppression ${sup.reason} (${sup.source})`);
      return "STOPPED";
    }
  }

  const inbound = await db.emailMessage.findMany({ where: { contactId: c.id, direction: "inbound", occurredAt: { gte: m.addedAt } }, select: { classification: true, messageId: true, bounceType: true } });
  const optOut = inbound.find((i) => i.classification === "unsubscribe");
  if (optOut) {
    await stopMember(db, m.id, "OPT_OUT", `opt-out email ${optOut.messageId}`);
    return "STOPPED";
  }
  const reply = inbound.find((i) => GENUINE_REPLY.has(i.classification ?? ""));
  if (reply) {
    await stopMember(db, m.id, "REPLY", `reply ${reply.messageId}`);
    return "STOPPED";
  }
  if (m.state !== "HOLD") {
    if (inbound.some((i) => i.classification === "other")) {
      await holdMember(db, m.id, "REPLY_UNCERTAIN", "unclassified reply on record");
      return "HOLD";
    }
    if (meetings.some((x) => TENTATIVE_MEETING.includes(x.status))) {
      await holdMember(db, m.id, "BOOKING_TENTATIVE", "tentative meeting: confirm or cancel before any follow-up");
      return "HOLD";
    }
  }
  return (await db.campaignMember.findUniqueOrThrow({ where: { id: m.id } })).state;
}

/** Reply & Stop Watch: recheck every recipient that could still receive a step. */
export async function runStopWatch(db: Db) {
  const members = await db.campaignMember.findMany({ where: { campaign: { key: { not: null } }, state: { in: ACTIVE_STATES } }, select: { id: true, state: true } });
  const result = { checked: members.length, stopped: 0, held: 0 };
  for (const m of members) {
    const after = await recheckStops(db, m.id);
    if (after === "STOPPED") result.stopped++;
    else if (after === "HOLD" && m.state !== "HOLD") result.held++;
  }
  if (result.stopped || result.held) await audit(db, { actorType: "job", action: "outreach.stop_watch", entityType: "system", metadata: result });
  return result;
}
