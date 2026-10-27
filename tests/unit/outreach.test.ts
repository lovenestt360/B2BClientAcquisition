import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFile, loadReferenceExamples } from "@/server/outreach/config";
import { batchSlot, dayBounds, followUpDue, nextBatchAtOrAfter } from "@/server/outreach/schedule";
import { composeFromEvidence, rankExposures, systemPrompt, SCOPE_NOT_TEMPLATE, type EvidenceItem, type GenerationInput, type GenerationOutput } from "@/server/outreach/generate";
import { validateOutreachEmail } from "@/server/outreach/validate";
import { canMoveMember, canMoveSend } from "@/server/outreach/states";

const cfg = loadConfigFile();
const S = cfg.settings;
const at = (iso: string) => new Date(iso);

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

let n = 0;
function fact(kind: string, field: string, value: string, extra: Partial<EvidenceItem> = {}): EvidenceItem {
  n++;
  return { id: `f${n}`, scope: "company", kind, field, value, sourceUrl: `https://source.example/${n}`, confidence: 0.9, verifiedAt: "2026-10-01T00:00:00Z", isInference: false, ...extra };
}

function input(over: Partial<GenerationInput> = {}, research: EvidenceItem[] = []): GenerationInput {
  return {
    lead: { firstName: "Thandi", lastName: "Mokoena", title: "Project Director", company: "Ubuntu Build", sector: "Healthcare construction", city: "Pretoria", country: "ZA" },
    campaign: { key: "SA-CON", name: "SA Contractors", icp: "" },
    step: 1,
    totalSteps: 5,
    verifiedResearch: research,
    hypotheses: [],
    approvedCapabilities: S.capabilities,
    exposureLibrary: S.exposures.map((e) => ({ id: e.id, label: e.label })),
    priorMessages: [],
    permissionStatus: { basis: "CONSENT", evidence: "form" },
    operationalContext: { meetingMinutes: 15, bookingUrl: null, approvedLinkDomains: S.approvedLinkDomains, wordRange: { min: 55, max: 90 }, bannedClaims: S.bannedClaims, senderName: S.senderName, businessName: S.businessName },
    ...over,
  };
}

const conResearch = () => [
  fact("project", "project", "Steve Biko Academic Hospital ward extension"),
  fact("need_evidence", "need", "Public tender notes heavy MEP services installation in occupied wards"),
  fact("need_evidence", "need", "Prefabricated steel procurement on a fast-track programme"),
];

function valid(out: GenerationOutput, inp: GenerationInput, settings = S) {
  return validateOutreachEmail(out, inp, settings, settings.exposures);
}

describe("Maputo schedule", () => {
  // Wednesday 21 Oct 2026. Maputo = UTC+2.
  it("only opens 09:00-15:00 batches on weekdays, in Maputo time not server UTC", () => {
    expect(batchSlot(at("2026-10-21T06:59:00Z"), S)).toBeNull(); // 08:59
    expect(batchSlot(at("2026-10-21T07:00:00Z"), S)?.toISOString()).toBe("2026-10-21T07:00:00.000Z"); // 09:00
    expect(batchSlot(at("2026-10-21T13:10:00Z"), S)?.toISOString()).toBe("2026-10-21T13:00:00.000Z"); // 15:10 → 15:00 batch
    expect(batchSlot(at("2026-10-21T13:55:00Z"), S)).toBeNull(); // 15:55: window closed
    expect(batchSlot(at("2026-10-21T14:05:00Z"), S)).toBeNull(); // 16:05
    expect(batchSlot(at("2026-10-24T08:00:00Z"), S)).toBeNull(); // Saturday
    expect(batchSlot(at("2026-10-25T08:00:00Z"), S)).toBeNull(); // Sunday
    expect(batchSlot(at("2026-09-24T08:00:00Z"), S)).toBeNull(); // Heritage Day (Thursday)
  });

  it("rolls follow-ups forward over nights and weekends, never early", () => {
    // Confirmed Friday 23 Oct 15:05 + 3 days = Monday 26 Oct 15:05 → Tuesday 09:00 (15:00 slot already started)
    expect(followUpDue(at("2026-10-23T13:05:00Z"), 3, S)?.toISOString()).toBe("2026-10-27T07:00:00.000Z");
    // Confirmed Wed 10:00 + 2 days = Fri 10:00 exactly → that batch
    expect(followUpDue(at("2026-10-21T08:00:00Z"), 2, S)?.toISOString()).toBe("2026-10-23T08:00:00.000Z");
    // Confirmed Thursday 11:20 + 2 days lands on Saturday → Monday 09:00
    expect(followUpDue(at("2026-10-22T09:20:00Z"), 2, S)?.toISOString()).toBe("2026-10-26T07:00:00.000Z");
    expect(nextBatchAtOrAfter(at("2026-10-21T08:20:00Z"), S, true)?.toISOString()).toBe("2026-10-21T08:00:00.000Z");
    expect(nextBatchAtOrAfter(at("2026-10-21T08:20:00Z"), S)?.toISOString()).toBe("2026-10-21T09:00:00.000Z");
  });

  it("computes the local day in Maputo", () => {
    const [s, e] = dayBounds(at("2026-10-21T22:30:00Z"), "Africa/Maputo"); // 00:30 on the 22nd locally
    expect(s.toISOString()).toBe("2026-10-21T22:00:00.000Z");
    expect(e.toISOString()).toBe("2026-10-22T22:00:00.000Z");
  });
});

