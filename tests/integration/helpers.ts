import { PrismaClient, type Role } from "@prisma/client";
import { hashPassword } from "@/server/auth/password";

export const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL_TEST } } });

export async function resetDb() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(", ")} CASCADE`);
  }
}

export async function makeUser(role: Role = "ADMIN", email = `${role.toLowerCase()}@test.local`) {
  return db.user.create({ data: { email, name: role, role, passwordHash: await hashPassword("password-1234") } });
}
