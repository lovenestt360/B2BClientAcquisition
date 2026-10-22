import type { Db } from "@/lib/db";

export async function outreachReport(db: Db, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const [draftsByStatus, deliveryStates, callsByOutcome, callsByMode, replies, optOuts, airtime, emailOut, emailIn] = await Promise.all([
    db.messageDraft.groupBy({ by: ["status"], where: { channel: "SMS", createdAt: { gte: since } }, _count: { _all: true } }),
    db.messageDraft.groupBy({ by: ["providerKey", "deliveryState"], where: { channel: "SMS", createdAt: { gte: since } }, _count: { _all: true } }),
    db.call.groupBy({ by: ["outcome"], where: { createdAt: { gte: since }, mode: "MANUAL", outcome: { not: null } }, _count: { _all: true }, _sum: { durationSec: true } }),
    db.call.groupBy({ by: ["mode", "providerKey"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    db.smsEvent.count({ where: { occurredAt: { gte: since }, direction: "inbound" } }),
    db.marketingPermission.count({ where: { createdAt: { gte: since }, status: "WITHDRAWN" } }),
    db.airtimeEntry.aggregate({ where: { createdAt: { gte: since }, amountCents: { lt: 0 } }, _sum: { amountCents: true } }),
    db.emailMessage.groupBy({ by: ["deliveryState"], where: { direction: "outbound", occurredAt: { gte: since } }, _count: { _all: true } }),
    db.emailMessage.groupBy({ by: ["classification"], where: { direction: "inbound", occurredAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const eo = (st: string) => emailOut.find((e) => e.deliveryState === st)?._count._all ?? 0;
  const ei = (l: string) => emailIn.find((e) => e.classification === l)?._count._all ?? 0;
  const emailsSent = emailOut.reduce((n, e) => n + e._count._all, 0);
  const humanReplies = ["interested", "question", "not_interested", "unsubscribe", "other"].reduce((n, l) => n + ei(l), 0);
  const email = {
    sent: emailsSent,
    accepted: eo("ACCEPTED"),
    deliveredByEvidence: eo("DELIVERED"),
    failed: eo("FAILED"),
    unknown: eo("UNKNOWN"),
    humanReplies,
    interested: ei("interested"),
    unsubscribes: ei("unsubscribe"),
    bounces: ei("bounce"),
    replyRate: emailsSent ? humanReplies / emailsSent : null,
    byLabel: emailIn,
  };
  const sent = draftsByStatus.find((d) => d.status === "SENT_CONFIRMED")?._count._all ?? 0;
  const connected = callsByOutcome.filter((c) => c.outcome?.startsWith("CONNECTED") || c.outcome === "MEETING_BOOKED").reduce((n, c) => n + c._count._all, 0);
  const totalCalls = callsByOutcome.reduce((n, c) => n + c._count._all, 0);
  return {
    sinceDays,
    draftsByStatus,
    deliveryStates,
    callsByOutcome,
    callsByMode,
    replies,
    optOuts,
    smsSent: sent,
    replyRate: sent ? replies / sent : null,
    callConnectRate: totalCalls ? connected / totalCalls : null,
    meetings: callsByOutcome.find((c) => c.outcome === "MEETING_BOOKED")?._count._all ?? 0,
    airtimeSpendCents: -(airtime._sum.amountCents ?? 0),
    email,
  };
}
