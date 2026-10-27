import { describe, expect, it } from "vitest";
import { extractWebsiteEvidence } from "@/server/research/import-enrichment";

describe("post-import website research", () => {
  it("extracts cited company metadata from JSON-LD", () => {
    const html = `<html><head><meta name="description" content="Independent financial advisers."><script type="application/ld+json">{"@type":"Organization","industry":"Financial Services","address":{"@type":"PostalAddress","addressLocality":"Cape Town","addressCountry":"South Africa"}}</script></head></html>`;
    expect(extractWebsiteEvidence(html)).toEqual({ description: "Independent financial advisers.", industry: "Financial Services", country: "ZA", city: "Cape Town" });
  });

  it("ignores malformed structured data instead of inventing values", () => {
    expect(extractWebsiteEvidence(`<script type="application/ld+json">not-json</script>`)).toEqual({ description: null, industry: null, country: null, city: null });
  });
});
