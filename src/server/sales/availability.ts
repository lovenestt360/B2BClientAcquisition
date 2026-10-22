import { z } from "zod";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { isZaPublicHoliday } from "../compliance/rules";

const KEY = "booking.availability";

export const availabilitySchema = z.object({
  days: z.array(z.coerce.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]), // 0 = Sunday
  startHour: z.coerce.number().int().min(6).max(20).default(9),
  endHour: z.coerce.number().int().min(7).max(21).default(16),
  slotMinutes: z.coerce.number().int().min(10).max(120).default(30),
  bufferMinutes: z.coerce.number().int().min(0).max(60).default(15),
  minNoticeHours: z.coerce.number().int().min(1).max(96).default(18),
  horizonDays: z.coerce.number().int().min(1).max(30).default(10),
  timeZone: z.string().default("Africa/Johannesburg"),
  skipPublicHolidays: z.boolean().default(true),
});
export type Availability = z.infer<typeof availabilitySchema>;

export async function getAvailability(db: Db): Promise<Availability> {
  const s = await db.systemSetting.findUnique({ where: { key: KEY } });
  return availabilitySchema.parse({ timeZone: process.env.APP_TIMEZONE ?? "Africa/Johannesburg", ...((s?.value as object) ?? {}) });
}

export async function saveAvailability(db: Db, raw: Record<string, unknown>, actorId: string) {
  const days = Array.isArray(raw.days) ? raw.days : String(raw.days ?? "").split(",").filter(Boolean);
  const v = availabilitySchema.parse({ ...raw, days, skipPublicHolidays: raw.skipPublicHolidays !== "false" && raw.skipPublicHolidays !== false });
  if (v.endHour <= v.startHour) throw new Error("End hour must be after start hour");
  await db.systemSetting.upsert({ where: { key: KEY }, update: { value: v, updatedBy: actorId }, create: { key: KEY, value: v, updatedBy: actorId } });
  await audit(db, { actorId, action: "settings.availability", entityType: "system" });
  return v;
}

/** Offset (ms) of a time zone at a given instant: local wall clock − UTC. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** UTC instant for a local wall-clock time in `timeZone`. */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min));
  return new Date(guess.getTime() - tzOffsetMs(guess, timeZone));
}

export interface Busy {
  startsAt: Date;
  endsAt: Date;
}

/** Bookable slot starts, earliest first, avoiding existing meetings (+buffer). */
export function freeSlots(now: Date, a: Availability, busy: Busy[], limit = 40): Date[] {
  const out: Date[] = [];
  const slotMs = a.slotMinutes * 60_000;
  const buf = a.bufferMinutes * 60_000;
  const earliest = now.getTime() + a.minNoticeHours * 3_600_000;
  for (let i = 0; i <= a.horizonDays && out.length < limit; i++) {
    const day = new Date(now.getTime() + i * 86_400_000);
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: a.timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
        .formatToParts(day)
        .map((x) => [x.type, x.value]),
    );
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    if (!a.days.includes(weekday)) continue;
    if (a.skipPublicHolidays && isZaPublicHoliday(`${p.year}-${p.month}-${p.day}`)) continue;
    for (let mins = a.startHour * 60; mins + a.slotMinutes <= a.endHour * 60; mins += a.slotMinutes) {
      const start = zonedTime(+p.year, +p.month, +p.day, Math.floor(mins / 60), mins % 60, a.timeZone);
      const s = start.getTime();
      if (s < earliest) continue;
      const clash = busy.some((b) => s < b.endsAt.getTime() + buf && s + slotMs + buf > b.startsAt.getTime());
      if (!clash) out.push(start);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function slotLabel(d: Date, timeZone = "Africa/Johannesburg"): string {
  const day = new Intl.DateTimeFormat("en-ZA", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(d);
  const time = new Intl.DateTimeFormat("en-ZA", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${day} at ${time}`;
}

/** Two well-spaced options: the first free slot, and one on a different day (or later the same day). */
export function pickTwo(slots: Date[], timeZone: string, exclude: string[] = []): Date[] {
  const pool = slots.filter((s) => !exclude.includes(s.toISOString()));
  if (pool.length <= 1) return pool;
  const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(d);
  const hourOf = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(d));
  const first = pool[0];
  const second =
    pool.find((s) => dayOf(s) !== dayOf(first) && Math.abs(hourOf(s) - hourOf(first)) >= 3) ??
    pool.find((s) => dayOf(s) !== dayOf(first)) ??
    pool[pool.length - 1];
  return [first, second];
}

export async function busyMeetings(db: Db, from: Date): Promise<Busy[]> {
  return db.meeting.findMany({ where: { endsAt: { gte: from }, status: { in: ["scheduled", "tentative"] } }, select: { startsAt: true, endsAt: true } });
}
