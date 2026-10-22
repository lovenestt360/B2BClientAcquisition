import { AppError } from "../errors";
import { assertCanAutomate } from "./gate";
import type { CallHandoff, MessagingProvider, OutboundSms, ProviderCapabilities, ProviderRuntimeConfig, SmsHandoff, VoiceProvider } from "./types";

/**
 * Placeholders for future pay-as-you-go integrations. They exist so the CRM, campaign and
 * compliance layers never change when a real vendor is added: implement `prepareSend` /
 * `prepareCall` against the vendor API and keep the gate.
 */
abstract class GatedAutomatedProvider {
  constructor(protected cfg: ProviderRuntimeConfig) {}
  protected gate(): never {
    assertCanAutomate(this.cfg);
    throw new AppError(`${this.cfg.key}: no vendor integration has been implemented yet`, "not_configured", 501);
  }
}

export class BusinessSmsApiAdapter extends GatedAutomatedProvider implements MessagingProvider {
  readonly key = "business_sms_api";
  readonly capabilities: ProviderCapabilities = {
    kinds: ["SMS"],
    mode: "AUTOMATED",
    automatedSend: true,
    deliveryReceipts: true,
    inbound: "webhook",
    callAudioAccess: false,
    callRecording: false,
    supportedCountries: ["ZA"],
    limitations: [
      "Future: needs a licensed South African bulk-SMS aggregator account (pay-as-you-go) and a registered sender ID.",
      "Disabled until the env flag, enablement and authorisation reference are all set.",
    ],
  };
  validateRecipient() {
    return null;
  }
  async prepareSend(_msg: OutboundSms): Promise<SmsHandoff> {
    return this.gate();
  }
}

export class AndroidSmsGatewayAdapter extends GatedAutomatedProvider implements MessagingProvider {
  readonly key = "android_sms_gateway";
  readonly capabilities: ProviderCapabilities = {
    kinds: ["SMS"],
    mode: "AUTOMATED",
    automatedSend: true,
    deliveryReceipts: true,
    inbound: "webhook",
    callAudioAccess: false,
    callRecording: false,
    supportedCountries: ["ZA"],
    limitations: [
      "Future: a self-hosted Android SMS gateway app on a dedicated handset. Many consumer prepaid terms prohibit automated or bulk sending, so get written carrier permission first.",
      "Never used as a SIM-box or for grey-route termination.",
    ],
  };
  validateRecipient() {
    return null;
  }
  async prepareSend(_msg: OutboundSms): Promise<SmsHandoff> {
    return this.gate();
  }
}

export class AsteriskSipAiAdapter extends GatedAutomatedProvider implements VoiceProvider {
  readonly key = "asterisk_sip_ai";
  readonly capabilities: ProviderCapabilities = {
    kinds: ["VOICE"],
    mode: "AUTOMATED",
    automatedSend: true,
    deliveryReceipts: false,
    inbound: "webhook",
    callAudioAccess: true,
    callRecording: false,
    supportedCountries: ["ZA"],
    limitations: [
      "Future: needs a business SIP trunk from a licensed operator that authorises AI calling. Never connect a consumer SIM to a PBX.",
      "Asterisk ARI + externalMedia for bidirectional audio. See docs/VOICE.md.",
    ],
  };
  validateRecipient() {
    return null;
  }
  async prepareCall(): Promise<CallHandoff> {
    return this.gate();
  }
}

/**
 * Authorisation holder for scheduled email sequences (Hostinger SMTP). Sending itself lives in
 * server/outreach; this row only carries enablement and the recorded authorisation so the same
 * automation gate applies.
 */
export class EmailSequenceAdapter extends GatedAutomatedProvider implements MessagingProvider {
  readonly key = "email_sequences";
  readonly capabilities: ProviderCapabilities = {
    kinds: ["EMAIL"],
    mode: "AUTOMATED",
    automatedSend: true,
    deliveryReceipts: false,
    inbound: "none",
    callAudioAccess: false,
    callRecording: false,
    supportedCountries: ["ZA"],
    limitations: [
      "Sends approved sequence emails in Maputo business-hour batches through your Hostinger mailbox.",
      "SMTP acceptance is ACCEPTED only, never proof of inbox delivery.",
      "Also needs Launch Command = Start and OUTREACH_LIVE_SEND=true; otherwise every batch is a dry run.",
      "Authorisation reference: record your legal sign-off for the POPIA permission basis.",
    ],
  };
  validateRecipient() {
    return null;
  }
  async prepareSend(): Promise<SmsHandoff> {
    return this.gate();
  }
}
