/**
 * Seed: admin + role users and simulated dummy leads.
 * Dummy leads use example.* domains and are flagged isSimulated=true; the UI disables
 * real sms:/tel: actions for them so a fictional number can never be texted or dialled.
 */
import "dotenv/config";
import { PrismaClient, type PipelineStage } from "@prisma/client";
import { hashPassword } from "../src/server/auth/password";
import { normalizeCompanyName, normalizePersonName } from "../src/server/normalize";
import { seedProviders } from "./seed-providers";
import { seedSimulatedMailbox } from "../src/server/email/accounts";

const prisma = new PrismaClient();

const COMPANIES = [
  { name: "Karoo Logistics (Pty) Ltd", domain: "karoo-logistics.example", industry: "Logistics", city: "Johannesburg" },
  { name: "Fynbos Software", domain: "fynbos-software.example", industry: "Software", city: "Cape Town" },
  { name: "Umhlanga Medical Supplies", domain: "umhlanga-medical.example", industry: "Healthcare", city: "Durban" },
  { name: "Highveld Engineering CC", domain: "highveld-eng.example", industry: "Engineering", city: "Pretoria" },
  { name: "Baobab Financial Advisory", domain: "baobab-fin.example", industry: "Financial services", city: "Sandton" },
];

const PEOPLE: [string, string, string, number, PipelineStage][] = [
  ["Thandi", "Mokoena", "Operations Director", 0, "NEW"],
  ["Pieter", "van der Merwe", "Fleet Manager", 0, "QUALIFIED"],
  ["Aisha", "Patel", "CTO", 1, "CONTACTED"],
  ["Sipho", "Dlamini", "Head of Sales", 1, "NEW"],
  ["Naledi", "Khumalo", "Procurement Lead", 2, "ENGAGED"],
  ["Johan", "Botha", "Managing Director", 3, "NEW"],
  ["Lerato", "Nkosi", "Finance Manager", 4, "MEETING_BOOKED"],
  ["Zanele", "Mthembu", "COO", 4, "RESEARCHING"],
];