describe("outreach config is data, not a template", () => {
  it("never invents wait days and starts with no booking link", () => {
    for (const c of cfg.campaigns) {
      expect(c.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5]);
      expect(c.steps.every((s) => s.waitDays == null)).toBe(true);
    }
    expect(S.bookingUrl).toBeNull();
    expect(S.hourlyCap).toBe(20);
    expect(S.dailyCap).toBe(140);
    expect(S.timezone).toBe("Africa/Maputo");
    expect(S.batchHours).toEqual([9, 10, 11, 12, 13, 14, 15]);
  });

  it("keeps the spec examples as labelled non-binding reference and puts the scope warning in the prompt", () => {
    const ref = loadReferenceExamples();
    expect(ref).toMatch(/NON-BINDING REFERENCE MATERIAL/);
    const prompt = systemPrompt(input({}, conResearch()), ref);
    expect(prompt).toContain(SCOPE_NOT_TEMPLATE);
    expect(prompt).toMatch(/REFERENCE MATERIAL \(NON-BINDING/);
  });

  it("no code path references the deleted UK/EU Airtable tables", () => {
    const retiredIds = /tblUwhxkMX3GmmjYL|tbl8khcFfgtOnw4ed/;
    const hits = ["src", "config", "prisma", "scripts"]
      .flatMap(filesUnder)
      .filter((path) => retiredIds.test(readFileSync(path, "utf8")));
    expect(hits).toEqual([]);
  });

  it("send and recipient states follow the transition tables", () => {
    expect(canMoveMember("STOPPED", "ACTIVE")).toBe(false);
    expect(canMoveMember("HOLD", "ACTIVE")).toBe(true);
    expect(canMoveSend("UNKNOWN", "APPROVED")).toBe(false); // an unknown attempt is never retried
    expect(canMoveSend("PROVIDER_ACCEPTED", "SENDING")).toBe(false);
  });
});

describe("evidence composer", () => {
  it("chooses the exposure the lead's own evidence points to, and a different one for a different lead", () => {
    const con = composeFromEvidence(input({}, conResearch()), S.exposures);
    const pm = composeFromEvidence(
      input(
        { lead: { firstName: "Johan", lastName: "Botha", title: "Programme Director", company: "Cape PM Partners", sector: null, city: "Cape Town", country: "ZA" }, campaign: { key: "SA-PM", name: "PM", icp: "" } },
        [fact("fact", "services", "Programme management for public sector clients"), fact("need_evidence", "need", "Monthly client reporting on risk across a portfolio of school projects")],
      ),
      S.exposures,
    );
    expect(con.decision).toBe("APPROVE");
    expect(pm.decision).toBe("APPROVE");
    expect(con.chosenCommercialExposure).not.toBe(pm.chosenCommercialExposure);
    expect(S.exposures.find((e) => e.id === pm.chosenCommercialExposure)?.campaigns).toContain("SA-PM");
    expect(pm.body).not.toMatch(/Steve Biko/);
  });

  it("writes five materially different emails, each with one 15-minute meeting CTA", () => {
    const research = conResearch();
    const prior: GenerationInput["priorMessages"] = [];
    for (let step = 1; step <= 5; step++) {
      const inp = input({ step, priorMessages: [...prior] }, research);
      const out = composeFromEvidence(inp, S.exposures);
      expect(out.decision).toBe("APPROVE");
      const v = valid(out, inp);
      expect(v.reasons).toEqual([]);
      expect(v.decision).toBe("APPROVE");
      expect(out.body.match(/15 minutes/g)).toHaveLength(1);
      prior.push({ step, subject: out.subject, body: out.body, exposure: out.chosenCommercialExposure });
    }
    expect(new Set(prior.map((p) => p.exposure)).size).toBe(5);
    expect(new Set(prior.map((p) => p.subject)).size).toBe(5);
    expect(prior.some((p) => /^(Imagine|Suppose)/m.test(p.body))).toBe(false);
  });

  it("asks for research instead of writing when need evidence is missing", () => {
    const out = composeFromEvidence(input({}, [fact("fact", "about", "General contractor in Gauteng")]), S.exposures);
    expect(out.decision).toBe("RESEARCH_REQUIRED");
    expect(valid(out, input({}, [])).decision).toBe("RESEARCH_REQUIRED");
  });

  it("ranks only exposures not already used", () => {
    const inp = input({ priorMessages: [{ step: 1, subject: "x", body: "y", exposure: "paid_rework" }] }, conResearch());
    expect(rankExposures(inp, S.exposures).map((r) => r.exposure.id)).not.toContain("paid_rework");
  });
});

