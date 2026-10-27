import { describe, expect, it } from "vitest";
import { evaluateQualification, type QualificationContact } from "@/server/crm/qualification";
import { updateContactStage } from "@/server/crm/contacts";

const complete = (over: Partial<QualificationContact> = {}): QualificationContact => ({
  isSimulated: false,
  companyId: "company-1",
  title: "Operations Director",
  country: "ZA",
  email: "director@example.com",
  emailSource: "import:batch-1",
  emailVerificationStatus: "Valid",
  sourceType: "import",
  sourceRef: "import:batch-1",
  phoneNumbers: [],
  ...over,
});

describe("contact qualification readiness", () => {
  it("accepts a complete imported contact without treating qualification as consent", () => {
    const result = evaluateQualification(complete());
    expect(result.ready).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it("lists missing company, role, country and reachable channel", () => {
    const result = evaluateQualification(complete({ companyId: null, title: null, country: null, email: null, emailSource: null }));
    expect(result.ready).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual(["company", "title", "country", "reachable"]);
  });

  it("rejects simulated, invalid-email and unsourced records", () => {
    const result = evaluateQualification(complete({ isSimulated: true, emailVerificationStatus: "Invalid", sourceRef: null, sourceType: "research" }));
    expect(result.ready).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual(["real", "reachable", "provenance"]);
  });

  it("enforces readiness on the server before moving to qualified", async () => {
    let updated = false;
    const db = {
      contact: {
        findUniqueOrThrow: async () => complete({ companyId: null }),
        update: async () => { updated = true; },
      },
    };
    await expect(updateContactStage(db as never, "contact-1", "QUALIFIED", "admin-1")).rejects.toThrow(/Company linked/);
    expect(updated).toBe(false);
  });
});
