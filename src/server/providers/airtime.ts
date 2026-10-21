import { z } from "zod";
import type { Db } from "@/lib/db";
import { audit } from "../audit";

export const airtimeInput = z.object({
  lineId: z.string().min(1),
  kind: z.enum(["topup", "adjustment", "balance_check", "sms_estimate", "call_estimate"]),
  amountRand: z.coerce.number().refine((n) => Number.isFinite(n) && Math.abs(n) < 100_000, "Invalid amount"),
  note: z.string().trim().max(300).optional(),
});

/** Manual entries. Top-ups are positive, spend negative; balance checks store the balance read on the phone. */
export async function recordAirtime(db: Db, raw: unknown, actorId: string) {
  const i = airtimeInput.parse(raw);
  const cents = Math.round(i.amountRand * 100);
  const signed = i.kind === "topup" || i.kind === "balance_check" ? Math.abs(cents) : i.kind === "adjustment" ? cents : -Math.abs(cents);
  const e = await db.airtimeEntry.create({
    data: { lineId: i.lineId, kind: i.kind, amountCents: signed, note: i.note, recordedById: actorId },
  });
  await audit(db, { actorId, action: "airtime.record", entityType: "carrier_line", entityId: i.lineId, metadata: { kind: i.kind, cents: signed } });
  return e;
}

/** Spend estimate from user-entered rates. Marked `estimated` so it is never mistaken for a carrier statement. */
export async function recordEstimatedSpend(
  db: Db,
  lineId: string | null | undefined,
  kind: "sms_estimate" | "call_estimate",
  units: number,
  related: { type: string; id: string },
) {
  if (!lineId || units <= 0) return null;
  const line = await db.carrierLine.findUnique({ where: { id: lineId } });
  const rate = kind === "sms_estimate" ? line?.smsRateCents : line?.callRatePerMinCents;
  if (!line || rate == null) return null;
  const amount = -Math.round(rate * units);
  await db.costEntry.create({ data: { category: "airtime", amountCents: -amount, relatedType: related.type, relatedId: related.id, note: `${kind} x${units}` } });
  return db.airtimeEntry.create({
    data: { lineId, kind, amountCents: amount, estimated: true, relatedType: related.type, relatedId: related.id, note: `${units} × ${rate}c` },
  });
}

export async function airtimeSummary(db: Db, lineId: string) {
  const entries = await db.airtimeEntry.findMany({ where: { lineId }, orderBy: { createdAt: "desc" }, take: 100 });
  const sum = (f: (e: (typeof entries)[number]) => boolean) => entries.filter(f).reduce((n, e) => n + e.amountCents, 0);
  const lastBalance = entries.find((e) => e.kind === "balance_check");
  const since = lastBalance ? entries.filter((e) => e.createdAt > lastBalance.createdAt && e.kind !== "balance_check") : [];
  return {
    entries,
    topupsCents: sum((e) => e.kind === "topup"),
    estimatedSpendCents: -sum((e) => e.estimated),
    manualSpendCents: -sum((e) => e.kind === "adjustment" && e.amountCents < 0),
    lastBalance: lastBalance ? { cents: lastBalance.amountCents, at: lastBalance.createdAt } : null,
    projectedBalanceCents: lastBalance ? lastBalance.amountCents + since.reduce((n, e) => n + e.amountCents, 0) : null,
  };
}
