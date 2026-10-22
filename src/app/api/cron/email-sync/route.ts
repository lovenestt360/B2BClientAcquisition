import { prisma } from "@/lib/db";
import { runScheduled } from "@/server/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Inbox sync for hosts without a long-running worker (e.g. Vercel Cron).
 * Requires `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends it automatically).
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const runKey = `email.sync_all:cron:${new Date().toISOString().slice(0, 16)}`; // one run per minute at most
  const result = await runScheduled(prisma, "email.sync_all", runKey);
  return Response.json({ ok: true, result });
}
