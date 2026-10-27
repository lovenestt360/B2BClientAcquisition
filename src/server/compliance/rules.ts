/**
 * Country rule packs. These encode a conservative reading of the law for product gating;
 * they are not legal advice. Review with counsel before relying on them.
 *
 * ZA:
 *  - POPIA s69: direct marketing by "electronic communication" (SMS, email, automatic calling
 *    machines) needs prior consent, OR the recipient is an existing customer (s69(3)) given an
 *    opt-out each time. A person who has not previously withheld consent may be approached
 *    ONCE to request consent (s69(2)). Every message must identify the sender and give an
 *    opt-out address (s69(4)).
 *  - CPA s11 + Reg 4: honour opt-outs/pre-emptive blocks; no direct-marketing contact on
 *    Sundays or public holidays, Saturdays before 09:00 or after 13:00, or other days before
 *    08:00 or after 20:00.
 *  - The Information Regulator's December 2024 guidance treats telephone calls as electronic
 *    communication. This conservative rule therefore requires consent or an existing-customer
 *    basis for live marketing calls too, pending counsel review.
 * Default (all other / unknown countries): strict opt-in for every marketing channel.
 */
import type { Channel } from "@prisma/client";

export interface RulePack {
  country: string;
  /** Channels where marketing requires consent or an existing-customer basis. */
  consentRequired: Channel[];
  /** Whether an existing-customer relationship (with opt-out) is a valid basis. */
  existingCustomerBasis: boolean;
  /** Whether a single consent-request approach is allowed (POPIA s69(2)). */
  oneConsentRequestAllowed: boolean;
  /** Contact window check; returns a reason string when outside allowed hours. */
  contactWindow?: (local: LocalTime) => string | null;
  citation: string;
}

export interface LocalTime {
  weekday: number; // 0=Sunday
  hour: number;
  minute: number;
  isoDate: string; // YYYY-MM-DD in the local timezone
}

const ZA: RulePack = {
  country: "ZA",
  consentRequired: ["EMAIL", "SMS", "VOICE_AUTOMATED", "VOICE_MANUAL"],
  existingCustomerBasis: true,
  oneConsentRequestAllowed: true,
  contactWindow: (t) => {
    if (isZaPublicHoliday(t.isoDate)) return "CPA Reg 4: no direct marketing on public holidays";
    if (t.weekday === 0) return "CPA Reg 4: no direct marketing on Sundays";
    const mins = t.hour * 60 + t.minute;
    if (t.weekday === 6) {
      if (mins < 9 * 60 || mins >= 13 * 60) return "CPA Reg 4: Saturdays only 09:00–13:00";
      return null;
    }
    if (mins < 8 * 60 || mins >= 20 * 60) return "CPA Reg 4: weekdays only 08:00–20:00";
    return null;
  },
  citation: "POPIA s69; CPA s11 & Reg 4",
};

const STRICT: RulePack = {
  country: "*",
  consentRequired: ["EMAIL", "SMS", "VOICE_AUTOMATED", "VOICE_MANUAL", "LINKEDIN"],
  existingCustomerBasis: false,
  oneConsentRequestAllowed: false,
  citation: "Default strict opt-in (country not configured)",
};

export function rulesFor(country: string | null | undefined): RulePack {
  return country?.toUpperCase() === "ZA" ? ZA : STRICT;
}

export function localTime(date: Date, timeZone = "Africa/Johannesburg"): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { weekday, hour: Number(parts.hour), minute: Number(parts.minute), isoDate: `${parts.year}-${parts.month}-${parts.day}` };
}

/** Anonymous Gregorian algorithm. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** South African public holidays (Public Holidays Act 36 of 1994), incl. Sunday→Monday rule. */
export function zaPublicHolidays(year: number): Set<string> {
  const fixed = ["01-01", "03-21", "04-27", "05-01", "06-16", "08-09", "09-24", "12-16", "12-25", "12-26"];
  const days = new Set<string>();
  for (const md of fixed) {
    const d = new Date(`${year}-${md}T00:00:00Z`);
    days.add(iso(d));
    if (d.getUTCDay() === 0) days.add(iso(new Date(d.getTime() + 86_400_000)));
  }
  const easter = easterSunday(year);
  days.add(iso(new Date(easter.getTime() - 2 * 86_400_000))); // Good Friday
  days.add(iso(new Date(easter.getTime() + 86_400_000))); // Family Day
  return days;
}

export function isZaPublicHoliday(isoDate: string): boolean {
  return zaPublicHolidays(Number(isoDate.slice(0, 4))).has(isoDate);
}
