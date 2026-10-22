import type { Campaign, CampaignMember, Company, Contact } from "@prisma/client";
import type { Db } from "@/lib/db";
import { checkEligibility } from "../compliance/eligibility";
import type { CampaignConfig, OutreachSettings } from "./config";
import { collectEvidence } from "./generate";

export type MemberWithLead = CampaignMember & { contact: Contact & { company: Company | null }; campaign: Campaign };

export interface GateResult {
  /** Reason codes, e.g. PERMISSION_MISSING. Empty = every lead-level gate passed. */
  codes: string[];
  details: string[];
  /** Lead-level problems a human must fix (→ HOLD / RESEARCH_REQUIRED). Others just defer. */
  durable: string[];
}

/** Gates that only defer a send (time, caps, pauses); the lead itself is fine. */
export const TRANSIENT = new Set(["CAMPAIGN_NOT_ACTIVE", "EMERGENCY_STOP", "OUTSIDE_CONTACT_HOURS"]);
export const RESEARCH_CODES = new Set(["RESEARCH_INSUFFICIENT", "NEED_EVIDENCE_MISSING"]);

/**
 * Lead-level gates checked before generating and again immediately before each send. Fails
 * closed: anything missing or ambiguous produces a code. Launch, schedule, due-step and caps are
 * checked by the batch and the send reservation.
 */
export async function evaluateGates(
  db: Db,
  m: MemberWithLead,
  cfg: CampaignConfig | undefined,
  s: OutreachSettings,
  now: Date,
): Promise<GateResult> {
  const codes: string[] = [];
  const details: string[] = [];
  const add = (code: string, detail: string) => {
    if (!codes.includes(code)) codes.push(code);
    details.push(`${code}: ${detail}`);
  };
  const c = m.contact;

  // Campaign / ICP
  if (!cfg) add("CAMPAIGN_NOT_CONFIGURED", `campaign ${m.campaign.key ?? m.campaign.name} is not in the outreach config`);
  if (m.campaign.status !== "ACTIVE") add("CAMPAIGN_NOT_ACTIVE", `campaign is ${m.campaign.status}`);
  if (m.campaign.emergencyStopped) add("EMERGENCY_STOP", "campaign emergency stop");
  if (cfg && (c.country ?? "").toUpperCase() !== cfg.country.toUpperCase()) add("WRONG_COUNTRY", `lead country ${c.country ?? "unknown"}, campaign ${cfg.country}`);
  if (!c.company) add("ICP_COMPANY_MISSING", "no company linked");
  const title = (c.title ?? "").toLowerCase();
  if (cfg && !cfg.roleKeywords.some((k) => title.includes(k))) add("ICP_ROLE_UNCONFIRMED", c.title ? `title "${c.title}" is outside the campaign ICP` : "no job title");

  // Address
  if (!c.email) add("EMAIL_MISSING", "no email address");
  else if (!c.emailVerifiedAt || !s.acceptedVerificationStatuses.includes(c.emailVerificationStatus ?? "")) {
    add("EMAIL_NOT_VERIFIED", `verification status ${c.emailVerificationStatus ?? "Not checked"}`);
  }

  // Duplicates: one active sequence per person across all outreach campaigns.
  const others = await db.campaignMember.findMany({
    where: {
      id: { not: m.id },
      campaign: { key: { not: null } },
      state: { notIn: ["STOPPED"] },
      OR: [{ contactId: c.id }, ...(c.companyId ? [{ contact: { fullNameNormalized: c.fullNameNormalized, companyId: c.companyId } }] : [])],
    },
    select: { id: true, addedAt: true, campaign: { select: { key: true } } },
  });
  const earlier = others.find((o) => o.addedAt < m.addedAt || (o.addedAt.getTime() === m.addedAt.getTime() && o.id < m.id));
  if (earlier) add("DUPLICATE", `already in ${earlier.campaign.key}`);

  // Final approval
  if (!m.approvedAt) add("NOT_APPROVED", "no final lead approval");

  // Research and need evidence
  const ev = await collectEvidence(db, c.id, s.minFactConfidence);
  if (!ev.verified.some((v) => v.kind !== "need_evidence")) add("RESEARCH_INSUFFICIENT", "no verified, sourced fact at or above the confidence threshold");
  if (!ev.verified.some((v) => v.kind === "need_evidence")) add("NEED_EVIDENCE_MISSING", "no verified need evidence");

  // Suppression, opt-out, emergency stop, lawful basis, CPA contact hours
  if (c.email) {
    const elig = await checkEligibility(db, { contactId: c.id, channel: "EMAIL", purpose: "marketing", address: c.email, campaignId: m.campaignId, now });
    for (const r of elig.reasons) {
      if (/suppressed/i.test(r)) add("SUPPRESSED", r);
      else if (/withdrawn|refused/i.test(r)) add("OPT_OUT", r);
      else if (/emergency|halt|stopped/i.test(r)) add("EMERGENCY_STOP", r);
      else if (/CPA Reg 4|weekdays only|Saturdays|Sundays|public holidays/i.test(r)) add("OUTSIDE_CONTACT_HOURS", r);
      else add("PERMISSION_MISSING", r);
    }
    // A consent request is never a sales sequence: only documented consent or an existing customer.
    if (elig.eligible && elig.basis !== "consent" && elig.basis !== "existing_customer") add("PERMISSION_MISSING", `basis ${elig.basis} is not valid for a promotional sequence`);
  }

  if (m.stopReason) add("STOPPED", m.stopReason);

  return { codes, details, durable: codes.filter((x) => !TRANSIENT.has(x)) };
}
