import type { CallOutcome, CallStatus } from "@prisma/client";
import { AppError } from "../errors";

export const CALL_TRANSITIONS: Record<CallStatus, CallStatus[]> = {
  QUEUED: ["DIALING", "IN_PROGRESS", "CANCELLED"],
  DIALING: ["IN_PROGRESS", "COMPLETED", "NO_ANSWER", "BUSY", "FAILED", "QUEUED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  NO_ANSWER: [],
  BUSY: [],
  FAILED: [],
  CANCELLED: [],
};

export function assertCallTransition(from: CallStatus, to: CallStatus) {
  if (from === to) return;
  if (!CALL_TRANSITIONS[from].includes(to)) throw new AppError(`Cannot move call from ${from} to ${to}`, "invalid_transition", 409);
}

/**
 * Live call assist (human caller, AI script): opener → discovery → pitch → meeting_ask → booked.
 * The caller may jump back to an earlier stage; terminal stages only reopen to meeting_ask.
 * opt_out is reachable from everywhere and is final.
 */
export type AssistStage = "opener" | "discovery" | "pitch" | "meeting_ask" | "booked" | "callback" | "closed_no" | "opt_out";

export const ASSIST_TRANSITIONS: Record<AssistStage, AssistStage[]> = {
  opener: ["discovery", "pitch", "meeting_ask", "callback", "closed_no", "opt_out"],
  discovery: ["opener", "pitch", "meeting_ask", "callback", "closed_no", "opt_out"],
  pitch: ["discovery", "meeting_ask", "callback", "closed_no", "opt_out"],
  meeting_ask: ["discovery", "pitch", "booked", "callback", "closed_no", "opt_out"],
  booked: ["meeting_ask", "opt_out"],
  callback: ["meeting_ask", "discovery", "closed_no", "opt_out"],
  closed_no: ["meeting_ask", "discovery", "callback", "opt_out"],
  opt_out: [],
};

export function canAssistTransition(from: AssistStage, to: AssistStage) {
  return from === to || ASSIST_TRANSITIONS[from].includes(to);
}

export function assertAssistTransition(from: AssistStage, to: AssistStage) {
  if (!canAssistTransition(from, to)) throw new AppError(`Cannot move the call script from ${from} to ${to}`, "invalid_transition", 409);
}

export function statusForOutcome(o: CallOutcome): CallStatus {
  if (o === "NO_ANSWER") return "NO_ANSWER";
  if (o === "BUSY") return "BUSY";
  return "COMPLETED";
}