async function main() {
  const adminEmail = (process.env.SEED_ADMIN_EMAIL?.trim() || "admin@example.com").toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe!2026";
  const simulation = process.env.SIMULATION_MODE !== "false";
  // A public deployment, or a laptop pointed at a hosted database (shared with production),
  // must never get accounts with the documented default password or the demo team.
  const localDb = /@(localhost|127\.0\.0\.1|db)(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
  const publicDeploy = !!process.env.VERCEL || process.env.NODE_ENV === "production" || !localDb;
  // A production admin may change their sign-in email in the application. Detect the
  // role rather than the original seed address so a later deploy never recreates a
  // second administrator under the old email.
  const existingAdmin = await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, select: { email: true } });
  const adminExists = !!existingAdmin;
  if (publicDeploy && !adminExists && (!process.env.SEED_ADMIN_PASSWORD || adminPassword === "ChangeMe!2026" || adminPassword.length < 12)) {
    throw new Error("Set SEED_ADMIN_PASSWORD (12+ characters, not the default) before deploying. Refusing to seed a public site with a known password.");
  }
  const users = [
    { email: adminEmail, name: "Admin", role: "ADMIN" as const, password: adminPassword },
    { email: "manager@example.com", name: "Morgan Manager", role: "MANAGER" as const, password: adminPassword },
    { email: "operator@example.com", name: "Olu Operator", role: "OPERATOR" as const, password: adminPassword },
    { email: "viewer@example.com", name: "Val Viewer", role: "VIEWER" as const, password: adminPassword },
  ];
  const seededUsers = publicDeploy && adminExists ? [] : publicDeploy || !simulation ? users.slice(0, 1) : users;
  for (const u of seededUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { email: u.email, name: u.name, role: u.role, passwordHash: await hashPassword(u.password) },
    });
  }

  // Dummy companies and leads exist only for simulation mode.
  const companyIds: string[] = [];
  for (const c of simulation ? COMPANIES : []) {
    const row = await prisma.company.upsert({
      where: { domain: c.domain },
      update: {},
      create: { ...c, normalizedName: normalizeCompanyName(c.name), website: `https://${c.domain}`, country: "ZA", sourceType: "seed" },
    });
    companyIds.push(row.id);
  }

  for (const [i, [first, last, title, ci, stage]] of (simulation ? PEOPLE : []).entries()) {
    const email = `${first}.${last}`.toLowerCase().replace(/\s+/g, "") + `@${COMPANIES[ci].domain}`;
    // Valid-format SA mobile numbers in the 082 000 0xxx block; flagged simulated, never dialled.
    const e164 = `+2782000${String(1000 + i).padStart(4, "0")}`;
    await prisma.contact.upsert({
      where: { email },
      update: {},
      create: {
        firstName: first,
        lastName: last,
        fullNameNormalized: normalizePersonName(first, last),
        title,
        email,
        emailSource: "seed",
        country: "ZA",
        stage,
        companyId: companyIds[ci],
        isSimulated: true,
        sourceType: "seed",
        phoneNumbers: { create: { e164, rawInput: e164, country: "ZA", type: "MOBILE", isPrimary: true, source: "seed" } },
      },
    });
  }

  await seedProviders(prisma);

  // Simulation-only extras: sender identity and consent on some dummy leads.
  if (process.env.SIMULATION_MODE !== "false") {
    await prisma.systemSetting.upsert({
      where: { key: "sender.profile" },
      update: {},
      create: { key: "sender.profile", value: { businessName: "Klyron Consulting", optOutText: "Reply STOP to opt out" } },
    });
    const dummies = await prisma.contact.findMany({ where: { isSimulated: true }, orderBy: { email: "asc" } });
    for (const c of dummies.slice(0, 4)) {
      for (const channel of ["SMS", "EMAIL"] as const) {
        if (await prisma.marketingPermission.count({ where: { contactId: c.id, channel } })) continue;
        await prisma.marketingPermission.create({
          data: { contactId: c.id, channel, status: "GRANTED", basis: "CONSENT", evidence: "SIMULATED seed consent (dummy lead)", capturedAt: new Date() },
        });
      }
    }
    await seedSimulatedMailbox(prisma, true);
    // Klyron playbook so every channel starts from the same construction-sector positioning.
    const klyronPlaybook = {
            ownerName: "Mário Quissico",
            offer: "Klyron Consulting helps South African contractors and project-management teams identify, coordinate and close multidisciplinary BIM and MEP risks before they become site rework, programme delays, variations or client surprises.",
            idealCustomer: "South African main contractors and project-management consultancies responsible for commercial construction delivery, multidisciplinary coordination and project risk.",
            valueProps: [
              "Resolve multidisciplinary model and MEP interfaces before fabrication or installation",
              "Keep critical coordination issues visible, assigned and moving to closure",
              "Give project teams consistent, coordinated information for site delivery",
              "Add independent BIM QA/QC or delivery capacity when internal teams are overloaded",
            ],
            proofPoints: [],
            pricingGuidance: "Pricing depends on project stage, disciplines, model condition and the coordination scope. We confirm it after a technical scoping discussion.",
            meetingLengthMin: 15,
            meetingFormat: "video call",
    };
    const existingPlaybook = await prisma.systemSetting.findUnique({ where: { key: "sales.playbook" } });
    const existingOffer = (existingPlaybook?.value as { offer?: unknown } | null)?.offer;
    if (!existingPlaybook) {
      await prisma.systemSetting.create({ data: { key: "sales.playbook", value: klyronPlaybook } });
    } else if (typeof existingOffer === "string" && existingOffer.startsWith("DEMO:")) {
      // Upgrade only the old seeded demo; never overwrite an owner-edited playbook.
      await prisma.systemSetting.update({ where: { key: "sales.playbook" }, data: { value: klyronPlaybook } });
    }
    if (dummies[4]) await prisma.contact.update({ where: { id: dummies[4].id }, data: { isExistingCustomer: true } });
  }
  console.log(`Seeded ${seededUsers.length} user(s), ${companyIds.length} companies, ${simulation ? PEOPLE.length : 0} simulated contacts.`);
  console.log(`Sign in as ${existingAdmin?.email ?? adminEmail} (password managed by the administrator).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
