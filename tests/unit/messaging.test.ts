import { describe, expect, it } from "vitest";
import { composeSms, findInventedDetails, generateSmsCore, smsSegments, validateSmsBody } from "@/server/ai/drafts";
import { MockLlmClient, type LlmClient } from "@/server/ai/llm";
import { assertDeliveryTransition, assertDraftTransition } from "@/server/messaging/states";
import { TelkomPrepaidIPhoneAdapter, buildSmsUrl, buildTelUrl } from "@/server/providers/telkom-iphone";
import { automationBlockers } from "@/server/providers/gate";

const sender = { businessName: "Acme Ops", optOutText: "Reply STOP to opt out" };

describe("SMS content", () => {
  it("composes sender id + body + opt-out and validates it", () => {
    const body = composeSms("Hi Thandi, quick question about fleet admin?", sender);
    expect(body).toBe("Acme Ops: Hi Thandi, quick question about fleet admin? Reply STOP to opt out");
    expect(validateSmsBody(body, sender)).toEqual([]);
    expect(validateSmsBody("Hi Thandi", sender)).toEqual(expect.arrayContaining(["message must identify the sender", expect.stringMatching(/opt-out/)]));
    expect(validateSmsBody("x", { ...sender, businessName: "" })[0]).toMatch(/business name/);
  });

  it("counts GSM-7 and UCS-2 segments", () => {
    expect(smsSegments("a".repeat(160))).toMatchObject({ encoding: "GSM-7", segments: 1 });
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
    expect(smsSegments("€".repeat(80)).length).toBe(160); // extension chars count double
    expect(smsSegments("Hi 👋")).toMatchObject({ encoding: "UCS-2", segments: 1 });
    expect(smsSegments("👋".repeat(71)).segments).toBe(2);
  });

  it("detects invented links, emails and phone numbers", () => {
    expect(findInventedDetails("Call 082 123 4567 or visit https://x.example or mail a@b.example")).toHaveLength(3);
    expect(findInventedDetails("Open to a 15-min chat this week?")).toEqual([]);
  });

  it("falls back to a template when the model invents contact details or fails", async () => {
    const bad: LlmClient = { name: "bad", chat: async () => "Call me on 082 555 1234!" };
    const r = await generateSmsCore(bad, { firstName: "Sipho", company: "Fynbos", purpose: "marketing" }, sender);
    expect(r.generatedBy).toBe("template:v1");
    expect(findInventedDetails(r.core)).toEqual([]);
    const down: LlmClient = { name: "down", chat: async () => Promise.reject(new Error("offline")) };
    expect((await generateSmsCore(down, { firstName: "A", purpose: "consent_request" }, sender)).core).toMatch(/Reply YES/);
    const ok = await generateSmsCore(new MockLlmClient(), { firstName: "Aisha", company: "Fynbos", purpose: "marketing" }, sender);
    expect(ok).toMatchObject({ generatedBy: "mock:rules", core: expect.stringContaining("Aisha") });
  });
});

describe("state machines", () => {
  it("enforces draft workflow", () => {
    expect(() => assertDraftTransition("PENDING_APPROVAL", "HANDED_OFF")).toThrow(/Cannot move/);
    expect(() => assertDraftTransition("APPROVED", "HANDED_OFF")).not.toThrow();
    expect(() => assertDraftTransition("SENT_CONFIRMED", "APPROVED")).toThrow();
  });
  it("never allows DELIVERED without a receipt", () => {
    expect(() => assertDeliveryTransition("NOT_ATTEMPTED", "UNKNOWN", "user_attestation")).not.toThrow();
    expect(() => assertDeliveryTransition("UNKNOWN", "DELIVERED", "user_attestation")).toThrow(/independent evidence/);
    expect(() => assertDeliveryTransition("ACCEPTED", "DELIVERED", "smtp_250")).toThrow(/independent evidence/);
    expect(() => assertDeliveryTransition("ACCEPTED", "DELIVERED", "recipient_reply")).not.toThrow();
    expect(() => assertDeliveryTransition("ACCEPTED", "DELIVERED", "provider_receipt")).not.toThrow();
    expect(() => assertDeliveryTransition("DELIVERED", "FAILED", "provider_receipt")).toThrow();
  });
});

describe("TelkomPrepaidIPhoneAdapter", () => {
  const sms = new TelkomPrepaidIPhoneAdapter("iphone_manual_sms");
  it("declares manual-only capabilities", () => {
    expect(sms.capabilities).toMatchObject({ mode: "MANUAL", automatedSend: false, deliveryReceipts: false, callAudioAccess: false, callRecording: false, supportedCountries: ["ZA"] });
  });
  it("builds iOS sms: and tel: URLs", async () => {
    expect(buildSmsUrl("+27821234567", "Hi & bye?", "ios")).toBe("sms:+27821234567&body=Hi%20%26%20bye%3F");
    expect(buildSmsUrl("+27821234567", "Hi", "android")).toBe("sms:+27821234567?body=Hi");
    expect(buildTelUrl("+27 82 123 4567")).toBe("tel:+27821234567");
    await expect(sms.prepareSend({ to: "+27821234567", body: "x" })).resolves.toMatchObject({ kind: "native_app" });
  });
  it("only accepts South African mobiles", async () => {
    await expect(sms.prepareSend({ to: "+447911123456", body: "x" })).rejects.toThrow(/\+27/);
    await expect(new TelkomPrepaidIPhoneAdapter("iphone_manual_call").prepareCall("+27111234567")).rejects.toThrow(/mobile/);
  });
});

describe("automation gate", () => {
  it("requires env flag, enablement and authorisation", () => {
    process.env.ALLOW_AUTOMATED_OUTREACH = "false";
    const cfg = { key: "business_sms_api", enabled: false, mode: "AUTOMATED" as const, carrierAuthorized: false, carrierAuthRef: null, settings: {} };
    expect(automationBlockers(cfg)).toHaveLength(3);
    process.env.ALLOW_AUTOMATED_OUTREACH = "true";
    expect(automationBlockers({ ...cfg, enabled: true, carrierAuthorized: true, carrierAuthRef: "TKM-2026-001" })).toEqual([]);
    process.env.ALLOW_AUTOMATED_OUTREACH = "false";
  });
});
