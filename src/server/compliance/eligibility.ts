import type { Channel, MarketingPermission } from "@prisma/client";
import { now as clockNow } from "../clock";
import type { Db } from "@/lib/db";
import { localTime, rulesFor } from "./rules";
import { findSuppression, isOutreachHalted } from "./controls";

export type Purpose = "marketing" | "consent_request" | "reply" | "transactional";

export interface EligibilityInput {
  contactId: string;
  channel: Channel;
  purpose?: Purpose;
  /** Address actually used (E.164 / email); checked against suppressions. */
  address?: string | null;
  campaignId?: string | null;
  now?: Date;
  /** Drafting is not contacting: skip the contact-hours window (checked again at hand-off). */
  ignoreContactWindow?: boolean;
}

export interface EligibilityDecision {
  eligible: boolean;
  basis: "consent" | "existing_customer" | "consent_request" | "non_electronic" | "reply" | null;
  reasons: string[]; // blocking reasons
  warnings: string[];
  citation: string;
  checkedAt: string;
}

/** Latest permission record per channel wins. */
export function latestPermission(perms: MarketingPermission[], channel: Channel) {
  return perms
    .filter((p) => p.channel === channel)
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime())[0];
}

export async function checkEligibility(db: Db, input: EligibilityInput): Promise<EligibilityDecision> {
  const now = input.now ?? clockNow();
  const purpose = input.purpose ?? "marketing";
  const reasons: string[] = [];
  const warnings: string[] = [];

  const contact = await db.contact.findUnique({
    where: { id: input.contactId },
    include: { permissions: true, company: { select: { domain: true } } },
  });
  if (!contact) return decide(false, null, ["contact not found"], [], "-", now);

  const rules = rulesFor(contact.country);
  if (!contact.country) warnings.push("contact country unknown: strict opt-in rules applied");

  // 1. Emergency stops
  const halt = await isOutreachHalted(db, input.campaignId);
  if (halt) reasons.push(halt);

  // 2. Suppression (address, domain, any-channel or this channel)
  const sup = await findSuppression(db, {
    email: input.channel === "EMAIL" ? (input.address ?? contact.email) : contact.email,
    e164: input.channel === "EMAIL" ? null : input.address,
    domain: contact.company?.domain ?? contact.email?.split("@")[1] ?? null,
    channel: input.channel,
  });
  if (sup) reasons.push(`suppressed (${sup.reason}, source: ${sup.source})`);

  // 3. Permission records
  const perm = latestPermission(contact.permissions, input.channel);
  if (perm && (perm.status === "WITHDRAWN" || perm.status === "REFUSED")) {
    reasons.push(`contact ${perm.status.toLowerCase()} ${input.channel} marketing on ${perm.capturedAt.toISOString().slice(0, 10)}`);
  }

  // 4. Lawful basis
  let basis: EligibilityDecision["basis"] = null;
  if (purpose === "reply") {
    basis = "reply"; // responding to an inbound message from the contact
  } else if (purpose === "transactional") {
    basis = "reply";
    warnings.push("transactional messages must not contain marketing content");
  } else if (!rules.consentRequired.includes(input.channel)) {
    basis = "non_electronic";
  } else if (perm?.status === "GRANTED") {
    basis = perm.basis === "EXISTING_CUSTOMER" ? "existing_customer" : "consent";
  } else if (rules.existingCustomerBasis && contact.isExistingCustomer && !perm) {
    basis = "existing_customer";
    warnings.push("existing-customer basis: every message must offer an opt-out");
  } else if (purpose === "consent_request" && rules.oneConsentRequestAllowed) {
    const priorRequest = contact.permissions.some((p) => p.channel === input.channel && p.status === "CONSENT_REQUESTED");
    const everRefused = contact.permissions.some(
      (p) => p.channel === input.channel && (p.status === "REFUSED" || p.status === "WITHDRAWN"),
    );
    if (priorRequest) reasons.push("POPIA s69(2): consent may only be requested once and was already requested");
    else if (everRefused) reasons.push("POPIA s69(2): contact previously withheld consent");
    else basis = "consent_request";
  } else {
    reasons.push(
      rules.country === "ZA"
        ? `POPIA s69: ${input.channel} marketing needs consent or an existing-customer relationship`
        : `${input.channel} marketing needs recorded opt-in consent (${rules.citation})`,
    );
  }

  // 5. Contact hours
  if (!input.ignoreContactWindow && purpose !== "reply" && purpose !== "transactional" && rules.contactWindow) {
    const w = rules.contactWindow(localTime(now, process.env.APP_TIMEZONE ?? "Africa/Johannesburg"));
    if (w) reasons.push(w);
  }

  return decide(reasons.length === 0, reasons.length ? null : basis, reasons, warnings, rules.citation, now);
}

function decide(
  eligible: boolean,
  basis: EligibilityDecision["basis"],
  reasons: string[],
  warnings: string[],
  citation: string,
  now: Date,
): EligibilityDecision {
  return { eligible, basis, reasons, warnings, citation, checkedAt: now.toISOString() };
}
