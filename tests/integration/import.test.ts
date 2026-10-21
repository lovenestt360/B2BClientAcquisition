import { beforeEach, describe, expect, it } from "vitest";
import { db, makeUser, resetDb } from "./helpers";
import { commitImport, createImportPreview } from "@/server/import/service";
import { enqueue } from "@/server/jobs";
import { createContact } from "@/server/crm/contacts";

beforeEach(resetDb);

const CSV = [
  "First Name,Last Name,Email,Mobile,Company,Website,Country",
  "Jane,Doe,jane@acme.example,082 123 4567,Acme (Pty) Ltd,https://www.acme.example,South Africa",
  "Jane,Doe,JANE@ACME.EXAMPLE,,Acme,,ZA", // in-file duplicate
  "Bob,Smith,bob@acme.example,,ACME PTY LTD,,ZA", // same company by name/domain
  ",NoFirst,nofirst@acme.example,,,,", // invalid
  "Existing,Person,existing@other.example,0712345678,Other Co,,ZA", // merges
].join("\n");

describe("import pipeline", () => {
  it("previews without writing CRM rows, then commits with dedupe and provenance", async () => {
    const u = await makeUser();
    const existing = await createContact(db, { firstName: "Existing", email: "existing@other.example" }, u.id);

    const preview = await createImportPreview(db, { fileName: "leads.csv", data: Buffer.from(CSV), userId: u.id });
    expect(preview.counts).toEqual({ CREATE: 2, MERGE: 1, SKIP_DUPLICATE: 1, INVALID: 1 });
    expect(await db.contact.count()).toBe(1); // preview writes nothing to CRM

    const batch = await commitImport(db, preview.batchId, u.id);
    expect(batch).toMatchObject({ status: "COMMITTED", createdRows: 2, mergedRows: 1 });

    expect(await db.contact.count()).toBe(3);
    const companies = await db.company.findMany();
    expect(companies).toHaveLength(2); // Acme deduped across "Acme (Pty) Ltd" / "ACME PTY LTD"
    const acme = companies.find((c) => c.domain === "acme.example")!;
    expect(await db.contact.count({ where: { companyId: acme.id } })).toBe(2);

    const jane = await db.contact.findUniqueOrThrow({ where: { email: "jane@acme.example" }, include: { phoneNumbers: true } });
    expect(jane.emailSource).toBe(`import:${preview.batchId}`);
    expect(jane.phoneNumbers[0]).toMatchObject({ e164: "+27821234567", type: "MOBILE", isPrimary: true, verifiedAt: null });

    const merged = await db.contact.findUniqueOrThrow({ where: { id: existing.id }, include: { phoneNumbers: true } });
    expect(merged.phoneNumbers.map((p) => p.e164)).toEqual(["+27712345678"]);
    expect(merged.lastName).toBe("Person"); // blank filled
  });

  it("commit is idempotent (re-run and duplicate job enqueue)", async () => {
    const u = await makeUser();
    const { batchId } = await createImportPreview(db, { fileName: "leads.csv", data: Buffer.from(CSV), userId: u.id });
    const job1 = await enqueue(db, "import.commit", { batchId, userId: u.id }, `import.commit:${batchId}`);
    const job2 = await enqueue(db, "import.commit", { batchId, userId: u.id }, `import.commit:${batchId}`);
    expect(job1.id).toBe(job2.id);
    expect(job2.status).toBe("succeeded");
    expect(job2.attempts).toBe(1);
    await commitImport(db, batchId, u.id); // direct re-run is a no-op
    expect(await db.contact.count()).toBe(3);
    expect(await db.jobRecord.count()).toBe(1);
  });

  it("recovers from a partially applied commit by merging instead of duplicating", async () => {
    const u = await makeUser();
    const { batchId } = await createImportPreview(db, { fileName: "leads.csv", data: Buffer.from(CSV), userId: u.id });
    await db.importBatch.update({ where: { id: batchId }, data: { status: "FAILED" } }); // simulate crash
    await createContact(db, { firstName: "Jane", email: "jane@acme.example" }, u.id); // half-applied row
    const b = await commitImport(db, batchId, u.id);
    expect(b.status).toBe("COMMITTED");
    expect(await db.contact.count({ where: { email: "jane@acme.example" } })).toBe(1);
  });

  it("rejects files without a name column", async () => {
    const u = await makeUser();
    await expect(createImportPreview(db, { fileName: "x.csv", data: Buffer.from("Email\na@b.example"), userId: u.id })).rejects.toThrow(/name column/);
  });
});

describe("manual contact creation", () => {
  it("blocks duplicates by email and phone and audits creation", async () => {
    const u = await makeUser();
    await createContact(db, { firstName: "A", email: "a@x.example", phone: "0821111111" }, u.id);
    await expect(createContact(db, { firstName: "B", email: "A@x.example" }, u.id)).rejects.toThrow(/email already exists/);
    await expect(createContact(db, { firstName: "B", phone: "+27821111111" }, u.id)).rejects.toThrow(/phone number already exists/);
    await expect(createContact(db, { firstName: "B", phone: "999" }, u.id)).rejects.toThrow(/invalid phone/);
    expect(await db.auditLog.count({ where: { action: "contact.create" } })).toBe(1);
  });
});
