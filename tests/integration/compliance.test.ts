import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, grantConsent, makeContact, resetDb, setupOutreach } from "./helpers";
import { checkEligibility } from "@/server/compliance/eligibility";
import { addSuppression, recordPermission, setEmergencyStop } from "@/server/compliance/controls";
import { setClock } from "@/server/clock";

beforeEach(resetDb);
afterEach(() => setClock(null));

describe("checkEligibility (POPIA / CPA)", () => {
  it("blocks SMS marketing without consent and allows it with consent", async () => {
    await setupOutreach();
    const c = await makeContact();
    const before = await checkEligibility(db, { contactId: c.id, channel: "SMS" });
    expect(before.eligible).toBe(false);
    expect(before.reasons[0]).toMatch(/POPIA s69/);
    await grantConsent(c.id);
    expect(await checkEligibility(db, { contactId: c.id, channel: "SMS" })).toMatchObject({ eligible: true, basis: "consent" });
  });

  it("allows existing customers and a single consent request", async () => {
    const { admin } = await setupOutreach();
    const cust = await makeContact({ isExistingCustomer: true });
    expect(await checkEligibility(db, { contactId: cust.id, channel: "SMS" })).toMatchObject({ eligible: true, basis: "existing_customer" });

    const c = await makeContact();
    expect(await checkEligibility(db, { contactId: c.id, channel: "SMS", purpose: "consent_request" })).toMatchObject({ eligible: true, basis: "consent_request" });
    await recordPermission(db, { contactId: c.id, channel: "SMS", status: "CONSENT_REQUESTED", evidence: "consent SMS sent" }, admin.id);
    const again = await checkEligibility(db, { contactId: c.id, channel: "SMS", purpose: "consent_request" });
    expect(again.eligible).toBe(false);
    expect(again.reasons[0]).toMatch(/only be requested once/);
  });

  it("withdrawal, suppression and emergency stop all block", async () => {
    const { admin, actor } = await setupOutreach();
    const c = await makeContact();
    await grantConsent(c.id);
    await recordPermission(db, { contactId: c.id, channel: "SMS", status: "WITHDRAWN", evidence: "replied STOP", capturedAt: new Date("2026-10-10") }, admin.id);
    expect((await checkEligibility(db, { contactId: c.id, channel: "SMS" })).reasons[0]).toMatch(/withdrawn/);

    const d = await makeContact();
    await grantConsent(d.id);
    await addSuppression(db, { value: d.phoneNumbers[0].e164, reason: "manual" }, admin.id);
    expect((await checkEligibility(db, { contactId: d.id, channel: "SMS", address: d.phoneNumbers[0].e164 })).reasons[0]).toMatch(/suppressed/);

    const e = await makeContact();
    await grantConsent(e.id);
    await setEmergencyStop(db, true, actor, "test");
    expect((await checkEligibility(db, { contactId: e.id, channel: "SMS" })).reasons[0]).toMatch(/emergency stop/);
    await expect(setEmergencyStop(db, false, { id: admin.id, role: "OPERATOR" })).rejects.toThrow(/manager/);
    await setEmergencyStop(db, false, actor);
    expect((await checkEligibility(db, { contactId: e.id, channel: "SMS" })).eligible).toBe(true);
  });

  it("human calls in ZA respect opt-outs and contact hours but not s69 consent", async () => {
    await setupOutreach();
    const c = await makeContact();
    expect(await checkEligibility(db, { contactId: c.id, channel: "VOICE_MANUAL" })).toMatchObject({ eligible: true, basis: "non_electronic" });
    const sunday = await checkEligibility(db, { contactId: c.id, channel: "VOICE_MANUAL", now: new Date("2026-10-25T09:00:00Z") });
    expect(sunday.reasons).toEqual(["CPA Reg 4: no direct marketing on Sundays"]);
    const drafting = await checkEligibility(db, { contactId: c.id, channel: "VOICE_MANUAL", now: new Date("2026-10-25T09:00:00Z"), ignoreContactWindow: true });
    expect(drafting.eligible).toBe(true);
  });

  it("unknown-country contacts are strict opt-in for calls too", async () => {
    await setupOutreach();
    const c = await makeContact({ country: null });
    const r = await checkEligibility(db, { contactId: c.id, channel: "VOICE_MANUAL" });
    expect(r.eligible).toBe(false);
    expect(r.warnings[0]).toMatch(/country unknown/);
  });
});
