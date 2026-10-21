import Papa from "papaparse";
import ExcelJS from "exceljs";

export type RawRow = Record<string, string>;

const MAX_ROWS = 20_000;

export async function parseUpload(fileName: string, data: Buffer): Promise<RawRow[]> {
  const lower = fileName.toLowerCase();
  let rows: RawRow[];
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) rows = parseCsv(data.toString("utf8"));
  else if (lower.endsWith(".xlsx")) rows = await parseXlsx(data);
  else throw new Error("Unsupported file type. Upload .csv or .xlsx");
  if (rows.length > MAX_ROWS) throw new Error(`File has ${rows.length} rows; maximum is ${MAX_ROWS}`);
  return rows;
}

export function parseCsv(text: string): RawRow[] {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return res.data.map((r) => trimRow(r));
}

export async function parseXlsx(data: Buffer): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = cellText(cell.value).trim();
  });
  const rows: RawRow[] = [];
  ws.eachRow((row, idx) => {
    if (idx === 1) return;
    const r: RawRow = {};
    let any = false;
    headers.forEach((h, col) => {
      if (!h) return;
      const v = cellText(row.getCell(col).value).trim();
      if (v) any = true;
      r[h] = v;
    });
    if (any) rows.push(r);
  });
  return rows;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("text" in v && typeof v.text === "string") return v.text; // hyperlink
    if ("result" in v) return String(v.result ?? ""); // formula
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}

function trimRow(r: Record<string, string>): RawRow {
  const out: RawRow = {};
  for (const [k, v] of Object.entries(r)) if (k) out[k] = (v ?? "").toString().trim();
  return out;
}
