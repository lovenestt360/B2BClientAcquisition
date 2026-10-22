/**
 * Deterministic reading of a prospect's reply. Booking decisions never depend on the model.
 */
export type Intent = "affirm" | "decline" | "busy" | "question" | "other";

const DECLINE = /\b(not interested|no thanks|no thank you|not (right )?now|we('re| are) (fine|good|sorted|covered)|already (have|use|got)|not for us|no need|don'?t need|not really|nah|no)\b/i;
const BUSY = /\b(busy|bad time|in a meeting|driving|can'?t talk|call (me )?(back|later)|another time)\b/i;
const AFFIRM = /\b(yes|yeah|yep|yup|sure|ok(ay)?|sounds good|go ahead|fine|that works|works for me|perfect|great|let'?s do (it|that)|book (it|that)|absolutely|definitely|of course|why not)\b/i;
const QUESTION = /\?\s*$|^\s*(what|how|why|who|which|where|when|can you|could you|do you|is it|are you)\b|\b(how much|price|pricing|cost)\b/i;

export function classifyIntent(text: string): Intent {
  const t = text.trim();
  if (BUSY.test(t)) return "busy";
  if (DECLINE.test(t) && !/\b(no problem|no worries)\b/i.test(t)) return "decline";
  if (QUESTION.test(t)) return "question";
  if (AFFIRM.test(t)) return "affirm";
  return "other";
}

export const isPriceQuestion = (t: string) => /\b(how much|price|pricing|cost|fee|rate|expensive)\b/i.test(t);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parts(d: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { weekday: String(p.weekday).toLowerCase(), hour: Number(p.hour), minute: Number(p.minute) };
}

/** Hour the prospect mentioned, if any ("10", "10am", "2pm", "14:00", "half past two" not supported). */
export function mentionedHour(text: string): number | null {
  const m = /\b(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  if (h > 23) return null;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 6) h += 12; // "at 2" in business context = 14:00
  return h;
}

export interface SlotMatch {
  iso: string;
  /** true = picked one of the options we offered; false = alternative to confirm first */
  fromOffer: boolean;
}

/**
 * Which slot did the prospect choose? Ordinals and day/time references are matched against the two
 * offered slots first, then against all free slots (an alternative that we confirm before booking).
 */
export function matchSlot(text: string, offered: string[], free: string[], timeZone: string): SlotMatch | null {
  const t = text.toLowerCase();
  if (/\b(first|former|earlier one|option (one|1)|1st|the first one)\b/.test(t) && offered[0]) return { iso: offered[0], fromOffer: true };
  if (/\b(second|latter|later one|other one|option (two|2)|2nd)\b/.test(t) && offered[1]) return { iso: offered[1], fromOffer: true };

  const day = WEEKDAYS.find((d) => t.includes(d)) ?? (/\btomorrow\b/.test(t) ? "tomorrow" : null);
  const hour = mentionedHour(t);
  const part = /\bmorning\b/.test(t) ? "am" : /\b(afternoon|after lunch)\b/.test(t) ? "pm" : null;
  if (!day && hour === null && !part) return null;

  const fits = (iso: string) => {
    const p = parts(new Date(iso), timeZone);
    if (day && day !== "tomorrow" && p.weekday !== day) return false;
    if (hour !== null && p.hour !== hour) return false;
    if (part === "am" && p.hour >= 12) return false;
    if (part === "pm" && p.hour < 12) return false;
    return true;
  };
  const inOffer = offered.find(fits);
  if (inOffer) return { iso: inOffer, fromOffer: true };
  let pool = free;
  if (day === "tomorrow") {
    const tomorrow = parts(new Date(Date.now() + 86_400_000), timeZone).weekday;
    pool = free.filter((iso) => parts(new Date(iso), timeZone).weekday === tomorrow);
  }
  const alt = pool.find(fits);
  return alt ? { iso: alt, fromOffer: false } : null;
}
