import type { Db } from "@/lib/db";

export async function outreachReport(db: Db, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const [draftsByStatus, deliveryStates, callsByOutcome, callsByMode, replies, optOuts, airtime] = await Promise.all([
    db.messageDraft.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    db.messageDraft.groupBy({ by: ["providerKey", "deliveryState"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    db.call.groupBy({ by: ["outcome"], where: { createdAt: { gte: since }, mode: "MANUAL", outcome: { not: null } }, _count: { _all: true }, _sum: { durationSec: true } }),
    db.call.groupBy({ by: ["mode", "providerKey"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    db.smsEvent.count({ where: { occurredAt: { gte: since }, direction: "inbound" } }),
    db.marketingPermission.count({ where: { createdAt: { gte: since }, status: "WITHDRAWN" } }),
    db.airtimeEntry.aggregate({ where: { createdAt: { gte: since }, amountCents: { lt: 0 } }, _sum: { amountCents: true } }),
  ]);
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
  };
}
