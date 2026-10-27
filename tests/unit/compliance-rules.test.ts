import { describe, expect, it } from "vitest";
import { isZaPublicHoliday, localTime, rulesFor, zaPublicHolidays } from "@/server/compliance/rules";
import { isOptOutText } from "@/server/compliance/controls";

const at = (iso: string) => localTime(new Date(iso), "Africa/Johannesburg");
const window = (iso: string) => rulesFor("ZA").contactWindow!(at(iso));

describe("ZA public holidays", () => {
  it("includes Easter-based and Sunday-shifted holidays", () => {
    const h = zaPublicHolidays(2026);
    expect(h.has("2026-04-03")).toBe(true); // Good Friday 2026
    expect(h.has("2026-04-06")).toBe(true); // Family Day
    expect(h.has("2026-04-27")).toBe(true); // Freedom Day
    expect(h.has("2026-08-10")).toBe(true); // Women's Day (9 Aug = Sunday) observed Monday
    expect(isZaPublicHoliday("2026-12-16")).toBe(true);
    expect(isZaPublicHoliday("2026-10-21")).toBe(false);
  });
});

describe("CPA Reg 4 contact window (SAST)", () => {
  it.each([
    ["2026-10-21T06:30:00Z", null], // Wed 08:30
    ["2026-10-21T05:59:00Z", /weekdays/], // Wed 07:59
    ["2026-10-21T18:00:00Z", /weekdays/], // Wed 20:00
    ["2026-10-24T07:30:00Z", null], // Sat 09:30
    ["2026-10-24T11:00:00Z", /Saturdays/], // Sat 13:00
    ["2026-10-25T10:00:00Z", /Sundays/], // Sun
    ["2026-12-16T10:00:00Z", /public holidays/], // Day of Reconciliation
  ])("%s", (iso, expected) => {
    const r = window(iso);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toMatch(expected);
  });
});

describe("rule packs", () => {
  it("ZA conservatively requires consent for electronic channels including human calls", () => {
    const za = rulesFor("za");
    expect(za.consentRequired).toEqual(expect.arrayContaining(["SMS", "EMAIL", "VOICE_AUTOMATED"]));
    expect(za.consentRequired).toContain("VOICE_MANUAL");
  });
  it("unknown countries are strict opt-in everywhere", () => {
    expect(rulesFor(null).consentRequired).toContain("VOICE_MANUAL");
    expect(rulesFor("US").existingCustomerBasis).toBe(false);
  });
  it("detects opt-out replies", () => {
    for (const t of ["STOP", "stop please", "Unsubscribe", "opt out", "Remove me", "moenie"]) expect(isOptOutText(t)).toBe(true);
    for (const t of ["Yes please call", "Don't stop now, tell me more"]) expect(isOptOutText(t)).toBe(false);
  });
});
