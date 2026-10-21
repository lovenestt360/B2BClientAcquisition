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

export function statusForOutcome(o: CallOutcome): CallStatus {
  if (o === "NO_ANSWER") return "NO_ANSWER";
  if (o === "BUSY") return "BUSY";
  return "COMPLETED";
}
