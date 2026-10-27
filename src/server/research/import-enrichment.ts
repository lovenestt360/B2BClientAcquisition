import { z } from "zod";
import type { Db } from "@/lib/db";
import { audit } from "../audit";
import { normalizeEmail } from "../normalize";
import { normalizeCountry } from "../import/validate";
import { parsePhone } from "../phone";

const fieldSchema = z.enum(["title", "email", "phone", "country", "company.description", "company.industry", "company.country", "company.city"]);
const outputSchema = z.object({
  claims: z.array(z.object({ field: fieldSchema, value: z.string().min(1), confidence: z.number().min(0).max(1) })).max(12),
});

type ResearchField = z.infer<typeof fieldSchema>;
export interface GroundedClaim { field: ResearchField; value: string; confidence: number; sourceUrl: string }

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      groundingSupports?: Array<{ segment?: { startIndex?: number; endIndex?: number; text?: string }; groundingChunkIndices?: number[] }>;
    };
  }>;
  error?: { message?: string };
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/** Parse Gemini output and retain only claims directly covered by Google Search grounding supports. */
export function groundedClaims(response: GeminiResponse): GroundedClaim[] {
  const candidate = response.candidates?.[0];
  const raw = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  const json = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const parsed = outputSchema.safeParse(JSON.parse(json || "{}"));
  if (!parsed.success) return [];
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const supports = candidate?.groundingMetadata?.groundingSupports ?? [];

  return parsed.data.claims.flatMap((claim) => {
    const valueStart = raw.indexOf(claim.value);
    if (valueStart < 0) return [];
    const valueEnd = valueStart + claim.value.length;
    const support = supports.find((item) => {
      const start = item.segment?.startIndex ?? -1;
      const end = item.segment?.endIndex ?? -1;
      return start <= valueStart && end >= valueEnd || start < valueEnd && end > valueStart;
    });
    const sourceUrl = support?.groundingChunkIndices
      ?.map((index) => chunks[index]?.web?.uri)
      .find((uri): uri is string => !!uri && /^https:\/\//i.test(uri));
    return sourceUrl ? [{ ...claim, value: clean(claim.value), sourceUrl }] : [];
  });
}

function researchPrompt(contact: {
  firstName: string; lastName: string | null; title: string | null; email: string | null; country: string | null;
  company: { name: string; domain: string | null; website: string | null; industry: string | null; country: string | null; city: string | null; description: string | null } | null;
}) {
  return `Research this exact B2B contact and company using public web sources.
Person: ${contact.firstName} ${contact.lastName ?? ""}
Known title: ${contact.title ?? "unknown"}
Known email: ${contact.email ?? "unknown"}
Known country: ${contact.country ?? "unknown"}
Company: ${contact.company?.name ?? "unknown"}
Company domain: ${contact.company?.domain ?? contact.company?.website ?? "unknown"}

Return JSON only: {"claims":[{"field":"title|email|phone|country|company.description|company.industry|company.country|company.city","value":"...","confidence":0.0}]}
Rules:
- Return only missing or corrective facts explicitly stated by a public source.
- The person must be unambiguously the same person at the same company. If identity is ambiguous, omit person claims.
- Never construct, infer, or pattern-guess an email or phone number.
- Do not use LinkedIn pages requiring login or private/personal data brokers.
- Country values must be an ISO 3166-1 alpha-2 code.
- Omit every uncertain or unsupported value; an empty claims array is valid.`;
}

async function geminiResearch(contact: Parameters<typeof researchPrompt>[0]) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("Gemini research is not configured: add GEMINI_API_KEY to the production environment");
  const model = process.env.GEMINI_RESEARCH_MODEL?.trim() || "gemini-2.5-flash";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(45_000),
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: researchPrompt(contact) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1 },
    }),
  });
  const body = await response.json() as GeminiResponse;
  if (!response.ok) throw new Error(body.error?.message || `Gemini API returned ${response.status}`);
  return { model, claims: groundedClaims(body) };
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
  const filled: string[] = [];
  const sources = new Set<string>();
  let model: string | null = null;
  let error: string | null = null;

  if (!contact.company) error = "A company must be linked before Gemini can identify the correct person";
  else try {
    const researched = await geminiResearch(contact);
    model = researched.model;
    for (const claim of researched.claims) {
      sources.add(claim.sourceUrl);
      const verifiedAt = new Date();
      if (claim.field.startsWith("company.")) {
        const field = claim.field.slice(8) as "description" | "industry" | "country" | "city";
        let value: string | null = claim.value;
        if (field === "country") value = normalizeCountry(value);
        if (!value || contact.company[field]) continue;
        await db.company.update({ where: { id: contact.company.id }, data: { [field]: value } });
        const exists = await db.researchFact.findFirst({ where: { companyId: contact.company.id, field, value, sourceUrl: claim.sourceUrl } });
        if (!exists) await db.researchFact.create({ data: { companyId: contact.company.id, field, value, sourceUrl: claim.sourceUrl, confidence: claim.confidence, verifiedAt } });
        filled.push(claim.field);
      } else if (claim.field === "title" && !contact.title) {
        await db.contact.update({ where: { id: contact.id }, data: { title: claim.value } });
        await db.researchFact.create({ data: { contactId: contact.id, kind: "role", field: "title", value: claim.value, sourceUrl: claim.sourceUrl, confidence: claim.confidence, verifiedAt } });
        filled.push("contact.title");
      } else if (claim.field === "country" && !contact.country) {
        const country = normalizeCountry(claim.value);
        if (!country) continue;
        await db.contact.update({ where: { id: contact.id }, data: { country } });
        await db.researchFact.create({ data: { contactId: contact.id, field: "country", value: country, sourceUrl: claim.sourceUrl, confidence: claim.confidence, verifiedAt } });
        filled.push("contact.country");
      } else if (claim.field === "email" && !contact.email) {
        const email = normalizeEmail(claim.value);
        if (!email || await db.contact.findUnique({ where: { email } })) continue;
        await db.contact.update({ where: { id: contact.id }, data: { email, emailSource: claim.sourceUrl, emailVerifiedAt: verifiedAt, emailVerificationStatus: "Source verified" } });
        filled.push("contact.email");
      } else if (claim.field === "phone" && contact.phoneNumbers.length === 0) {
        const phone = parsePhone(claim.value, contact.country ?? contact.company.country ?? "ZA");
        if (!phone.valid || !phone.e164) continue;
        await db.phoneNumber.create({ data: { contactId: contact.id, e164: phone.e164, rawInput: claim.value, country: phone.country, type: phone.type, isPrimary: true, source: claim.sourceUrl, sourceUrl: claim.sourceUrl, verifiedAt } });
        filled.push("contact.phone");
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const updated = await db.contact.findUniqueOrThrow({ where: { id: contactId }, include: { phoneNumbers: true } });
  const unresolved = missingLabels(updated);
  await audit(db, { actorId, actorType: actorId ? "user" : "job", action: "contact.gemini_research", entityType: "contact", entityId: contactId, metadata: { before, filled, unresolved, sources: [...sources], model, error } });
  return { contactId, before, filled, unresolved, sourceUrl: [...sources][0] ?? null, error };
}

export async function enrichImportBatch(db: Db, batchId: string, actorId: string | null) {
  const rows = await db.importRow.findMany({ where: { batchId, matchContactId: { not: null } }, select: { matchContactId: true } });
  const ids = [...new Set(rows.flatMap((row) => row.matchContactId ? [row.matchContactId] : []))];
  const results = [];
  // Keep API usage and Google Search grounding costs predictable.
  for (const id of ids) results.push(await enrichImportedContact(db, id, actorId));
  await audit(db, { actorId, actorType: actorId ? "user" : "job", action: "import.gemini_research_complete", entityType: "import_batch", entityId: batchId, metadata: { contacts: results.length, completed: results.filter((r) => !r.unresolved.length).length, unresolved: results.filter((r) => r.unresolved.length).length } });
  return results;
}
