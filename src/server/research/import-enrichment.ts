import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { normalizeCountry } from "../import/validate";

export interface WebsiteEvidence {
  description: string | null;
  industry: string | null;
  country: string | null;
  city: string | null;
}

const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const tag = (html: string, pattern: RegExp) => text(pattern.exec(html)?.[1]?.replace(/<[^>]*>/g, " ")) || null;

/** Extract only explicit public-page metadata. Nothing here guesses a person or contact channel. */
export function extractWebsiteEvidence(html: string): WebsiteEvidence {
  const evidence: WebsiteEvidence = {
    description:
      tag(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i) ??
      tag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i),
    industry: null,
    country: null,
    city: null,
  };
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const candidates = Array.isArray(parsed) ? parsed : parsed?.["@graph"] ?? [parsed];
      for (const item of candidates) {
        if (!item || typeof item !== "object") continue;
        evidence.industry ||= text(item.industry) || null;
        const address = Array.isArray(item.address) ? item.address[0] : item.address;
        if (address && typeof address === "object") {
          const rawCountry = typeof address.addressCountry === "object" ? address.addressCountry?.name : address.addressCountry;
          evidence.country ||= normalizeCountry(text(rawCountry));
          evidence.city ||= text(address.addressLocality) || null;
        }
        evidence.description ||= text(item.description) || null;
      }
    } catch {
      // Invalid structured data is ignored; it is never treated as evidence.
    }
  }
  return evidence;
}

function privateAddress(address: string) {
  if (address === "::1" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  if (!address.includes(".")) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function safePublicUrl(input: string) {
  const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error("Unsafe website URL");
  if (url.hostname === "localhost" || isIP(url.hostname) && privateAddress(url.hostname)) throw new Error("Private website URL");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error("Website resolves to a private address");
  return url;
}

async function fetchPublicPage(input: string) {
  let url = await safePublicUrl(input);
  for (let redirect = 0; redirect < 3; redirect++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      headers: { "user-agent": "ClientAcquisitionResearch/1.0 (+public company metadata)" },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = await safePublicUrl(new URL(response.headers.get("location")!, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Website returned ${response.status}`);
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) throw new Error("Website did not return HTML");
    const html = (await response.text()).slice(0, 1_000_000);
    return { url: url.toString(), evidence: extractWebsiteEvidence(html) };
  }
  throw new Error("Too many website redirects");
}

const missingLabels = (contact: { title: string | null; country: string | null; email: string | null; phoneNumbers: unknown[]; companyId: string | null }) => [
  !contact.companyId && "company",
  !contact.title && "job title",
  !contact.country && "country",
  !contact.email && contact.phoneNumbers.length === 0 && "email or phone",
].filter(Boolean) as string[];

export async function enrichImportedContact(db: Db, contactId: string, actorId: string | null) {
  const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId }, include: { company: true, phoneNumbers: true } });
  const before = missingLabels(contact);
  const website = contact.company?.website || contact.company?.domain;
  const filled: string[] = [];
  let sourceUrl: string | null = null;
  let error: string | null = null;

  if (contact.company && website) {
    try {
      const researched = await fetchPublicPage(website);
      sourceUrl = researched.url;
      const e = researched.evidence;
      const data = {
        description: contact.company.description ?? e.description ?? undefined,
        industry: contact.company.industry ?? e.industry ?? undefined,
        country: contact.company.country ?? e.country ?? undefined,
        city: contact.company.city ?? e.city ?? undefined,
      };
      for (const field of ["description", "industry", "country", "city"] as const) {
        if (!contact.company[field] && data[field]) {
          filled.push(`company.${field}`);
          const exists = await db.researchFact.findFirst({ where: { companyId: contact.company.id, field, value: String(data[field]), sourceUrl } });
          if (!exists) await db.researchFact.create({ data: { companyId: contact.company.id, field, value: String(data[field]), sourceUrl, confidence: 1, verifiedAt: new Date() } });
        }
      }
      await db.company.update({ where: { id: contact.company.id }, data });
      if (!contact.country && data.country) {
        await db.contact.update({ where: { id: contact.id }, data: { country: data.country } });
        filled.push("contact.country");
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  } else if (!contact.company) error = "No company is linked";
  else error = "No public company website or domain is available";

  const updated = await db.contact.findUniqueOrThrow({ where: { id: contactId }, include: { phoneNumbers: true } });
  const unresolved = missingLabels(updated);
  await audit(db, {
    actorId,
    actorType: actorId ? "user" : "job",
    action: "contact.import_research",
    entityType: "contact",
    entityId: contactId,
    metadata: { before, filled, unresolved, sourceUrl, error },
  });
  return { contactId, before, filled, unresolved, sourceUrl, error };
}

export async function enrichImportBatch(db: Db, batchId: string, actorId: string | null) {
  const rows = await db.importRow.findMany({ where: { batchId, matchContactId: { not: null } }, select: { matchContactId: true } });
  const ids = [...new Set(rows.flatMap((row) => row.matchContactId ? [row.matchContactId] : []))];
  const results = [];
  for (let i = 0; i < ids.length; i += 5) {
    results.push(...await Promise.all(ids.slice(i, i + 5).map((id) => enrichImportedContact(db, id, actorId))));
  }
  await audit(db, { actorId, actorType: actorId ? "user" : "job", action: "import.research_complete", entityType: "import_batch", entityId: batchId, metadata: { contacts: results.length, completed: results.filter((r) => !r.unresolved.length).length, unresolved: results.filter((r) => r.unresolved.length).length } });
  return results;
}
