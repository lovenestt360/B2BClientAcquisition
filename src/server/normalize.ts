const COMPANY_SUFFIXES = [
  "\\(pty\\)\\s*ltd",
  "pty\\s*ltd",
  "proprietary\\s+limited",
  "\\(pty\\)",
  "pty",
  "ltd",
  "limited",
  "inc",
  "incorporated",
  "llc",
  "plc",
  "gmbh",
  "cc",
  "npc",
  "soc",
  "co",
  "corp",
  "corporation",
  "company",
];
const SUFFIX_RE = new RegExp(`(?:[\\s,.]+(?:${COMPANY_SUFFIXES.join("|")})\\.?)+$`, "i");

export function normalizeCompanyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .trim()
    .replace(SUFFIX_RE, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "https://www.Acme.co.za/about" -> "acme.co.za". Returns null when not a plausible domain. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@")) s = s.split("@").pop()!;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#:]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
}

export function normalizePersonName(first: string, last?: string | null): string {
  return `${first} ${last ?? ""}`
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Webmail domains are never used to infer the company. */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "webmail.co.za",
  "mweb.co.za",
  "telkomsa.net",
  "vodamail.co.za",
  "absamail.co.za",
]);
