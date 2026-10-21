import type { Prisma } from "@prisma/client";
import type { Db } from "@/lib/db";
import { sha256 } from "../crypto";
import { audit } from "../audit";
import { AppError } from "../errors";
import { parseUpload } from "./parse";
import { applyMapping, detectMapping, type Field } from "./mapping";
import { validateRow, type NormalizedRow } from "./validate";
import { loadIndex, planRows, type Candidate, type PlannedRow } from "./dedupe";

export async function buildPlan(db: Db, raw: Record<string, string>[], mapping: Record<string, Field>) {
  const candidates: Candidate[] = raw.map((r, i) => {
    const v = validateRow(applyMapping(r, mapping));
    return { rowNumber: i + 2, row: v.row, errors: v.errors, warnings: v.warnings }; // +2: header is row 1
  });
  const idx = await loadIndex(db, candidates.flatMap((c) => (c.row ? [c.row] : [])));
  return planRows(candidates, idx);
}

/** Step 1: parse, validate and dedupe. Nothing is written to the CRM yet. */
export async function createImportPreview(
  db: Db,
  input: { fileName: string; data: Buffer; userId: string },
) {
  const raw = await parseUpload(input.fileName, input.data);
  if (!raw.length) throw new AppError("The file contains no data rows");
  const mapping = detectMapping(Object.keys(raw[0]));
  if (!Object.values(mapping).includes("firstName") && !Object.values(mapping).includes("fullName")) {
    throw new AppError("Could not find a name column (expected e.g. 'First Name' or 'Name')");
  }
  const plan = await buildPlan(db, raw, mapping);
  const counts = countActions(plan);

  const batch = await db.importBatch.create({
    data: {
      fileName: input.fileName,
      fileHash: sha256(input.data),
      totalRows: plan.length,
      invalidRows: counts.INVALID,
      skippedRows: counts.SKIP_DUPLICATE,
      createdById: input.userId,
      rows: {
        createMany: {
          data: plan.map((p, i) => ({
            rowNumber: p.rowNumber,
            raw: raw[i] as Prisma.InputJsonValue,
            normalized: (p.row ?? undefined) as Prisma.InputJsonValue | undefined,
            action: p.action,
            errors: [...p.errors, ...p.warnings.map((w) => `warning: ${w}`)],
            matchContactId: p.matchContactId,
            matchCompanyId: p.matchCompanyId,
            matchReason: p.matchReason,
          })),
        },
      },
    },
  });
  await audit(db, {
    actorId: input.userId,
    action: "import.preview",
    entityType: "import_batch",
    entityId: batch.id,
    metadata: { fileName: input.fileName, mapping, counts },
  });
  return { batchId: batch.id, mapping, counts };
}

export function countActions(plan: Pick<PlannedRow, "action">[]) {
  const counts = { CREATE: 0, MERGE: 0, SKIP_DUPLICATE: 0, INVALID: 0 };
  for (const p of plan) counts[p.action]++;
  return counts;
}

/**
 * Step 2: commit. Idempotent — safe to re-run after a crash: already-committed batches are a
 * no-op, and rows are re-matched against the current DB so partially-applied rows MERGE.
 */
export async function commitImport(db: Db, batchId: string, userId: string | null) {
  const batch = await db.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new AppError("Import batch not found", "not_found", 404);
  if (batch.status === "COMMITTED") return batch;
  if (batch.status === "CANCELLED") throw new AppError("Import batch was cancelled");

  await db.importBatch.update({ where: { id: batchId }, data: { status: "COMMITTING", error: null } });

  try {
    const rows = await db.importRow.findMany({
      where: { batchId, action: { in: ["CREATE", "MERGE"] } },
      orderBy: { rowNumber: "asc" },
    });
    let created = 0;
    let merged = 0;
    const source = `import:${batchId}`;

    for (const ir of rows) {
      const n = ir.normalized as unknown as NormalizedRow;
      const result = await db.$transaction((tx) => upsertContactFromRow(tx as Db, n, source));
      if (result === "created") created++;
      else merged++;
    }

    const done = await db.importBatch.update({
      where: { id: batchId },
      data: { status: "COMMITTED", createdRows: created, mergedRows: merged, committedAt: new Date() },
    });
    await audit(db, {
      actorId: userId,
      actorType: userId ? "user" : "job",
      action: "import.commit",
      entityType: "import_batch",
      entityId: batchId,
      metadata: { created, merged },
    });
    return done;
  } catch (e) {
    await db.importBatch.update({
      where: { id: batchId },
      data: { status: "FAILED", error: e instanceof Error ? e.message : String(e) },
    });
    throw e;
  }
}

