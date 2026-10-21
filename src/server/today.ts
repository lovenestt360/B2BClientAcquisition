import type { Db } from "@/lib/db";

/** Counts that drive the phone tab badges and the Today screen. */
export async function workQueueCounts(db: Db) {
  const [smsToSend, awaitingConfirmation, awaitingApproval, callsQueued, callsAwaitingOutcome] = await Promise.all([
    db.messageDraft.count({ where: { channel: "SMS", status: { in: ["APPROVED", "HANDED_OFF"] } } }),
    db.messageDraft.count({ where: { channel: "SMS", status: "HANDED_OFF" } }),
    db.messageDraft.count({ where: { status: "PENDING_APPROVAL" } }),
    db.call.count({ where: { mode: "MANUAL", status: { in: ["QUEUED", "DIALING"] } } }),
    db.call.count({ where: { mode: "MANUAL", status: "DIALING" } }),
  ]);
  return { smsToSend, awaitingConfirmation, awaitingApproval, callsQueued, callsAwaitingOutcome };
}

/** Midnight at the start of `now`'s calendar day in `timeZone`, as a UTC instant. */
export function startOfLocalDay(now: Date, timeZone = process.env.APP_TIMEZONE ?? "Africa/Johannesburg"): Date {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const localAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - offset);
}

/** What happened since `since` (normally startOfLocalDay). */
export async function todayActivity(db: Db, since: Date) {
  const [smsConfirmed, replies, callsDone, meetings] = await Promise.all([
    db.smsEvent.count({ where: { type: "USER_CONFIRMED_SENT", occurredAt: { gte: since } } }),
    db.smsEvent.count({ where: { direction: "inbound", occurredAt: { gte: since } } }),
    db.call.count({ where: { mode: "MANUAL", endedAt: { gte: since } } }),
    db.call.count({ where: { outcome: "MEETING_BOOKED", endedAt: { gte: since } } }),
  ]);
  return { smsConfirmed, replies, callsDone, meetings };
}
