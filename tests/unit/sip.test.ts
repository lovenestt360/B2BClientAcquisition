import { describe, expect, it } from "vitest";
import { buildRtp, framePcm, parseRtp } from "@/server/voice/sip/rtp";
import { AriClient } from "@/server/voice/sip/ari";

describe("RTP framing", () => {
  it("round-trips a packet", () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const pkt = buildRtp({ payloadType: 118, sequence: 65535, timestamp: 0xfffffff0, ssrc: 42, marker: true, payload });
    expect(parseRtp(pkt)).toEqual({ version: 2, payloadType: 118, sequence: 65535, timestamp: 0xfffffff0, ssrc: 42, marker: true, payload });
  });
  it("frames PCM into padded 20 ms chunks", () => {
    const frames = framePcm(Buffer.alloc(1000, 1));
    expect(frames.map((f) => f.length)).toEqual([640, 640]);
    expect(frames[1][400]).toBe(0);
  });
  it("rejects malformed packets", () => {
    expect(() => parseRtp(Buffer.alloc(4))).toThrow(/short/);
  });
});

describe("AriClient gating", () => {
  it("never reaches Asterisk without authorisation", async () => {
    process.env.ALLOW_AUTOMATED_OUTREACH = "false";
    let called = false;
    const fake = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    const ari = new AriClient(
      { url: "http://asterisk/ari", user: "u", password: "p", app: "ai", trunk: "trunk", mediaHost: "media:4000" },
      { key: "asterisk_sip_ai", enabled: true, mode: "AUTOMATED", carrierAuthorized: false, carrierAuthRef: null, settings: {} },
      fake,
    );
    await expect(ari.originate("+27821234567", "c1")).rejects.toThrow(/Automated outreach blocked/);
    expect(called).toBe(false);
  });
});
