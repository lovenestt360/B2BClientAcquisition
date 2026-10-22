import { isZaPublicHoliday, localTime } from "../compliance/rules";
import { zonedTime } from "../sales/availability";
import type { OutreachSettings } from "./config";

type Sched = Pick<OutreachSettings, "timezone" | "sendDays" | "batchHours" | "batchWindowMinutes" | "skipPublicHolidaysOf">;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function isSendDay(t: { weekday: number; isoDate: string }, s: Sched): boolean {
  if (!s.sendDays.includes(t.weekday)) return false;
  if (s.skipPublicHolidaysOf === "ZA" && isZaPublicHoliday(t.isoDate)) return false;
  return true;
}

/** Start of the hourly batch slot `now` falls in (in the operating timezone), or null outside every batch. */
export function batchSlot(now: Date, s: Sched): Date | null {
  const t = localTime(now, s.timezone);
  if (!isSendDay(t, s) || !s.batchHours.includes(t.hour) || t.minute >= s.batchWindowMinutes) return null;
  const [y, m, d] = t.isoDate.split("-").map(Number);
  return zonedTime(y, m, d, t.hour, 0, s.timezone);
}

/**
 * The first batch slot starting at or after `at`, rolled forward over nights, weekends and
 * holidays. With `includeOpen`, a slot already under way counts while its window is open.
 */
export function nextBatchAtOrAfter(at: Date, s: Sched, includeOpen = false): Date | null {
  if (!s.batchHours.length || !s.sendDays.length) return null;
  const hours = [...s.batchHours].sort((a, b) => a - b);
  for (let i = 0; i < 400; i++) {
    const t = localTime(new Date(at.getTime() + i * DAY), s.timezone);
    if (!isSendDay(t, s)) continue;
    const [y, m, d] = t.isoDate.split("-").map(Number);
    for (const h of hours) {
      const slot = zonedTime(y, m, d, h, 0, s.timezone);
      if (slot.getTime() >= at.getTime()) return slot;
      if (includeOpen && slot.getTime() + s.batchWindowMinutes * 60_000 > at.getTime()) return slot;
    }
  }
  return null;
}

/** Local-day bounds in the operating timezone. */
export function dayBounds(at: Date, timezone: string): [Date, Date] {
  const t = localTime(at, timezone);
  const [y, m, d] = t.isoDate.split("-").map(Number);
  const start = zonedTime(y, m, d, 0, 0, timezone);
  const n = localTime(new Date(start.getTime() + DAY + 2 * HOUR), timezone); // DST-safe next day
  const [y2, m2, d2] = n.isoDate.split("-").map(Number);
  return [start, zonedTime(y2, m2, d2, 0, 0, timezone)];
}

export function hourBounds(slot: Date): [Date, Date] {
  return [slot, new Date(slot.getTime() + HOUR)];
}

/**
 * When a follow-up becomes due: previous provider-confirmed send + approved wait, rolled forward
 * to the next batch that starts no earlier (never early).
 */
export function followUpDue(previousConfirmedAt: Date, waitDays: number, s: Sched): Date | null {
  return nextBatchAtOrAfter(new Date(previousConfirmedAt.getTime() + waitDays * DAY), s);
}
