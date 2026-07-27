/**
 * Reading a set of files (CSV and other text, Excel, JSON, Parquet) as
 * columns, ready to be lined up and combined into one sheet.
 */
import { jsonToColumns, profileColumn, parseAs, readParquet, type ColumnData, type FilePart } from "@cellforge/core";
import { sheetText } from "./cleanup";
import { importCsv } from "./importer";
import { openXlsx } from "./xlsxio";
import { noteFileRead } from "./evidence";

export const COMBINABLE = /\.(csv|tsv|txt|xlsx|xlsm|json|jsonl|ndjson|parquet)$/i;

/**
 * Text columns whose values are all numbers or dates (in any of the messy
 * forms clean-up understands) become real numbers or dates.
 */
export function typeTextColumns(columns: ColumnData[], numFmts: (string | undefined)[] = []): { columns: ColumnData[]; numFmts: (string | undefined)[] } {
  const fmts = [...numFmts];
  const out = columns.map((col, c) => {
    if (col.kind !== "string") return col;
    const values = Array.from(col.codes, (code) => (code ? col.dict[code - 1] : ""));
    const p = profileColumn(values);
    if ((p.type !== "number" && p.type !== "date") || p.misfits.length) return col;
    const nums = new Float64Array(values.length).fill(NaN);
    values.forEach((v, i) => {
      if (v) nums[i] = parseAs(v, p) ?? NaN;
    });
    fmts[c] = p.numFmt ?? fmts[c];
    return { kind: "number" as const, name: col.name, values: nums };
  });
  return { columns: out, numFmts: fmts };
}

/** Rows of text with a header row, as typed columns. */
export function textToColumns(header: string[], rows: string[][]): { columns: ColumnData[]; numFmts: (string | undefined)[] } {
  const columns: ColumnData[] = header.map((name, c) => {
    const dict: string[] = [];
    const lookup = new Map<string, number>();
    const codes = new Uint32Array(rows.length);
    rows.forEach((r, i) => {
      const s = r[c] ?? "";
      if (!s) return;
      let code = lookup.get(s);
      if (code === undefined) {
        code = dict.push(s);
        lookup.set(s, code);
      }
      codes[i] = code;
    });
    return { kind: "string", name, codes, dict };
  });
  return typeTextColumns(columns);
}

export async function readPart(file: File): Promise<FilePart> {
  noteFileRead(file, "combine");
  const name = file.name;
  if (/\.xls[xm]$/i.test(name)) {
    const wb = await openXlsx(await file.arrayBuffer());
    const src = (wb.visible[0] ?? wb.sheets[0]).source;
    const text = sheetText(src); // the first row is the header (or the sheet's column names)
    const header = (text[0] ?? []).map((h, i) => h || `column_${i + 1}`);
    const rows = text.slice(1).filter((r) => r.some(Boolean));
    return { name, ...textToColumns(header, rows) };
  }
  if (/\.parquet$/i.test(name)) {
    const { columns, dateColumns } = await readParquet(await file.arrayBuffer());
    const numFmts: (string | undefined)[] = [];
    for (const d of dateColumns) numFmts[d.col] = d.withTime ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd";
    return { name, columns, numFmts };
  }
  if (/\.(json|jsonl|ndjson)$/i.test(name)) return { name, ...typeTextColumns(jsonToColumns(await file.text())) };
  const { table } = await importCsv(file, () => {}, {}).result;
  return { name, ...typeTextColumns(table.columns) };
}
