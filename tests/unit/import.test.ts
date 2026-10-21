import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseCsv, parseUpload } from "@/server/import/parse";
import { applyMapping, detectMapping } from "@/server/import/mapping";
import { validateRow } from "@/server/import/validate";
import { planRows, type Candidate } from "@/server/import/dedupe";

const emptyIndex = () => ({
  contactByEmail: new Map<string, string>(),
  contactByPhone: new Map<string, string>(),
  contactByNameCompany: new Map<string, string>(),
  companyByDomain: new Map<string, string>(),
  companyByName: new Map<string, string>(),
});

describe("CSV parsing and column mapping", () => {
  it("parses CSV with BOM and maps aliases", () => {
    const rows = parseCsv("﻿First Name,Surname,E-mail,Mobile,Company Name\nJane,Doe,jane@acme.co.za,0821234567,Acme\n\n");
    expect(rows).toHaveLength(1);
    const mapping = detectMapping(Object.keys(rows[0]));
    expect(mapping).toEqual({ "First Name": "firstName", Surname: "lastName", "E-mail": "email", Mobile: "phone", "Company Name": "companyName" });
  });

  it("splits a full name column", () => {
    const m = applyMapping({ Name: "Pieter van der Merwe" }, { Name: "fullName" });
    expect(m.firstName).toBe("Pieter");
    expect(m.lastName).toBe("van der Merwe");
  });

  it("parses XLSX", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Leads");
    ws.addRow(["First Name", "Email"]);
    ws.addRow(["Sipho", "sipho@fynbos.example"]);
    ws.addRow([]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const rows = await parseUpload("leads.xlsx", buf);
    expect(rows).toEqual([{ "First Name": "Sipho", Email: "sipho@fynbos.example" }]);
  });

  it("rejects unknown file types", async () => {
    await expect(parseUpload("leads.pdf", Buffer.from(""))).rejects.toThrow(/Unsupported/);
  });
});

describe("validateRow", () => {
  it("normalises a good row and derives domain from a corporate email", () => {
    const v = validateRow({ firstName: "Jane", email: "Jane@Acme.co.za", phone: "082 123 4567", companyName: "Acme (Pty) Ltd", country: "South Africa" });
    expect(v.errors).toEqual([]);
    expect(v.row).toMatchObject({ email: "jane@acme.co.za", country: "ZA", phone: { e164: "+27821234567", type: "MOBILE" } });
    expect(v.row!.company).toMatchObject({ domain: "acme.co.za", normalizedName: "acme" });
  });

  it("never infers a company domain from free webmail", () => {
    const v = validateRow({ firstName: "Jane", email: "jane@gmail.com" });
    expect(v.row!.company.domain).toBeNull();
  });

  it("flags invalid data instead of importing it", () => {
    const v = validateRow({ email: "bad@", phone: "123" });
    expect(v.row).toBeNull();
    expect(v.errors).toEqual(expect.arrayContaining(["first name is required", 'invalid email "bad@"', expect.stringMatching(/invalid phone/)]));
  });

  it("warns for unreachable contacts and bad linkedin URLs", () => {
    const v = validateRow({ firstName: "Jane", linkedinUrl: "https://example.com/jane" });
    expect(v.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/no email or phone/), expect.stringMatching(/linkedin/)]));
  });
});

describe("planRows (dedupe)", () => {
  const cand = (n: number, m: Parameters<typeof validateRow>[0]): Candidate => {
    const v = validateRow(m);
    return { rowNumber: n, row: v.row, errors: v.errors, warnings: v.warnings };
  };

  it("skips in-file duplicates by email, phone, and name+company", () => {
    const plan = planRows(
      [
        cand(2, { firstName: "Jane", email: "jane@acme.co.za" }),
        cand(3, { firstName: "J", email: "JANE@acme.co.za" }),
        cand(4, { firstName: "Bob", phone: "0821234567" }),
        cand(5, { firstName: "Robert", phone: "+27821234567" }),
        cand(6, { firstName: "Ann", lastName: "Lee", companyName: "Acme Ltd" }),
        cand(7, { firstName: "ann", lastName: "LEE", companyName: "ACME" }),
        cand(8, { firstName: "" }),
      ],
      emptyIndex(),
    );
    expect(plan.map((p) => p.action)).toEqual(["CREATE", "SKIP_DUPLICATE", "CREATE", "SKIP_DUPLICATE", "CREATE", "SKIP_DUPLICATE", "INVALID"]);
    expect(plan[1].matchReason).toBe("duplicate of row 2 in this file");
  });

  it("merges into existing contacts, preferring email then phone", () => {
    const idx = emptyIndex();
    idx.contactByEmail.set("jane@acme.co.za", "c1");
    idx.contactByPhone.set("+27821234567", "c2");
    idx.companyByDomain.set("acme.co.za", "co1");
    const plan = planRows(
      [cand(2, { firstName: "Jane", email: "jane@acme.co.za", phone: "0821234567" }), cand(3, { firstName: "Bob", phone: "0821234567", email: "bob@other.example" })],
      idx,
    );
    expect(plan[0]).toMatchObject({ action: "MERGE", matchContactId: "c1", matchReason: "email", matchCompanyId: "co1" });
    // row 3 shares a phone with row 2 → in-file duplicate wins
    expect(plan[1].action).toBe("SKIP_DUPLICATE");
  });
});
