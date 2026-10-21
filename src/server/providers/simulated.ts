import { randomUUID } from "node:crypto";
import type { CallHandoff, MessagingProvider, OutboundSms, ProviderCapabilities, SmsHandoff, VoiceProvider } from "./types";

/** Fake SMS provider for simulation mode. Only ever targets seeded dummy leads. */
export class SimulatedSmsAdapter implements MessagingProvider {
  readonly key = "simulated_sms";
  readonly capabilities: ProviderCapabilities = {
    kinds: ["SMS"],
    mode: "SIMULATED",
    automatedSend: true,
    deliveryReceipts: true,
    inbound: "none",
    callAudioAccess: false,
    callRecording: false,
    supportedCountries: ["*"],
    limitations: ["No real messages are sent. Receipts are fabricated by the simulator and labelled as simulated."],
  };
  validateRecipient() {
    return null;
  }
  async prepareSend(_msg: OutboundSms): Promise<SmsHandoff> {
    return { kind: "submitted", providerMessageId: `sim-${randomUUID()}`, state: "ACCEPTED" };
  }
}

/** Local voice sandbox: the conversation engine talks to you through your browser. */
export class LocalAiSandboxAdapter implements VoiceProvider {
  readonly key = "local_ai_sandbox";
  readonly capabilities: ProviderCapabilities = {
    kinds: ["VOICE"],
    mode: "SIMULATED",
    automatedSend: false,
    deliveryReceipts: false,
    inbound: "none",
    callAudioAccess: true, // browser microphone only, never cellular audio
    callRecording: false,
    supportedCountries: ["*"],
    limitations: [
      "Runs locally in your browser and on your server. No telephone network is involved.",
      "Audio comes from your browser microphone with your permission. Transcripts are stored; raw audio is not.",
    ],
  };
  validateRecipient() {
    return null;
  }
  async prepareCall(): Promise<CallHandoff> {
    return { kind: "sandbox" };
  }
}
