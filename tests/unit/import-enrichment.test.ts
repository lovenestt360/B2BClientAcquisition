import { describe, expect, it } from "vitest";
import { groundedClaims } from "@/server/research/import-enrichment";

describe("Gemini post-import research", () => {
  it("accepts only a claim directly covered by Google Search grounding", () => {
    const text = JSON.stringify({ claims: [{ field: "title", value: "Finance Director", confidence: 0.95 }, { field: "email", value: "person@example.com", confidence: 0.9 }] });
    const titleStart = text.indexOf("Finance Director");
    const claims = groundedClaims({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://company.example/team" } }], groundingSupports: [{ segment: { startIndex: titleStart, endIndex: titleStart + 16 }, groundingChunkIndices: [0] }] } }] });
    expect(claims).toEqual([{ field: "title", value: "Finance Director", confidence: 0.95, sourceUrl: "https://company.example/team" }]);
  });

  it("rejects valid-looking but ungrounded output", () => {
    const text = JSON.stringify({ claims: [{ field: "email", value: "guessed@example.com", confidence: 1 }] });
    expect(groundedClaims({ candidates: [{ content: { parts: [{ text }] } }] })).toEqual([]);
  });
});
