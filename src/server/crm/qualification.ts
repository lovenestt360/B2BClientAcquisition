import type { Db } from "@/lib/db";

export interface QualificationCheck {
  id: "real" | "company" | "title" | "country" | "reachable" | "provenance";
  label: string;
  passed: boolean;
  detail: string;
}

export interface QualificationContact {
  isSimulated: boolean;
  companyId: string | null;
  title: string | null;
  country: string | null;
  email: string | null;
  emailSource: string | null;
  emailVerificationStatus: string | null;
  sourceType: string;
  sourceRef: string | null;
  phoneNumbers: { source: string }[];
}

export function evaluateQualification(contact: QualificationContact) {
  const usableEmail = !!contact.email && contact.emailVerificationStatus !== "Invalid";
  const reachable = usableEmail || contact.phoneNumbers.length > 0;
  const channelsHaveSources = (!contact.email || !!contact.emailSource) && contact.phoneNumbers.every((phone) => !!phone.source);
  const contactHasSource = contact.sourceType === "manual" || !!contact.sourceRef;
  const checks: QualificationCheck[] = [
    { id: "real", label: "Real contact", passed: !contact.isSimulated, detail: "Seeded simulation records cannot be qualified." },
    { id: "company", label: "Company linked", passed: !!contact.companyId, detail: "Link the person to a known company." },
    { id: "title", label: "Role identified", passed: !!contact.title?.trim(), detail: "Add the person's job title or decision-making role." },
    { id: "country", label: "Country known", passed: !!contact.country, detail: "Country is required for the correct compliance rules." },
    { id: "reachable", label: "Reachable channel", passed: reachable, detail: "Add a usable email address or phone number." },
    { id: "provenance", label: "Source recorded", passed: contactHasSource && channelsHaveSources, detail: "Contact details must come from an import, user entry, or cited source." },
  ];
  return { ready: checks.every((check) => check.passed), checks };
}

export async function getQualificationReadiness(db: Db, contactId: string) {
  const contact = await db.contact.findUniqueOrThrow({
    where: { id: contactId },
    select: {
      isSimulated: true,
      companyId: true,
      title: true,
      country: true,
      email: true,
      emailSource: true,
      emailVerificationStatus: true,
      sourceType: true,
      sourceRef: true,
      phoneNumbers: { select: { source: true } },
    },
  });
  return evaluateQualification(contact);
}
