import { z } from "zod";
import type { Prisma, PipelineStage } from "@prisma/client";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { AppError } from "../errors";
import { normalizeCompanyName, normalizeDomain, normalizeEmail, normalizePersonName } from "../normalize";
import { parsePhone } from "../phone";
import { normalizeCountry } from "../import/validate";

export const contactInput = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().max(100).optional().or(z.literal("")),
  email: z.string().trim().optional().or(z.literal("")),
  phone: z.string().trim().optional().or(z.literal("")),
  title: z.string().trim().max(150).optional().or(z.literal("")),
  country: z.string().trim().optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  notes: z.string().max(5000).optional().or(z.literal("")),
});

export async function createContact(db: Db, raw: unknown, actorId: string) {
  const input = contactInput.parse(raw);
  let email: string | null = null;
  if (input.email) {
    email = normalizeEmail(input.email);
    if (!email) throw new AppError(`Invalid email "${input.email}"`);
    if (await db.contact.findUnique({ where: { email } })) throw new AppError("A contact with this email already exists");
  }
  const country = normalizeCountry(input.country) ?? null;
  let phone: ReturnType<typeof parsePhone> | null = null;
  if (input.phone) {
    phone = parsePhone(input.phone, country ?? "ZA");
    if (!phone.valid) throw new AppError(phone.error ?? "Invalid phone");
    const dup = await db.phoneNumber.findFirst({ where: { e164: phone.e164 } });
    if (dup) throw new AppError("A contact with this phone number already exists");
  }
  const contact = await db.contact.create({
    data: {
      firstName: input.firstName,
      lastName: input.lastName || null,
      fullNameNormalized: normalizePersonName(input.firstName, input.lastName),
      email,
      emailSource: email ? "manual" : null,
      title: input.title || null,
      country: country ?? phone?.country ?? null,
      companyId: input.companyId || null,
      notes: input.notes || null,
      ownerId: actorId,
      sourceType: "manual",
      phoneNumbers: phone
        ? {
            create: {
              e164: phone.e164!,
              rawInput: input.phone!,
              country: phone.country,
              type: phone.type,
              isPrimary: true,
              source: "manual",
            },
          }
        : undefined,
    },
  });
  await audit(db, { actorId, action: "contact.create", entityType: "contact", entityId: contact.id });
  return contact;
}

export async function updateContactStage(db: Db, id: string, stage: PipelineStage, actorId: string) {
  const before = await db.contact.findUniqueOrThrow({ where: { id } });
  const c = await db.contact.update({ where: { id }, data: { stage } });
  await audit(db, {
    actorId,
    action: "contact.stage_change",
    entityType: "contact",
    entityId: id,
    metadata: { from: before.stage, to: stage },
  });
  return c;
}

export async function listContacts(db: Db, opts: { q?: string; stage?: PipelineStage; page?: number; pageSize?: number }) {
  const pageSize = opts.pageSize ?? 25;
  const page = Math.max(1, opts.page ?? 1);
  const where: Prisma.ContactWhereInput = {};
  if (opts.stage) where.stage = opts.stage;
  if (opts.q) {
    const q = opts.q.trim();
    where.OR = [
      { firstName: { contains: q, mode: "insensitive" } },
      { lastName: { contains: q, mode: "insensitive" } },
      { email: { contains: q.toLowerCase() } },
      { company: { name: { contains: q, mode: "insensitive" } } },
      { phoneNumbers: { some: { e164: { contains: q.replace(/[^\d+]/g, "") || q } } } },
    ];
  }
  const [items, total] = await Promise.all([
    db.contact.findMany({
      where,
      include: { company: true, phoneNumbers: { where: { isPrimary: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.contact.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export const companyInput = z.object({
  name: z.string().trim().min(1, "Company name is required").max(200),
  website: z.string().trim().optional().or(z.literal("")),
  industry: z.string().trim().max(100).optional().or(z.literal("")),
  country: z.string().trim().optional().or(z.literal("")),
  city: z.string().trim().max(100).optional().or(z.literal("")),
});

export async function createCompany(db: Db, raw: unknown, actorId: string) {
  const input = companyInput.parse(raw);
  const domain = normalizeDomain(input.website);
  const normalizedName = normalizeCompanyName(input.name);
  if (domain && (await db.company.findUnique({ where: { domain } }))) {
    throw new AppError(`A company with domain ${domain} already exists`);
  }
  const sameName = await db.company.findFirst({ where: { normalizedName } });
  if (sameName && !domain) throw new AppError(`A company named "${sameName.name}" already exists`);
  const company = await db.company.create({
    data: {
      name: input.name,
      normalizedName,
      domain,
      website: input.website || null,
      industry: input.industry || null,
      country: normalizeCountry(input.country),
      city: input.city || null,
    },
  });
  await audit(db, { actorId, action: "company.create", entityType: "company", entityId: company.id });
  return company;
}
