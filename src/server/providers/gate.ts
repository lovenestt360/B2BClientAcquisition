import { env } from "@/lib/env";
import { AppError } from "../errors";
import type { ProviderRuntimeConfig } from "./types";

/**
 * The single gate for AUTOMATED outreach. All three must hold:
 *  1. ALLOW_AUTOMATED_OUTREACH=true in the environment (operator kill switch),
 *  2. the provider is explicitly enabled,
 *  3. a carrier/provider authorisation reference has been recorded.
 */
export function automationBlockers(cfg: ProviderRuntimeConfig): string[] {
  const out: string[] = [];
  if (!env().ALLOW_AUTOMATED_OUTREACH) out.push("ALLOW_AUTOMATED_OUTREACH is not enabled in the environment");
  if (!cfg.enabled) out.push(`provider ${cfg.key} is disabled`);
  if (!cfg.carrierAuthorized || !cfg.carrierAuthRef) out.push("no recorded carrier/provider authorisation");
  return out;
}

export function assertCanAutomate(cfg: ProviderRuntimeConfig): void {
  const b = automationBlockers(cfg);
  if (b.length) throw new AppError(`Automated outreach blocked: ${b.join("; ")}`, "automation_blocked", 423);
}
