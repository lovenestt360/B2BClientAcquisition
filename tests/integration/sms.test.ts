import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, grantConsent, makeContact, resetDb, setupOutreach } from "./helpers";
import { approveDraft, confirmSendOutcome, generateSmsDrafts, handOffDraft, recordManualReply, rejectDraft } from "@/server/messaging/sms";
import { setEmergencyStop } from "@/server/compliance/controls";
import { enqueue } from "@/server/jobs";
import { setClock } from "@/server/clock";
import { assertDeliveryTransition } from "@/server/messaging/states";

beforeEach(resetDb);
afterEach(() => setClock(null));

const events = async (draftId: string) => (await db.smsEvent.findMany({ where: { draftId }, orderBy: { occurredAt: "asc" } })).map((e) => `${e.type}:${e.evidence}`);

describe("iPhone manual SMS workflow", () => {
  it("draft → approve → open Messages → user confirms: delivery stays UNKNOWN", async () => {
    const { admin, actor } = await setupOutreach();
    const line = await db.carrierLine.findFirstOrThrow();
    await db.carrierLine.update({ where: { id: line.id }, data: { smsRateCents: 50 } });
    const c = await makeContact();
    await grantConsent(c.id);
    const skipped = await makeContact(); // no consent

    const report = await generateSmsDrafts(db, { contactIds: [c.id, skipped.id], userId: admin.id });
    expect(report.created).toHaveLength(1);
    expect(report.skipped[0].reasons[0]).toMatch(/POPIA/);

    const draft = await db.messageDraft.findUniqueOrThrow({ where: { id: report.created[0] } });
    expect(draft).toMatchObject({ status: "PENDING_APPROVAL", deliveryState: "NOT_ATTEMPTED", providerKey: "iphone_manual_sms", toAddress: c.phoneNumbers[0].e164 });
    expect(draft.body).toMatch(/^Acme Ops: .* Reply STOP to opt out$/);

    await expect(handOffDraft(db, draft.id, actor)).rejects.toThrow(/Cannot move draft from PENDING_APPROVAL/);
    await approveDraft(db, draft.id, actor);
    const h = await handOffDraft(db, draft.id, actor, "ios");
    expect(h.url).toBe(`sms:${c.phoneNumbers[0].e164}&body=${encodeURIComponent(draft.body)}`);
    expect(await handOffDraft(db, draft.id, actor)).toEqual(h); // tapping twice is idempotent
    expect((await db.messageDraft.findUniqueOrThrow({ where: { id: draft.id } })).deliveryState).toBe("NOT_ATTEMPTED");

    await confirmSendOutcome(db, draft.id, "sent", actor);
    await confirmSendOutcome(db, draft.id, "sent", actor); // idempotent
    const sent = await db.messageDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(sent).toMatchObject({ status: "SENT_CONFIRMED", deliveryState: "UNKNOWN" });
    expect(await events(draft.id)).toEqual(["DRAFT_CREATED:system", "APPROVED:system", "OPENED_IN_NATIVE_APP:system", "USER_CONFIRMED_SENT:user_attestation"]);
    expect(() => assertDeliveryTransition(sent.deliveryState, "DELIVERED", "user_attestation")).toThrow(/receipt/);

    const airtime = await db.airtimeEntry.findMany();
    expect(airtime).toEqual([expect.objectContaining({ kind: "sms_estimate", amountCents: -50, estimated: true })]);
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe("CONTACTED");
    expect(await db.auditLog.count({ where: { action: { startsWith: "sms." } } })).toBeGreaterThanOrEqual(4);
  });

  it("user-reported failure, 'did not send', rejection and content validation", async () => {
    const { admin, actor } = await setupOutreach();
    const c = await makeContact();
    await grantConsent(c.id);
    const [id] = (await generateSmsDrafts(db, { contactIds: [c.id], userId: admin.id })).created;
    await expect(approveDraft(db, id, actor, "Hi, call 082 999 1111 now")).rejects.toThrow(/identify the sender.*opt-out.*remove contact detail/);
    await approveDraft(db, id, actor, "Acme Ops: Hi Lead, quick chat this week? Reply STOP to opt out");
    await handOffDraft(db, id, actor);
    await confirmSendOutcome(db, id, "not_sent", actor);
    expect((await db.messageDraft.findUniqueOrThrow({ where: { id } })).status).toBe("APPROVED");
    await handOffDraft(db, id, actor);
    await confirmSendOutcome(db, id, "failed", actor);
    expect(await db.messageDraft.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "SEND_FAILED", deliveryState: "FAILED" });

    const d = await makeContact();
    await grantConsent(d.id);
    const [id2] = (await generateSmsDrafts(db, { contactIds: [d.id], userId: admin.id })).created;
    await rejectDraft(db, id2, actor, "tone");
    await expect(approveDraft(db, id2, actor)).rejects.toThrow(/Cannot move draft from REJECTED/);
  });

  it("drafting is idempotent per day, also through the job queue", async () => {
    const { admin } = await setupOutreach();
    const c = await makeContact();
    await grantConsent(c.id);
    const job = await enqueue(db, "sms.generate_drafts", { contactIds: [c.id], userId: admin.id }, "drafts:test-1");
    expect(job.status).toBe("succeeded");
    const again = await generateSmsDrafts(db, { contactIds: [c.id], userId: admin.id });
    expect(again.skipped[0].reasons).toEqual(["already drafted today"]);
    expect(await db.messageDraft.count()).toBe(1);
  });

  it("blocks hand-off outside contact hours, after opt-out reply, and under emergency stop", async () => {
    const { admin, actor } = await setupOutreach();
    const c = await makeContact();
    await grantConsent(c.id);
    const [id] = (await generateSmsDrafts(db, { contactIds: [c.id], userId: admin.id })).created;
    await approveDraft(db, id, actor);

    setClock(() => new Date("2026-10-21T19:30:00Z")); // 21:30 SAST
    await expect(handOffDraft(db, id, actor)).rejects.toThrow(/CPA Reg 4/);
    setClock(() => new Date("2026-10-21T08:00:00Z"));

    const r = await recordManualReply(db, { contactId: c.id, body: "STOP" }, actor);
    expect(r.optedOut).toBe(true);
    expect(await db.suppression.count({ where: { e164: c.phoneNumbers[0].e164 } })).toBe(1);
    expect((await db.messageDraft.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");

    const d = await makeContact();
    await grantConsent(d.id);
    const [id2] = (await generateSmsDrafts(db, { contactIds: [d.id], userId: admin.id })).created;
    await approveDraft(db, id2, actor);
    await setEmergencyStop(db, true, actor, "carrier complaint");
    expect((await db.messageDraft.findUniqueOrThrow({ where: { id: id2 } })).status).toBe("CANCELLED");
  });

  it("manual replies move engaged contacts forward", async () => {
    const { actor } = await setupOutreach();
    const c = await makeContact();
    await db.contact.update({ where: { id: c.id }, data: { stage: "CONTACTED" } });
    const r = await recordManualReply(db, { contactId: c.id, body: "Sounds interesting, call me Thursday" }, actor);
    expect(r.optedOut).toBe(false);
    expect(r.event).toMatchObject({ type: "INBOUND_REPLY_MANUAL", direction: "inbound", evidence: "user_attestation" });
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe("ENGAGED");
  });
});

describe("providers and simulation", () => {
  it("real providers are disabled by default", async () => {
    const { admin } = await setupOutreach({ enableIphone: false });
    const c = await makeContact();
    await grantConsent(c.id);
    await expect(generateSmsDrafts(db, { contactIds: [c.id], userId: admin.id })).rejects.toThrow(/disabled/);
    const rows = await db.providerConfig.findMany();
    expect(rows.filter((r) => r.enabled).map((r) => r.key).sort()).toEqual(["local_ai_sandbox", "simulated_sms"]);
  });

  it("automated providers stay blocked even when enabled", async () => {
    const { admin } = await setupOutreach();
    await db.providerConfig.update({ where: { key: "business_sms_api" }, data: { enabled: true } });
    const c = await makeContact();
    await grantConsent(c.id);
    await expect(generateSmsDrafts(db, { contactIds: [c.id], userId: admin.id, providerKey: "business_sms_api" })).rejects.toThrow(/ALLOW_AUTOMATED_OUTREACH.*authorisation/);
  });

  it("simulated provider only targets dummy leads and labels its fake receipt", async () => {
    const { admin, actor } = await setupOutreach();
    const real = await makeContact();
    const dummy = await makeContact({ isSimulated: true });
    await grantConsent(real.id);
    await grantConsent(dummy.id);
    const rep = await generateSmsDrafts(db, { contactIds: [real.id, dummy.id], userId: admin.id, providerKey: "simulated_sms" });
    expect(rep.skipped).toEqual([{ contactId: real.id, reasons: ["simulated providers may only target seeded dummy leads"] }]);
    await approveDraft(db, rep.created[0], actor);
    await handOffDraft(db, rep.created[0], actor);
    expect(await db.messageDraft.findUniqueOrThrow({ where: { id: rep.created[0] } })).toMatchObject({ status: "SENT_CONFIRMED", deliveryState: "DELIVERED" });
    expect(await events(rep.created[0])).toContain("PROVIDER_DELIVERY_REPORT:simulated_receipt");
  });

  it("iPhone hand-off for a dummy lead never uses the fictional number", async () => {
    const { admin, actor } = await setupOutreach();
    const dummy = await makeContact({ isSimulated: true });
    await grantConsent(dummy.id);
    const [id] = (await generateSmsDrafts(db, { contactIds: [dummy.id], userId: admin.id })).created;
    await approveDraft(db, id, actor);
    const h = await handOffDraft(db, id, actor);
    expect(h.url).toMatch(/^sms:&body=/);
    expect(h.url).not.toContain(dummy.phoneNumbers[0].e164);

    await db.carrierLine.updateMany({ data: { testNumberE164: "+27829990000" } });
    const h2 = await handOffDraft(db, id, actor);
    expect(h2.url).toMatch(/^sms:\+27829990000&body=/);
  });
});
