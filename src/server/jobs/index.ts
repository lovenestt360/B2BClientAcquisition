import PgBoss from "pg-boss";
import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/db";
import { handlers, type QueueName } from "./handlers";

/** Retry policy per queue. Handlers must be idempotent: they can run more than once. */
export const QUEUE_POLICIES: Record<QueueName, { retryLimit: number; retryDelay: number; retryBackoff: boolean }> = {
  "import.commit": { retryLimit: 3, retryDelay: 10, retryBackoff: true },
};

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL! });
  boss.on("error", (e) => console.error("[pg-boss]", e));
  await boss.start();
  for (const [name, policy] of Object.entries(QUEUE_POLICIES)) {
    await boss.createQueue(name, { name, ...policy });
  }
  return boss;
}

export function jobsMode(): "inline" | "queue" {
  return process.env.JOBS_MODE === "queue" ? "queue" : "inline";
}

/**
 * Enqueue a job exactly once per idempotency key. Re-enqueueing the same key returns the
 * existing record instead of creating duplicate work.
 */
export async function enqueue<Q extends QueueName>(
  db: Db,
  queue: Q,
  payload: Parameters<(typeof handlers)[Q]>[1],
  idempotencyKey: string,
) {
  const existing = await db.jobRecord.findUnique({ where: { idempotencyKey } });
  if (existing && existing.status !== "failed") return existing;

  const record = existing
    ? await db.jobRecord.update({ where: { id: existing.id }, data: { status: "queued", lastError: null } })
    : await db.jobRecord.create({
        data: { idempotencyKey, queue, payload: payload as Prisma.InputJsonValue },
      });

  if (jobsMode() === "inline") {
    await runJob(db, record.id);
  } else {
    const b = await getBoss();
    await b.send(queue, { jobRecordId: record.id }, { singletonKey: idempotencyKey, ...QUEUE_POLICIES[queue] });
  }
  return db.jobRecord.findUniqueOrThrow({ where: { id: record.id } });
}

/** Execute a job record. Re-throws so pg-boss applies the retry policy. */
export async function runJob(db: Db, jobRecordId: string) {
  const rec = await db.jobRecord.findUniqueOrThrow({ where: { id: jobRecordId } });
  if (rec.status === "succeeded") return rec.result;
  await db.jobRecord.update({
    where: { id: rec.id },
    data: { status: "running", attempts: { increment: 1 } },
  });
  try {
    const handler = handlers[rec.queue as QueueName] as (db: Db, p: unknown) => Promise<unknown>;
    if (!handler) throw new Error(`No handler for queue ${rec.queue}`);
    const result = await handler(db, rec.payload);
    await db.jobRecord.update({
      where: { id: rec.id },
      data: { status: "succeeded", result: (result ?? null) as Prisma.InputJsonValue },
    });
    return result;
  } catch (e) {
    await db.jobRecord.update({
      where: { id: rec.id },
      data: { status: "failed", lastError: e instanceof Error ? e.message : String(e) },
    });
    throw e;
  }
}
