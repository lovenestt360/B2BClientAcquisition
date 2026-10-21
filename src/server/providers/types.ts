import type { ProviderKind, ProviderMode } from "@prisma/client";

export interface ProviderCapabilities {
  kinds: ProviderKind[];
  mode: ProviderMode;
  /** Can the system send/call without a human performing the action on a device? */
  automatedSend: boolean;
  /** Does the provider give independent delivery evidence (DLRs)? */
  deliveryReceipts: boolean;
  inbound: "manual_entry" | "webhook" | "none";
  /** Can the system hear or process call audio? */
  callAudioAccess: boolean;
  callRecording: boolean;
  supportedCountries: string[];
  limitations: string[];
}

export interface OutboundSms {
  to: string; // E.164
  body: string;
}

/** What a send attempt hands back. Manual providers hand the action to a human. */
export type SmsHandoff =
  | { kind: "native_app"; url: string; copyText: string }
  | { kind: "submitted"; providerMessageId: string; state: "ATTEMPTED" | "ACCEPTED" };

export type CallHandoff =
  | { kind: "native_dialer"; url: string }
  | { kind: "sandbox" }
  | { kind: "originated"; providerCallId: string };

export interface MessagingProvider {
  readonly key: string;
  readonly capabilities: ProviderCapabilities;
  validateRecipient(e164: string): string | null; // error or null
  prepareSend(msg: OutboundSms, opts?: { platform?: "ios" | "android" | "other" }): Promise<SmsHandoff>;
}

export interface VoiceProvider {
  readonly key: string;
  readonly capabilities: ProviderCapabilities;
  validateRecipient(e164: string): string | null;
  prepareCall(to: string | null): Promise<CallHandoff>;
}

export interface ProviderRuntimeConfig {
  key: string;
  enabled: boolean;
  mode: ProviderMode;
  carrierAuthorized: boolean;
  carrierAuthRef: string | null;
  settings: Record<string, unknown>;
}
