import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { busyMeetings } from "./availability";

export interface BookingInput {
  callId: string;
  contactId: string;
  startIso: string;
  lengthMin: number;
  title: string;
  /** Sandbox rehearsal: recorded for review but never blocks the diary or moves a real lead. */
  simulated: boolean;
  label: string;
}

/**
 * Persist a meeting agreed on a call. Re-checks the slot inside the caller's transaction so two calls
 * can't take the same time. Real calls create a *tentative* meeting until a calendar confirms it.
 */
export async function bookFromCall(tx: Db, b: BookingInput) {
  const startsAt = new Date(b.startIso);
  const endsAt = new Date(startsAt.getTime() + b.lengthMin * 60_000);
  let status = b.simulated ? "simulated" : "tentative";
  let notes = `Booked by AI on call ${b.callId} (${b.label}).`;
  if (!b.simulated) {
    const clash = (await busyMeetings(tx, startsAt)).some((m) => startsAt < m.endsAt && endsAt > m.startsAt);
    if (clash) {
      status = "needs_reschedule";
      notes += " Slot was taken by another booking: contact the lead to reschedule.";
    }
  }
  const meeting = await tx.meeting.create({
    data: { contactId: b.contactId, title: b.title, startsAt, endsAt, status, source: b.simulated ? "ai_sandbox" : "ai_call", callId: b.callId, notes },
  });
  const contact = await tx.contact.findUniqueOrThrow({ where: { id: b.contactId } });
  if (!b.simulated || contact.isSimulated) {
    await tx.contact.update({ where: { id: b.contactId }, data: { stage: "MEETING_BOOKED" } });
  }
  await tx.callEvent.create({ data: { callId: b.callId, type: "meeting_booked", evidence: b.simulated ? "sandbox" : "provider", data: { meetingId: meeting.id, startsAt: b.startIso, status } } });
  await audit(tx, { actorType: "system", action: "meeting.booked_by_ai", entityType: "meeting", entityId: meeting.id, metadata: { callId: b.callId, contactId: b.contactId, status } });
  return meeting;
}
