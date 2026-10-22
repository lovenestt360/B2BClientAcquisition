import { z } from "zod";
import type { Db } from "@/lib/db";
import { audit } from "../audit";

const KEY = "sales.playbook";

/** What the AI caller sells and how. Owner-maintained; the AI may only use what is written here. */
export const playbookSchema = z.object({
  ownerName: z.string().trim().max(60).default(""), // whose voice / on whose behalf
  offer: z.string().trim().max(600).default(""), // what you sell, one paragraph
  idealCustomer: z.string().trim().max(400).default(""),
  valueProps: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
  proofPoints: z.array(z.string().trim().min(1).max(200)).max(6).default([]), // true results only
  pricingGuidance: z.string().trim().max(300).default("Pricing depends on scope; we cover it in the meeting."),
  meetingLengthMin: z.coerce.number().int().min(10).max(90).default(20),
  meetingFormat: z.string().trim().max(60).default("video call"),
});
export type Playbook = z.infer<typeof playbookSchema>;

export async function getPlaybook(db: Db): Promise<Playbook> {
  const s = await db.systemSetting.findUnique({ where: { key: KEY } });
  return playbookSchema.parse(s?.value ?? {});
}

const lines = (v: unknown) =>
  String(v ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);

/** Accepts form fields; multi-line textareas become lists. */
export async function savePlaybook(db: Db, raw: Record<string, unknown>, actorId: string) {
  const v = playbookSchema.parse({ ...raw, valueProps: lines(raw.valueProps), proofPoints: lines(raw.proofPoints) });
  await db.systemSetting.upsert({ where: { key: KEY }, update: { value: v, updatedBy: actorId }, create: { key: KEY, value: v, updatedBy: actorId } });
  await audit(db, { actorId, action: "settings.sales_playbook", entityType: "system" });
  return v;
}

export function playbookReady(p: Playbook): string[] {
  const missing: string[] = [];
  if (!p.offer) missing.push("describe what you sell");
  if (!p.valueProps.length) missing.push("add at least one value point");
  return missing;
}
