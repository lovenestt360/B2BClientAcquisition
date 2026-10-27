import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Deployment self-check. Reports only coarse status (no data, no secrets):
 *   database  – can we connect at all
 *   migrated  – do the tables exist
 *   hasAdmin  – has the seed created a sign-in account
 */
export async function GET() {
  const status = {
    ok: false,
    database: false,
    migrated: false,
    hasAdmin: false,
    env: {
      DATABASE_URL: !!process.env.DATABASE_URL,
      APP_ENCRYPTION_KEY: !!process.env.APP_ENCRYPTION_KEY,
    },
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
    status.database = true;
    const t = await prisma.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass('public.users') IS NOT NULL AS "exists"`;
    status.migrated = !!t[0]?.exists;
    if (status.migrated) status.hasAdmin = (await prisma.user.count({ where: { role: "ADMIN", active: true } })) > 0;
  } catch (error) {
    console.error("Health check database error:", error instanceof Error ? error.message : error);
  }
  status.ok = status.database && status.migrated;
  return Response.json(status, { status: status.ok ? 200 : 503 });
}
