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

import { seedProviderRows } from "@/server/providers/registry";
import { setSenderProfile } from "@/server/compliance/controls";
import { setClock } from "@/server/clock";

/** Wednesday 21 Oct 2026, 10:00 SAST: inside the CPA contact window. */
export const BUSINESS_HOURS = new Date("2026-10-21T08:00:00Z");

export async function setupOutreach(opts: { enableIphone?: boolean } = {}) {
  setClock(() => BUSINESS_HOURS);
  const admin = await makeUser("ADMIN");
  await seedProviderRows(db, { simulation: true });
  if (opts.enableIphone ?? true) {
    await db.providerConfig.updateMany({ where: { key: { in: ["iphone_manual_sms", "iphone_manual_call"] } }, data: { enabled: true } });
  }
  await setSenderProfile(db, { businessName: "Acme Ops", optOutText: "Reply STOP to opt out" }, admin.id);
  return { admin, actor: { id: admin.id, role: admin.role } };
}

let n = 0;
export async function makeContact(over: { country?: string | null; isSimulated?: boolean; isExistingCustomer?: boolean; phone?: string; email?: string } = {}) {
  n++;
  return db.contact.create({
    data: {
      firstName: `Lead${n}`,
      lastName: "Test",
      fullNameNormalized: `lead${n} test`,
      email: over.email ?? `lead${n}@corp${n}.example`,
      country: over.country === undefined ? "ZA" : over.country,
      isSimulated: over.isSimulated ?? false,
      isExistingCustomer: over.isExistingCustomer ?? false,
      phoneNumbers: { create: { e164: over.phone ?? `+278212${String(10000 + n).slice(-5)}`, rawInput: "x", type: "MOBILE", isPrimary: true, source: "test" } },
    },
    include: { phoneNumbers: true },
  });
}

export async function grantConsent(contactId: string, channel: "SMS" | "EMAIL" | "VOICE_MANUAL" = "SMS") {
  return db.marketingPermission.create({
    data: { contactId, channel, status: "GRANTED", basis: "CONSENT", evidence: "web form 2026-10-01", capturedAt: new Date("2026-10-01") },
  });
}
