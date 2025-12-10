import { CsvParser } from "@cellforge/core";
import type { CellRange, CellValue, DataSource } from "@cellforge/grid";

/**
 * Clipboard format is TSV - it's what Excel and Google Sheets put on the
 * clipboard as text/plain, so copying between them and us just works.
 */

function tsvField(value: CellValue): string {
  if (value === null) return "";
  const s = String(value);
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rangeToTsv(source: DataSource, range: CellRange): string {
  const lines: string[] = [];
  for (let r = range.top; r <= range.bottom; r++) {
    const cells: string[] = [];
    for (let c = range.left; c <= range.right; c++) cells.push(tsvField(source.getCell(r, c)));
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  const parser = new CsvParser((r) => rows.push(r), "\t");
  parser.push(text);
  parser.end();
  return rows;
}

export function rangeSize(range: CellRange): number {
  return (range.bottom - range.top + 1) * (range.right - range.left + 1);
}
