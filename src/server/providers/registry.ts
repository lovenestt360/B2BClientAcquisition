import type { Prisma, ProviderConfig, ProviderKind, ProviderMode } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError } from "../errors";
import { TelkomPrepaidIPhoneAdapter } from "./telkom-iphone";
import { LocalAiSandboxAdapter, SimulatedSmsAdapter } from "./simulated";
import { AndroidSmsGatewayAdapter, AsteriskSipAiAdapter, BusinessSmsApiAdapter, EmailSequenceAdapter } from "./future";
import { automationBlockers } from "./gate";
import type { MessagingProvider, ProviderRuntimeConfig, VoiceProvider } from "./types";

interface Definition {
  key: string;
  kind: ProviderKind;
  adapter: string;
  displayName: string;
  mode: ProviderMode;
  line?: string;
}

export const DEFINITIONS: Definition[] = [
  { key: "iphone_manual_sms", kind: "SMS", adapter: "TelkomPrepaidIPhoneAdapter", displayName: "iPhone Messages (Telkom prepaid)", mode: "MANUAL", line: "telkom_prepaid_iphone" },
  { key: "iphone_manual_call", kind: "VOICE", adapter: "TelkomPrepaidIPhoneAdapter", displayName: "iPhone Phone app (Telkom prepaid)", mode: "MANUAL", line: "telkom_prepaid_iphone" },
  { key: "simulated_sms", kind: "SMS", adapter: "SimulatedSmsAdapter", displayName: "Simulated SMS (dummy leads only)", mode: "SIMULATED" },
  { key: "local_ai_sandbox", kind: "VOICE", adapter: "LocalAiSandboxAdapter", displayName: "Local AI voice sandbox", mode: "SIMULATED" },
  { key: "business_sms_api", kind: "SMS", adapter: "BusinessSmsApiAdapter", displayName: "Business SMS API (future)", mode: "AUTOMATED" },
  { key: "android_sms_gateway", kind: "SMS", adapter: "AndroidSmsGatewayAdapter", displayName: "Android SMS gateway (future)", mode: "AUTOMATED" },
  { key: "asterisk_sip_ai", kind: "VOICE", adapter: "AsteriskSipAiAdapter", displayName: "Asterisk SIP AI calling (future)", mode: "AUTOMATED" },
  { key: "email_sequences", kind: "EMAIL", adapter: "EmailSequenceAdapter", displayName: "Scheduled email sequences (Hostinger)", mode: "AUTOMATED" },
];

export function toRuntime(c: ProviderConfig): ProviderRuntimeConfig {
  return {
    key: c.key,
    enabled: c.enabled,
    mode: c.mode,
    carrierAuthorized: c.carrierAuthorized,
    carrierAuthRef: c.carrierAuthRef,
    settings: (c.settings as Record<string, unknown>) ?? {},
  };
}

export function instantiate(c: ProviderConfig): MessagingProvider | VoiceProvider {
  const rt = toRuntime(c);
  switch (c.adapter) {
    case "TelkomPrepaidIPhoneAdapter":
      return new TelkomPrepaidIPhoneAdapter(c.key as "iphone_manual_sms" | "iphone_manual_call");
    case "SimulatedSmsAdapter":
      return new SimulatedSmsAdapter();
    case "LocalAiSandboxAdapter":
      return new LocalAiSandboxAdapter();
    case "BusinessSmsApiAdapter":
      return new BusinessSmsApiAdapter(rt);
    case "AndroidSmsGatewayAdapter":
      return new AndroidSmsGatewayAdapter(rt);
    case "AsteriskSipAiAdapter":
      return new AsteriskSipAiAdapter(rt);
    case "EmailSequenceAdapter":
      return new EmailSequenceAdapter(rt);
    default:
      throw new AppError(`Unknown adapter ${c.adapter}`);
  }
}

/**
 * Load a usable provider. Manual and simulated providers only need to be enabled;
 * automated providers must also pass the automation gate.
 */
export async function getProvider<T extends MessagingProvider | VoiceProvider>(db: Db, key: string) {
  const config = await db.providerConfig.findUnique({ where: { key }, include: { line: true } });
  if (!config) throw new AppError(`Provider ${key} is not configured`, "not_configured", 404);
  if (!config.enabled) throw new AppError(`Provider "${config.displayName}" is disabled. Enable it on the Providers page.`, "provider_disabled", 423);
  if (config.mode === "AUTOMATED") {
    const b = automationBlockers(toRuntime(config));
    if (b.length) throw new AppError(`Automated outreach blocked: ${b.join("; ")}`, "automation_blocked", 423);
  }
  return { config, provider: instantiate(config) as T };
}

export async function seedProviderRows(db: Db, opts: { simulation: boolean }) {
  const line = await db.carrierLine.upsert({
    where: { key: "telkom_prepaid_iphone" },
    update: {},
    create: { key: "telkom_prepaid_iphone", operator: "Telkom South Africa", plan: "prepaid", simType: "esim", device: "iPhone", country: "ZA" },
  });
  for (const d of DEFINITIONS) {
    await db.providerConfig.upsert({
      where: { key: d.key },
      update: {},
      create: {
        key: d.key,
        kind: d.kind,
        adapter: d.adapter,
        displayName: d.displayName,
        mode: d.mode,
        // Real channels always start disabled. Simulated ones are on only in simulation mode.
        enabled: d.mode === "SIMULATED" ? opts.simulation : false,
        lineId: d.line ? line.id : null,
      },
    });
  }
}

const settingsInput = (raw: Record<string, FormDataEntryValue | undefined>) => ({
  enabled: raw.enabled === "on" || raw.enabled === "true",
  carrierAuthRef: String(raw.carrierAuthRef ?? "").trim() || null,
});

export async function updateProvider(db: Db, key: string, raw: Record<string, FormDataEntryValue | undefined>, actorId: string) {
  const c = await db.providerConfig.findUniqueOrThrow({ where: { key } });
  const input = settingsInput(raw);
  const data: Prisma.ProviderConfigUpdateInput = { enabled: input.enabled };
  if (c.mode === "AUTOMATED") {
    // Recording an authorisation reference is a deliberate act; it does not by itself enable sending.
    data.carrierAuthorized = !!input.carrierAuthRef;
    data.carrierAuthRef = input.carrierAuthRef;
    data.carrierAuthAt = input.carrierAuthRef ? (c.carrierAuthAt ?? new Date()) : null;
  }
  const updated = await db.providerConfig.update({ where: { key }, data });
  await audit(db, {
    actorId,
    action: "provider.update",
    entityType: "provider_config",
    entityId: c.id,
    metadata: { key, from: { enabled: c.enabled, carrierAuthRef: c.carrierAuthRef }, to: { enabled: updated.enabled, carrierAuthRef: updated.carrierAuthRef } },
  });
  return updated;
}
