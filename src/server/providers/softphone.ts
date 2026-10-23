import { env } from "@/lib/env";
import { AppError } from "../errors";
import type { CallHandoff, ProviderCapabilities, VoiceProvider } from "./types";

/**
 * Browser softphone on a business SIP/VoIP account (WebRTC over WSS, JsSIP in the browser).
 *
 * A human places and conducts every call; the platform never dials by itself, so this is a
 * MANUAL provider. Because the call runs in the browser, the live call assist hears both sides
 * as separate streams (your microphone, the lead's audio). Audio is transcribed and discarded.
 * Credentials live only in the environment (SIP_WSS_URL, SIP_URI, SIP_PASSWORD).
 */
export class SipSoftphoneAdapter implements VoiceProvider {
  readonly key = "sip_softphone";
  readonly capabilities: ProviderCapabilities = {
    kinds: ["VOICE"],
    mode: "MANUAL",
    automatedSend: false,
    deliveryReceipts: false,
    inbound: "none",
    callAudioAccess: true, // only the browser's own WebRTC call, never cellular audio
    callRecording: false,
    supportedCountries: ["*"],
    limitations: [
      "You place and conduct every call yourself in the browser; the platform never dials on its own.",
      "Needs a business SIP/VoIP account with WebRTC (WSS) access. Never a consumer SIM in a gateway or PBX.",
      "Use a dedicated extension for the softphone: its password is handed to your logged-in browser.",
      "Live assist transcribes only after you tell the lead (and, outside South Africa, they agree). Raw audio is never stored.",
    ],
  };

  validateRecipient(e164: string): string | null {
    return /^\+[1-9]\d{7,14}$/.test(e164) ? null : "Number must be in international E.164 format";
  }

  async prepareCall(to: string | null): Promise<CallHandoff> {
    if (!to) throw new AppError("No number to dial");
    const err = this.validateRecipient(to);
    if (err) throw new AppError(err);
    const cfg = softphoneEnv();
    if (!cfg) throw new AppError("Softphone is not configured: set SIP_WSS_URL, SIP_URI and SIP_PASSWORD", "not_configured", 501);
    return { kind: "softphone", target: `sip:${to}@${cfg.domain}` };
  }
}

export interface SoftphoneCredentials {
  wssUrl: string;
  uri: string;
  password: string;
  domain: string;
  displayName: string | null;
}

export function softphoneEnv(): SoftphoneCredentials | null {
  const e = env();
  if (!e.SIP_WSS_URL || !e.SIP_URI || !e.SIP_PASSWORD) return null;
  const domain = e.SIP_URI.replace(/^sips?:/, "").split("@")[1];
  if (!domain) return null;
  return { wssUrl: e.SIP_WSS_URL, uri: e.SIP_URI, password: e.SIP_PASSWORD, domain, displayName: e.SIP_DISPLAY_NAME ?? null };
}
