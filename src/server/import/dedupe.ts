import type { ImportRowAction } from "@prisma/client";
import type { Db } from "@/lib/db";
import type { NormalizedRow } from "./validate";

export interface PlannedRow {
  rowNumber: number;
  action: ImportRowAction;
  row: NormalizedRow | null;
  errors: string[];
  warnings: string[];
  matchContactId?: string;
  matchCompanyId?: string;
  matchReason?: string;
}

export interface Candidate {
  rowNumber: number;
  row: NormalizedRow | null;
  errors: string[];
  warnings: string[];
}

interface ExistingIndex {
  contactByEmail: Map<string, string>;
  contactByPhone: Map<string, string>;
  contactByNameCompany: Map<string, string>; // `${companyId}|${fullName}`
  companyByDomain: Map<string, string>;
  companyByName: Map<string, string>;
}

/** Load only the existing records that could match rows in this file. */
export async function loadIndex(db: Db, rows: NormalizedRow[]): Promise<ExistingIndex> {
  const emails = [...new Set(rows.map((r) => r.email).filter(Boolean))] as string[];
  const phones = [...new Set(rows.map((r) => r.phone?.e164).filter(Boolean))] as string[];
  const domains = [...new Set(rows.map((r) => r.company.domain).filter(Boolean))] as string[];
  const names = [...new Set(rows.map((r) => r.company.normalizedName).filter(Boolean))] as string[];
  const fullNames = [...new Set(rows.map((r) => r.fullNameNormalized))];

  const [byEmail, byPhone, companies, byName] = await Promise.all([
    emails.length ? db.contact.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } }) : [],
    phones.length ? db.phoneNumber.findMany({ where: { e164: { in: phones } }, select: { contactId: true, e164: true } }) : [],
    domains.length || names.length
      ? db.company.findMany({
          where: { OR: [{ domain: { in: domains } }, { normalizedName: { in: names } }] },
          select: { id: true, domain: true, normalizedName: true },
        })
      : [],
    db.contact.findMany({
      where: { fullNameNormalized: { in: fullNames }, companyId: { not: null } },
      select: { id: true, companyId: true, fullNameNormalized: true },
    }),
  ]);

  const idx: ExistingIndex = {
    contactByEmail: new Map(byEmail.map((c) => [c.email!, c.id])),
    contactByPhone: new Map(byPhone.map((p) => [p.e164, p.contactId])),
    contactByNameCompany: new Map(byName.map((c) => [`${c.companyId}|${c.fullNameNormalized}`, c.id])),
    companyByDomain: new Map(),
    companyByName: new Map(),
  };
  for (const c of companies) {
    if (c.domain) idx.companyByDomain.set(c.domain, c.id);
    if (!idx.companyByName.has(c.normalizedName)) idx.companyByName.set(c.normalizedName, c.id);
  }
  return idx;
}

export function resolveCompanyId(idx: ExistingIndex, row: NormalizedRow): string | undefined {
  return (
    (row.company.domain && idx.companyByDomain.get(row.company.domain)) ||
    (row.company.normalizedName && idx.companyByName.get(row.company.normalizedName)) ||
    undefined
  );
}

/**
 * Decide CREATE / MERGE / SKIP_DUPLICATE / INVALID for each row.
 * Match order: email → phone → (company + full name). Within-file duplicates are skipped.
 */
export function planRows(candidates: Candidate[], idx: ExistingIndex): PlannedRow[] {
  const seen = new Map<string, number>(); // dedupe key -> first row number in file
  return candidates.map((c) => {
    if (!c.row) return { rowNumber: c.rowNumber, action: "INVALID", row: null, errors: c.errors, warnings: c.warnings };
    const r = c.row;
    const companyKey = r.company.domain ?? r.company.normalizedName ?? "";
    const keys = [
      r.email && `e:${r.email}`,
      r.phone && `p:${r.phone.e164}`,
      companyKey && `n:${companyKey}|${r.fullNameNormalized}`,
    ].filter(Boolean) as string[];

    const dupOf = keys.map((k) => seen.get(k)).find((n) => n !== undefined);
    if (dupOf !== undefined) {
      return { ...c, action: "SKIP_DUPLICATE", matchReason: `duplicate of row ${dupOf} in this file` };
    }
    keys.forEach((k) => seen.set(k, c.rowNumber));

    const companyId = resolveCompanyId(idx, r);
    let matchContactId: string | undefined;
    let matchReason: string | undefined;
    if (r.email && idx.contactByEmail.has(r.email)) {
      matchContactId = idx.contactByEmail.get(r.email);
      matchReason = "email";
    } else if (r.phone && idx.contactByPhone.has(r.phone.e164)) {
      matchContactId = idx.contactByPhone.get(r.phone.e164);
      matchReason = "phone";
    } else if (companyId && idx.contactByNameCompany.has(`${companyId}|${r.fullNameNormalized}`)) {
      matchContactId = idx.contactByNameCompany.get(`${companyId}|${r.fullNameNormalized}`);
      matchReason = "name+company";
    }
    return {
      ...c,
      action: matchContactId ? "MERGE" : "CREATE",
      matchContactId,
      matchCompanyId: companyId,
      matchReason,
    };
  });
}
