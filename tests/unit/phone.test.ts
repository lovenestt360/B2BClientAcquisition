import { describe, expect, it } from "vitest";
import { parsePhone, validateZaMobile } from "@/server/phone";

describe("parsePhone", () => {
  it("parses local ZA formats to E.164", () => {
    expect(parsePhone("082 123 4567").e164).toBe("+27821234567");
    expect(parsePhone("+27 (0)82 123 4567").e164).toBe("+27821234567"); // trunk (0) tolerated
    expect(parsePhone("0027821234567").e164).toBe("+27821234567");
  });
  it("detects mobile vs fixed line", () => {
    expect(parsePhone("0821234567").type).toBe("MOBILE");
    expect(parsePhone("011 123 4567").type).toBe("FIXED_LINE");
  });
  it("rejects garbage", () => {
    expect(parsePhone("12345").valid).toBe(false);
    expect(parsePhone("").valid).toBe(false);
  });
});

describe("validateZaMobile", () => {
  it("accepts +27 mobiles", () => {
    expect(validateZaMobile("+27821234567").valid).toBe(true);
    expect(validateZaMobile("071 234 5678").valid).toBe(true);
  });
  it("rejects landlines and foreign numbers", () => {
    expect(validateZaMobile("0111234567").error).toMatch(/mobile/);
    expect(validateZaMobile("+447911123456").error).toMatch(/\+27/);
  });
});
