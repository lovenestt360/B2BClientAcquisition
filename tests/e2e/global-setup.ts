import { execSync } from "node:child_process";
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";

export default async function globalSetup() {
  config();
  const url = process.env.DATABASE_URL_E2E ?? "postgresql://app:app@localhost:5432/acquisition_e2e";
  if (!/e2e/.test(url)) throw new Error("DATABASE_URL_E2E must point at an *e2e* database");
  const env = { ...process.env, DATABASE_URL: url };
  execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
  const db = new PrismaClient({ datasources: { db: { url } } });
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(", ")} CASCADE`);
  await db.$disconnect();
  execSync("npx tsx prisma/seed.ts", { env, stdio: "pipe" });
}
