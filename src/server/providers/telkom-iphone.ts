import { validateZaMobile } from "../phone";
import type { CallHandoff, MessagingProvider, OutboundSms, ProviderCapabilities, SmsHandoff, VoiceProvider } from "./types";

/**
 * Telkom South Africa prepaid line (eSIM) in the user's iPhone.
 *
 * This adapter never sends or dials anything itself. It prepares iOS URL-scheme hand-offs
 * (sms: / tel:) that the human opens on their own iPhone, where the native Messages / Phone
 * apps perform the action over the carrier network and are billed to existing airtime.
 * It has no access to call audio, call recording, delivery reports or inbound SMS.
 */
export class TelkomPrepaidIPhoneAdapter implements MessagingProvider, VoiceProvider {
  static readonly LIMITATIONS = [
    "You send each SMS yourself in iPhone Messages; the platform cannot send automatically.",
    "No delivery reports: after you confirm sending, delivery stays UNKNOWN.",
    "iPhone 'Delivered' labels apply to iMessage, not SMS. They are not SMS delivery evidence.",
    "Inbound replies are not visible to the platform; record them manually.",
    "Calls are placed in the native Phone app. The platform has no access to call audio and does not record calls.",
    "South African (+27) mobile numbers only on this line.",
    "Costs come from prepaid airtime. Spend is tracked from your entries and rate estimates only.",
  ];

  readonly capabilities: ProviderCapabilities;

  constructor(
    readonly key: "iphone_manual_sms" | "iphone_manual_call",
  ) {
    this.capabilities = {
      kinds: [key === "iphone_manual_sms" ? "SMS" : "VOICE"],
      mode: "MANUAL",
      automatedSend: false,
      deliveryReceipts: false,
      inbound: "manual_entry",
      callAudioAccess: false,
      callRecording: false,
      supportedCountries: ["ZA"],
      limitations: TelkomPrepaidIPhoneAdapter.LIMITATIONS,
    };
  }

  validateRecipient(e164: string): string | null {
    const r = validateZaMobile(e164);
    return r.valid ? null : (r.error ?? "invalid recipient");
  }

  async prepareSend(msg: OutboundSms, opts: { platform?: "ios" | "android" | "other" } = {}): Promise<SmsHandoff> {
    const err = this.validateRecipient(msg.to);
    if (err) throw new Error(err);
    return { kind: "native_app", url: buildSmsUrl(msg.to, msg.body, opts.platform ?? "ios"), copyText: msg.body };
  }

  async prepareCall(to: string | null): Promise<CallHandoff> {
    if (!to) throw new Error("no number to dial");
    const err = this.validateRecipient(to);
    if (err) throw new Error(err);
    return { kind: "native_dialer", url: buildTelUrl(to) };
  }
}

/**
 * iOS Messages accepts `sms:<number>&body=<text>`; Android and newer iOS accept `?body=`.
 * An empty number opens a new message with only the body (used for simulated leads).
 */
export function buildSmsUrl(to: string | null, body: string, platform: "ios" | "android" | "other" = "ios"): string {
  const sep = platform === "ios" ? "&" : "?";
  return `sms:${to ?? ""}${sep}body=${encodeURIComponent(body)}`;
}

export function buildTelUrl(to: string): string {
  return `tel:${to.replace(/[^\d+]/g, "")}`;
}