describe("validator checks content against evidence", () => {
  const research = conResearch();
  const base = () => composeFromEvidence(input({}, research), S.exposures);
  const inp = input({}, research);
  const codes = (out: GenerationOutput, settings = S, i = inp) => valid(out, i, settings).reasons.map((r) => r.split(":")[0]);

  it("accepts the approved booking link in S01 and in later steps", () => {
    const settings = { ...S, bookingUrl: "https://klyronconsulting.com/en/book" };
    for (const step of [1, 3, 5]) {
      const i = input({ step, operationalContext: { ...inp.operationalContext, bookingUrl: settings.bookingUrl } }, research);
      const out = composeFromEvidence(i, S.exposures);
      expect(out.body).toContain("https://klyronconsulting.com/en/book");
      const v = valid(out, i, settings);
      expect(v.decision).toBe("APPROVE");
      expect(v.links).toEqual(["https://klyronconsulting.com/en/book"]);
    }
  });

  it("holds unapproved, shortened, insecure or multiple links", () => {
    const o = base();
    expect(codes({ ...o, body: `${o.body}\n\nhttps://calendly.com/someone` })).toContain("LINK_NOT_APPROVED");
    expect(codes({ ...o, body: `${o.body}\n\nhttps://bit.ly/abc` })).toContain("LINK_SHORTENER");
    expect(codes({ ...o, body: `${o.body}\n\nhttp://klyronconsulting.com/en` })).toContain("LINK_NOT_HTTPS");
    expect(codes({ ...o, body: `${o.body}\n\nhttps://klyronconsulting.com/a https://klyronconsulting.com/b` })).toContain("MULTIPLE_LINKS");
  });

  it("holds misleading subjects", () => {
    const o = base();
    expect(codes({ ...o, subject: `Re: ${o.subject}` })).toContain("MISLEADING_SUBJECT");
    expect(codes({ ...o, subject: "URGENT: coordination issue" })).toContain("MISLEADING_SUBJECT");
    expect(codes({ ...o, subject: "Following our conversation" })).toContain("MISLEADING_SUBJECT");
    expect(codes({ ...o, subject: "Stop wasting money on rework!" })).toContain("MISLEADING_SUBJECT");
  });

  it("holds invented projects, numbers, events and prior contact", () => {
    const o = base();
    expect(codes({ ...o, body: o.body.replace("Hi Thandi,", "Hi Thandi,\n\nOn the Sandton Gateway tower,") })).toContain("UNSUPPORTED_REFERENCE");
    expect(codes({ ...o, body: o.body.replace("Hi Thandi,", "Hi Thandi, rework costs contractors 12% of turnover.") })).toContain("UNSUPPORTED_NUMBER");
    expect(codes({ ...o, body: o.body.replace("Hi Thandi,", "Hi Thandi, I noticed your recent delays on site.") })).toEqual(expect.arrayContaining(["ASSERTS_UNVERIFIED_EVENT"]));
    expect(codes({ ...o, body: o.body.replace("Hi Thandi,", "Hi Thandi, as discussed last week,") })).toContain("IMPLIES_PRIOR_CONTACT");
    expect(codes({ ...o, body: `${o.body} We guarantee zero rework.` })).toContain("UNSUPPORTED_GUARANTEE");
    expect(codes({ ...o, subject: "Installation interfaces — [verified project]" })).toContain("PLACEHOLDER_LEFT");
  });

  it("requires exactly one specific 15-minute meeting CTA", () => {
    const o = base();
    expect(codes({ ...o, body: o.body.replace(/Would 15 minutes[^?]*\?/, "Would you like to learn more?") })).toEqual(expect.arrayContaining(["NO_MEETING_CTA", "WEAK_CTA"]));
    expect(codes({ ...o, body: `${o.body}\n\nOr could we have a 15-minute call on Friday?` })).toContain("MULTIPLE_CTAS");
  });

  it("checks the recipient, the evidence IDs and the model's own decision", () => {
    const o = base();
    expect(codes({ ...o, body: o.body.replace("Hi Thandi", "Hi Sipho") })).toContain("WRONG_RECIPIENT");
    expect(codes({ ...o, supportingEvidenceIds: ["someone-elses-fact"] })).toContain("UNKNOWN_EVIDENCE_ID");
    expect(valid({ ...o, decision: "HOLD", riskFlags: ["unsure"] }, inp).decision).toBe("HOLD");
    expect(valid({ ...o, supportingEvidenceIds: [] }, inp).decision).toBe("RESEARCH_REQUIRED");
  });

  it("holds repetition of an earlier step", () => {
    const o = base();
    const i = input({ step: 2, priorMessages: [{ step: 1, subject: o.subject, body: o.body, exposure: o.chosenCommercialExposure }] }, research);
    expect(codes(o, S, i)).toEqual(expect.arrayContaining(["REPEATED_EXPOSURE", "REPEATED_SUBJECT", "TOO_SIMILAR_TO_PRIOR"]));
  });

  it("holds out-of-range length and contact details", () => {
    const o = base();
    expect(codes({ ...o, body: "Hi Thandi, would 15 minutes this week help?" })).toContain("WORD_COUNT");
    expect(codes({ ...o, body: `${o.body}\nCall me on +27 82 123 4567 or mario@elsewhere.example` })).toContain("CONTACT_DETAILS");
  });
});
