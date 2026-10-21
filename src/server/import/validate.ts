import type { PhoneType } from "@prisma/client";
import { FREE_MAIL_DOMAINS, normalizeCompanyName, normalizeDomain, normalizeEmail, normalizePersonName } from "../normalize";
import { parsePhone } from "../phone";
import type { MappedRow } from "./mapping";

export interface NormalizedRow {
  firstName: string;
  lastName: string | null;
  fullNameNormalized: string;
  email: string | null;
  phone: { e164: string; raw: string; type: PhoneType; country: string | null } | null;
  title: string | null;
  linkedinUrl: string | null;
  country: string | null;
  company: {
    name: string | null;
    normalizedName: string | null;
    domain: string | null;
    website: string | null;
    industry: string | null;
    city: string | null;
  };
}

export interface ValidationResult {
  row: NormalizedRow | null;
  errors: string[];
  warnings: string[];
}

const COUNTRY_NAMES: Record<string, string> = {
  "south africa": "ZA",
  rsa: "ZA",
  sa: "ZA",
  "united kingdom": "GB",
  uk: "GB",
  "united states": "US",
  usa: "US",
  namibia: "NA",
  botswana: "BW",
  kenya: "KE",
  nigeria: "NG",
  zimbabwe: "ZW",
  mozambique: "MZ",
  lesotho: "LS",
  eswatini: "SZ",
  germany: "DE",
  netherlands: "NL",
  australia: "AU",
};

export function normalizeCountry(input?: string | null): string | null {
  if (!input) return null;
  const s = input.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRY_NAMES[s.toLowerCase()] ?? null;
}

const LINKEDIN_RE = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in|company)\/[^/\s]+\/?$/i;

export function validateRow(m: MappedRow): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const firstName = m.firstName?.trim();
  if (!firstName) errors.push("first name is required");
  if (firstName && firstName.length > 100) errors.push("first name is too long");

  let email: string | null = null;
  if (m.email) {
    email = normalizeEmail(m.email);
    if (!email) errors.push(`invalid email "${m.email}"`);
  }

  let countryInput = normalizeCountry(m.country);
  if (m.country && !countryInput) warnings.push(`unrecognised country "${m.country}"`);

  let phone: NormalizedRow["phone"] = null;
  if (m.phone) {
    const p = parsePhone(m.phone, countryInput ?? "ZA");
    if (!p.valid) errors.push(p.error ?? `invalid phone "${m.phone}"`);
    else phone = { e164: p.e164!, raw: m.phone, type: p.type, country: p.country ?? null };
  }
  if (!countryInput && phone?.country) countryInput = phone.country;

  if (!email && !phone) warnings.push("no email or phone; contact will not be reachable");

  let linkedinUrl: string | null = null;
  if (m.linkedinUrl) {
    if (LINKEDIN_RE.test(m.linkedinUrl.trim())) linkedinUrl = m.linkedinUrl.trim();
    else warnings.push("linkedin url ignored (not a linkedin.com/in or /company URL)");
  }

  // Domain only from explicit columns or a corporate email; never guessed from the name.
  let domain = normalizeDomain(m.companyDomain) ?? normalizeDomain(m.website);
  if (!domain && email) {
    const d = email.split("@")[1];
    if (!FREE_MAIL_DOMAINS.has(d)) domain = d;
  }
  const companyName = m.companyName?.trim() || null;

  if (errors.length) return { row: null, errors, warnings };

  return {
    row: {
      firstName: firstName!,
      lastName: m.lastName?.trim() || null,
      fullNameNormalized: normalizePersonName(firstName!, m.lastName),
      email,
      phone,
      title: m.title?.trim() || null,
      linkedinUrl,
      country: countryInput,
      company: {
        name: companyName,
        normalizedName: companyName ? normalizeCompanyName(companyName) : null,
        domain,
        website: m.website?.trim() || null,
        industry: m.industry?.trim() || null,
        city: m.city?.trim() || null,
      },
    },
    errors,
    warnings,
  };
}
