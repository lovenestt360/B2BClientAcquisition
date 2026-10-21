import type { RawRow } from "./parse";

export const FIELDS = [
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "title",
  "companyName",
  "companyDomain",
  "website",
  "industry",
  "country",
  "city",
  "linkedinUrl",
] as const;
export type Field = (typeof FIELDS)[number];
export type MappedRow = Partial<Record<Field, string>>;

const ALIASES: Record<Field, string[]> = {
  firstName: ["first name", "firstname", "first", "given name", "name first"],
  lastName: ["last name", "lastname", "surname", "family name", "last"],
  fullName: ["name", "full name", "contact name", "contact"],
  email: ["email", "e-mail", "email address", "work email", "mail"],
  phone: ["phone", "mobile", "cell", "cellphone", "phone number", "mobile number", "tel", "telephone", "contact number"],
  title: ["title", "job title", "position", "role", "designation"],
  companyName: ["company", "company name", "organisation", "organization", "account", "business", "employer"],
  companyDomain: ["domain", "company domain"],
  website: ["website", "url", "web", "company website", "site"],
  industry: ["industry", "sector", "vertical"],
  country: ["country", "country code"],
  city: ["city", "town", "location"],
  linkedinUrl: ["linkedin", "linkedin url", "linkedin profile"],
};

const key = (s: string) => s.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();

export function detectMapping(headers: string[]): Record<string, Field> {
  const map: Record<string, Field> = {};
  const used = new Set<Field>();
  for (const h of headers) {
    const k = key(h);
    for (const f of FIELDS) {
      if (used.has(f)) continue;
      if (key(f) === k || ALIASES[f].some((a) => key(a) === k)) {
        map[h] = f;
        used.add(f);
        break;
      }
    }
  }
  return map;
}

export function applyMapping(row: RawRow, mapping: Record<string, Field>): MappedRow {
  const out: MappedRow = {};
  for (const [h, f] of Object.entries(mapping)) {
    const v = row[h]?.trim();
    if (v) out[f] = v;
  }
  if (!out.firstName && out.fullName) {
    const parts = out.fullName.split(/\s+/);
    out.firstName = parts[0];
    if (parts.length > 1 && !out.lastName) out.lastName = parts.slice(1).join(" ");
  }
  return out;
}
