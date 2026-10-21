import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { isAutoReply, parseBounce, ruleLabel, stripQuoted } from "@/server/email/parse";
import { buildSimulatedRaw } from "@/server/email/simulate";
import { composeEmailBody, listUnsubscribeHeader, newMessageId, validateEmailDraft } from "@/server/email/compose";
import { wasDefinitelyNotSent } from "@/server/email/transport";
import { keywordLabel } from "@/server/ai/classify";

const out = { messageId: "orig-123@demo.example", fromAddress: "me@demo.example", toAddress: "lead@corp.example", subject: "Quick question" };
const sender = { businessName: "Acme Ops", optOutText: "Reply STOP to opt out" };

describe("inbound parsing", () => {
  it("parses a DSN bounce: original Message-ID, recipient and hard 5.1.1", async () => {
    const b = parseBounce(await simpleParser(buildSimulatedRaw("bounce", out)));
    expect(b).toEqual({ originalMessageId: "orig-123@demo.example", recipient: "lead@corp.example", code: "5.1.1", type: "hard" });
  });
  it("does not treat a normal reply as a bounce; detects auto-replies", async () => {
    const reply = await simpleParser(buildSimulatedRaw("interested", out));
    expect(parseBounce(reply)).toBeNull();
    expect(isAutoReply(reply)).toBe(false);
    expect(isAutoReply(await simpleParser(buildSimulatedRaw("out_of_office", out)))).toBe(true);
    expect(isAutoReply(await simpleParser(Buffer.from("From: a@b.example\r\nSubject: Out of Office: back Monday\r\n\r\nhi")))).toBe(true);
  });
  it("strips quoted history before classifying", () => {
    const t = "Sounds good, call me.\n\nOn Tue, 21 Oct 2026, Me wrote:\n> Please unsubscribe here\n> old text";
    expect(stripQuoted(t)).toBe("Sounds good, call me.");
    expect(ruleLabel(stripQuoted(t))).toBeNull();
    expect(ruleLabel("Please remove me from your list")).toBe("unsubscribe");
  });
  it("keyword classifier", () => {
    expect(keywordLabel("Sounds good, let's chat Tuesday")).toBe("interested");
    expect(keywordLabel("No thanks, not interested")).toBe("not_interested");
    expect(keywordLabel("How much does it cost?")).toBe("question");
    expect(keywordLabel("Noted.")).toBe("other");
  });
});

describe("composition", () => {
  it("adds signature, sender identity and unsubscribe; validates", () => {
    const body = composeEmailBody("Hi Thandi,\n\nQuick question?", { fromName: "Sam" }, sender);
    expect(body).toBe('Hi Thandi,\n\nQuick question?\n\nSam\nAcme Ops\n\nTo stop receiving these emails, reply with "unsubscribe".');
    expect(validateEmailDraft("Hello", body, sender)).toEqual([]);
    expect(validateEmailDraft("", "Hi", sender)).toEqual(["subject is required", "email must identify the sender business", "email must tell the recipient how to unsubscribe"]);
    expect(listUnsubscribeHeader("me@acme.example")).toBe("<mailto:me@acme.example?subject=unsubscribe>");
    expect(newMessageId("me@acme.example")).toMatch(/^[0-9a-f-]{36}@acme\.example$/);
  });
  it("knows which SMTP errors mean 'definitely not sent'", () => {
    expect(wasDefinitelyNotSent({ code: "ECONNECTION" })).toBe(true);
    expect(wasDefinitelyNotSent({ code: "EENVELOPE" })).toBe(true);
    expect(wasDefinitelyNotSent({ code: "EMESSAGE", command: "DATA" })).toBe(false);
    expect(wasDefinitelyNotSent(new Error("socket hang up after DATA"))).toBe(false);
  });
});
