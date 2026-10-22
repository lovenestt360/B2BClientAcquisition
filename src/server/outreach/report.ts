import type { Db } from "@/lib/db";
import { latestPermission } from "../compliance/eligibility";
import { getOutreachSettings } from "./config";

export interface FunnelRow {
  campaign: string;
  enrolled: number;
  imported: number;
  verified: number;
  researched: number;
  permissioned: number;
  approved: number;
  queued: number; // generated, awaiting approval or approved (live)
  sent: number; // provider-confirmed (SMTP accepted) live sends only
  unknown: number;
  failed: number;
  replied: number;
  booked: number;
  optedOut: number;
  hardBounced: number;
  suppressed: number;
  completed: number;
  dryRunSends: number;
}

/**
 * Reconciliation funnel per campaign. "sent" counts provider-confirmed live sends only; dry-run
 * rehearsals are shown separately and never mixed in.
 */
export async function outreachReconciliation(db: Db) {
  const s = await getOutreachSettings(db);
  const campaigns = await db.campaign.findMany({ where: { key: { not: null } }, orderBy: { key: "asc" } });
  const rows: FunnelRow[] = [];
  const holds: Record<string, number> = {};
  const sendHolds: Record<string, number> = {};

  for (const c of campaigns) {
    const members = await db.campaignMember.findMany({
      where: { campaignId: c.id },
      include: { contact: { include: { permissions: true, researchFacts: true, company: { include: { researchFacts: true } } } } },
    });
    const sends = await db.outreachSend.findMany({ where: { campaignId: c.id }, select: { status: true, dryRun: true, reasonCodes: true } });
    const emails = members.map((m) => m.contact.email).filter(Boolean) as string[];
    const suppressed = emails.length ? await db.suppression.count({ where: { email: { in: emails } } }) : 0;

    const researched = members.filter((m) => {
      const facts = [...m.contact.researchFacts, ...(m.contact.company?.researchFacts.filter((f) => !f.contactId) ?? [])].filter((f) => !f.isInference && f.confidence >= s.minFactConfidence);
      return facts.some((f) => f.kind === "need_evidence") && facts.some((f) => f.kind !== "need_evidence");
    }).length;
    const permissioned = members.filter((m) => {
      const p = latestPermission(m.contact.permissions, "EMAIL");
      return p ? p.status === "GRANTED" : m.contact.isExistingCustomer;
    }).length;
    const live = sends.filter((x) => !x.dryRun);
    rows.push({
      campaign: c.key!,
      enrolled: members.length,
      imported: members.filter((m) => m.contact.sourceType === "import").length,
      verified: members.filter((m) => m.contact.emailVerifiedAt && s.acceptedVerificationStatuses.includes(m.contact.emailVerificationStatus ?? "")).length,
      researched,
      permissioned,
      approved: members.filter((m) => m.approvedAt).length,
      queued: live.filter((x) => x.status === "AWAITING_APPROVAL" || x.status === "APPROVED").length,
      sent: live.filter((x) => x.status === "PROVIDER_ACCEPTED").length,
      unknown: live.filter((x) => x.status === "UNKNOWN" || x.status === "SENDING").length,
      failed: live.filter((x) => x.status === "FAILED").length,
      replied: members.filter((m) => m.stopReason === "REPLY").length,
      booked: members.filter((m) => m.stopReason === "BOOKED").length,
      optedOut: members.filter((m) => m.stopReason === "OPT_OUT").length,
      hardBounced: members.filter((m) => m.stopReason === "HARD_BOUNCE").length,
      suppressed,
      completed: members.filter((m) => m.state === "COMPLETED").length,
      dryRunSends: sends.filter((x) => x.dryRun && x.status === "DRY_RUN").length,
    });
    for (const m of members) {
      if ((m.state === "HOLD" || m.state === "RESEARCH_REQUIRED") && m.holdReason) {
        for (const code of m.holdReason.split(",")) holds[code] = (holds[code] ?? 0) + 1;
      }
    }
    for (const x of sends) {
      if (x.status !== "HELD" && x.status !== "RESEARCH_REQUIRED") continue;
      for (const r of (x.reasonCodes as string[] | null) ?? []) {
        const code = r.split(":")[0];
        sendHolds[code] = (sendHolds[code] ?? 0) + 1;
      }
    }
  }
  return { rows, holds, sendHolds };
}
