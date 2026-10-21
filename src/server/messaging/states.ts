import type { DeliveryState, DraftStatus } from "@prisma/client";
import { AppError } from "../errors";

/** Allowed workflow transitions for message drafts. */
export const DRAFT_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  DRAFT: ["PENDING_APPROVAL", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["HANDED_OFF", "CANCELLED"],
  HANDED_OFF: ["SENT_CONFIRMED", "SEND_FAILED", "APPROVED", "CANCELLED"], // APPROVED = "I didn't send it"
  SENT_CONFIRMED: [],
  SEND_FAILED: ["APPROVED", "CANCELLED"], // retry requires going back through hand-off
  REJECTED: [],
  CANCELLED: [],
};

/**
 * Delivery state only moves forward on evidence. DELIVERED is reachable only from a provider
 * receipt; manual (user attestation) flows can reach at most UNKNOWN or FAILED.
 */
export const DELIVERY_TRANSITIONS: Record<DeliveryState, DeliveryState[]> = {
  NOT_ATTEMPTED: ["ATTEMPTED", "ACCEPTED", "FAILED", "UNKNOWN"],
  ATTEMPTED: ["ACCEPTED", "FAILED", "UNKNOWN", "DELIVERED"],
  ACCEPTED: ["DELIVERED", "FAILED", "UNKNOWN"],
  UNKNOWN: ["DELIVERED", "FAILED"],
  DELIVERED: [],
  FAILED: [],
};

export type Evidence = "user_attestation" | "provider_receipt" | "simulated_receipt" | "system";

export function assertDraftTransition(from: DraftStatus, to: DraftStatus) {
  if (from === to) return;
  if (!DRAFT_TRANSITIONS[from].includes(to)) throw new AppError(`Cannot move draft from ${from} to ${to}`, "invalid_transition", 409);
}

export function assertDeliveryTransition(from: DeliveryState, to: DeliveryState, evidence: Evidence) {
  if (from === to) return;
  if (!DELIVERY_TRANSITIONS[from].includes(to)) throw new AppError(`Cannot move delivery state from ${from} to ${to}`, "invalid_transition", 409);
  if (to === "DELIVERED" && evidence !== "provider_receipt" && evidence !== "simulated_receipt") {
    throw new AppError("DELIVERED requires an independent delivery receipt", "no_evidence", 422);
  }
}
