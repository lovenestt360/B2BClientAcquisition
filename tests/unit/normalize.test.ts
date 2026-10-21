import { describe, expect, it } from "vitest";
import { normalizeCompanyName, normalizeDomain, normalizeEmail, normalizePersonName } from "@/server/normalize";

describe("normalizeCompanyName", () => {
  it.each([
    ["Karoo Logistics (Pty) Ltd", "karoo logistics"],
    ["KAROO LOGISTICS PTY LTD.", "karoo logistics"],
    ["Karoo Logistics", "karoo logistics"],
    ["Highveld Engineering CC", "highveld engineering"],
    ["Smith & Sons Inc.", "smith and sons"],
    ["Café Société Limited", "cafe societe"],
  ])("%s -> %s", (input, out) => expect(normalizeCompanyName(input)).toBe(out));
});

describe("normalizeDomain", () => {
  it.each([
    ["https://www.Acme.co.za/about?x=1", "acme.co.za"],
    ["acme.co.za", "acme.co.za"],
    ["jane@acme.co.za", "acme.co.za"],
    ["http://sub.acme.com:8080", "sub.acme.com"],
    ["not a domain", null],
    ["", null],
  ])("%s -> %s", (input, out) => expect(normalizeDomain(input)).toBe(out));
});

describe("normalizeEmail / person", () => {
  it("lowercases and validates", () => {
    expect(normalizeEmail("  Jane.Doe@Acme.CO.ZA ")).toBe("jane.doe@acme.co.za");
    expect(normalizeEmail("jane@")).toBeNull();
    expect(normalizeEmail("no-at-sign")).toBeNull();
  });
  it("normalises names for matching", () => {
    expect(normalizePersonName("Pieter", "van der Merwe")).toBe("pieter van der merwe");
    expect(normalizePersonName("  José ", null)).toBe("jose");
  });
});
