import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import type { PhoneType } from "@prisma/client";

export interface PhoneResult {
  valid: boolean;
  e164?: string;
  country?: string;
  type: PhoneType;
  error?: string;
}

export function parsePhone(raw: string, defaultCountry = "ZA"): PhoneResult {
  const input = raw.trim();
  if (!input) return { valid: false, type: "UNKNOWN", error: "empty" };
  const p = parsePhoneNumberFromString(input, defaultCountry as never);
  if (!p || !p.isValid()) return { valid: false, type: "UNKNOWN", error: `invalid phone number "${input}"` };
  const t = p.getType();
  const type: PhoneType =
    t === "MOBILE" ? "MOBILE" : t === "FIXED_LINE" ? "FIXED_LINE" : t === "FIXED_LINE_OR_MOBILE" ? "UNKNOWN" : "UNKNOWN";
  return { valid: true, e164: p.number, country: p.country, type };
}

/** Strict +27 mobile validation for South African SMS. */
export function validateZaMobile(raw: string): PhoneResult {
  const r = parsePhone(raw, "ZA");
  if (!r.valid) return r;
  if (r.country !== "ZA" || !r.e164!.startsWith("+27")) {
    return { ...r, valid: false, error: "not a South African (+27) number" };
  }
  if (r.type !== "MOBILE") return { ...r, valid: false, error: "not a South African mobile number" };
  return r;
}
