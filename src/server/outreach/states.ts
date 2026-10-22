import { AppError } from "../errors";

/** Per-recipient sequence state (campaign_members.state). */
export type MemberState = "PENDING_APPROVAL" | "ACTIVE" | "HOLD" | "RESEARCH_REQUIRED" | "STOPPED" | "COMPLETED";

export const MEMBER_TRANSITIONS: Record<MemberState, MemberState[]> = {
  PENDING_APPROVAL: ["ACTIVE", "HOLD", "RESEARCH_REQUIRED", "STOPPED"],
  ACTIVE: ["HOLD", "RESEARCH_REQUIRED", "STOPPED", "COMPLETED"],
  HOLD: ["ACTIVE", "RESEARCH_REQUIRED", "STOPPED"], // ACTIVE again only by human re-approval
  RESEARCH_REQUIRED: ["ACTIVE", "HOLD", "STOPPED"],
  STOPPED: [], // reply, booking, opt-out, hard bounce: never restarts automatically
  COMPLETED: ["STOPPED"],
};

/** One sequence step for one recipient (outreach_sends.status). */
export type SendStatus =
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "HELD"
  | "RESEARCH_REQUIRED"
  | "REJECTED"
  | "SENDING"
  | "PROVIDER_ACCEPTED"
  | "DRY_RUN"
  | "FAILED"
  | "UNKNOWN";

export const SEND_TRANSITIONS: Record<SendStatus, SendStatus[]> = {
  AWAITING_APPROVAL: ["APPROVED", "REJECTED", "HELD", "RESEARCH_REQUIRED"],
  HELD: ["AWAITING_APPROVAL", "REJECTED", "RESEARCH_REQUIRED"], // AWAITING_APPROVAL = regenerated
  RESEARCH_REQUIRED: ["AWAITING_APPROVAL", "REJECTED", "HELD"],
  REJECTED: ["AWAITING_APPROVAL"], // regenerated after rejection
  APPROVED: ["SENDING", "HELD", "REJECTED"],
  // APPROVED = definitely not handed to the server (safe to retry)
  SENDING: ["PROVIDER_ACCEPTED", "DRY_RUN", "FAILED", "UNKNOWN", "APPROVED"],
  PROVIDER_ACCEPTED: [],
  DRY_RUN: [],
  FAILED: [],
  UNKNOWN: ["PROVIDER_ACCEPTED", "FAILED"], // only from later evidence (reply, bounce, provider log)
};

/** Outcomes that count as "sent" for sequence position and caps (DRY_RUN only inside a dry run). */
export const CONFIRMED: SendStatus[] = ["PROVIDER_ACCEPTED", "DRY_RUN"];
/** Unconfirmed attempts: count against caps, and block the next step until resolved. */
export const IN_FLIGHT: SendStatus[] = ["SENDING", "UNKNOWN"];

export function assertMemberTransition(from: string, to: MemberState) {
  if (from === to) return;
  if (!MEMBER_TRANSITIONS[from as MemberState]?.includes(to)) throw new AppError(`Cannot move recipient from ${from} to ${to}`, "invalid_transition", 409);
}

export function canMoveMember(from: string, to: MemberState) {
  return from === to || !!MEMBER_TRANSITIONS[from as MemberState]?.includes(to);
}

export function assertSendTransition(from: string, to: SendStatus) {
  if (from === to) return;
  if (!SEND_TRANSITIONS[from as SendStatus]?.includes(to)) throw new AppError(`Cannot move send from ${from} to ${to}`, "invalid_transition", 409);
}

export function canMoveSend(from: string, to: SendStatus) {
  return from === to || !!SEND_TRANSITIONS[from as SendStatus]?.includes(to);
}