async function resolveCompany(tx: Db, n: NormalizedRow, source: string): Promise<string | null> {
  const c = n.company;
  const existing =
    (c.domain && (await tx.company.findUnique({ where: { domain: c.domain } }))) ||
    (c.normalizedName && (await tx.company.findFirst({ where: { normalizedName: c.normalizedName } }))) ||
    null;
  if (existing) {
    // Fill blanks only; never overwrite curated data.
    await tx.company.update({
      where: { id: existing.id },
      data: {
        domain: existing.domain ?? c.domain ?? undefined,
        website: existing.website ?? c.website ?? undefined,
        industry: existing.industry ?? c.industry ?? undefined,
        city: existing.city ?? c.city ?? undefined,
        country: existing.country ?? n.country ?? undefined,
      },
    });
    return existing.id;
  }
  if (!c.name) return null; // never invent a company name from a domain
  const company = await tx.company.create({
    data: {
      name: c.name,
      normalizedName: c.normalizedName!,
      domain: c.domain,
      website: c.website,
      industry: c.industry,
      city: c.city,
      country: n.country,
      sourceType: "import",
      sourceRef: source,
    },
  });
  return company.id;
}

export async function upsertContactFromRow(tx: Db, n: NormalizedRow, source: string): Promise<"created" | "merged"> {
  const companyId = await resolveCompany(tx, n, source);

  let contact =
    (n.email && (await tx.contact.findUnique({ where: { email: n.email } }))) ||
    (n.phone &&
      (await tx.phoneNumber.findFirst({ where: { e164: n.phone.e164 }, include: { contact: true } }))?.contact) ||
    (companyId &&
      (await tx.contact.findFirst({ where: { companyId, fullNameNormalized: n.fullNameNormalized } }))) ||
    null;

  let outcome: "created" | "merged";
  if (contact) {
    outcome = "merged";
    contact = await tx.contact.update({
      where: { id: contact.id },
      data: {
        lastName: contact.lastName ?? n.lastName ?? undefined,
        title: contact.title ?? n.title ?? undefined,
        linkedinUrl: contact.linkedinUrl ?? n.linkedinUrl ?? undefined,
        country: contact.country ?? n.country ?? undefined,
        companyId: contact.companyId ?? companyId ?? undefined,
        ...(contact.email || !n.email ? {} : { email: n.email, emailSource: source }),
      },
    });
  } else {
    outcome = "created";
    contact = await tx.contact.create({
      data: {
        firstName: n.firstName,
        lastName: n.lastName,
        fullNameNormalized: n.fullNameNormalized,
        title: n.title,
        email: n.email,
        emailSource: n.email ? source : null,
        linkedinUrl: n.linkedinUrl,
        country: n.country,
        companyId,
        sourceType: "import",
        sourceRef: source,
      },
    });
  }

  if (n.phone) {
    const hasPrimary = await tx.phoneNumber.count({ where: { contactId: contact.id, isPrimary: true } });
    await tx.phoneNumber.upsert({
      where: { contactId_e164: { contactId: contact.id, e164: n.phone.e164 } },
      update: {},
      create: {
        contactId: contact.id,
        e164: n.phone.e164,
        rawInput: n.phone.raw,
        country: n.phone.country,
        type: n.phone.type,
        isPrimary: hasPrimary === 0,
        source,
      },
    });
  }
  return outcome;
}

export async function cancelImport(db: Db, batchId: string, userId: string) {
  const b = await db.importBatch.findUnique({ where: { id: batchId } });
  if (!b || b.status !== "PREVIEW") throw new AppError("Only previewed imports can be cancelled");
  await db.importBatch.update({ where: { id: batchId }, data: { status: "CANCELLED" } });
  await audit(db, { actorId: userId, action: "import.cancel", entityType: "import_batch", entityId: batchId });
}
