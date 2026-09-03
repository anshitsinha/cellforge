/**
 * Turning a printed report back into a table: find the header row, drop
 * the rows that aren't data (titles, blanks, subtotals and totals, page
 * footers, headers repeated on every page), fill down group labels that
 * only appear on a group's first row, and flatten a two-row header.
 */
import { parseDateLoose } from "./values";

export interface DroppedRow {
  /** row in the original */
  row: number;
  reason: "title" | "blank" | "total" | "footer" | "repeated header";
  text: string;
}

export interface Unwrapped {
  header: string[];
  /** the data rows, as strings */
  rows: string[][];
  /** which original row each data row came from */
  sourceRows: number[];
  headerRow: number;
  dropped: DroppedRow[];
  /** columns whose blanks were filled with the label above */
  filledDown: number[];
}

const TOTAL = /^(sub[\s-]?total|total|grand total|net total|balance c\/f|balance b\/f|carried forward|brought forward)\b|\btotals?:?\s*$/i;
/** a running-balance line (the whole cell): statements often date these, so they're looked for past a date */
const BALANCE_LINE = /^((opening|closing|starting|ending|previous|new) balance|balance (brought|carried) forward|balance [bc]\/f|(brought|carried) forward)\s*:?$/i;
const FOOTER = /^(page\s+\d+(\s+of\s+\d+)?|printed\b|report (generated|run)\b|run date\b|confidential\b|end of report\b|\*\*\*)/i;

const nonEmpty = (row: string[]) => row.filter((c) => c.trim() !== "").length;
const looksNumeric = (c: string) => /^[\s(+\-$€£¥]*[\d.,'\s]+\)?\s*(%|cr|dr)?$/i.test(c.trim()) && /\d/.test(c);
const looksLikeDate = (c: string) => /^\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}$/.test(c.trim()) || parseDateLoose(c) !== null;
const textCells = (row: string[]) => row.filter((c) => c.trim() !== "" && !looksNumeric(c)).length;

/** The header row: the first row of mostly-text cells, at least as wide as most of the data below it. */
export function findHeaderRow(rows: string[][]): number {
  return headerRowOf((r) => rows[r], rows.length);
}

function headerRowOf(row: (r: number) => string[], n: number): number {
  const widths = new Int32Array(n);
  for (let r = 0; r < n; r++) widths[r] = nonEmpty(row(r));
  const sorted = Array.from(widths.filter((w) => w > 0)).sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length * 0.75)] ?? 0;
  for (let r = 0; r < Math.min(n, 200); r++) {
    const w = widths[r];
    if (w < Math.max(2, typical * 0.6)) continue;
    if (textCells(row(r)) / w < 0.7) continue;
    // the next non-empty row should have numbers or at least differ from this one
    return r;
  }
  return 0;
}

export function unwrapReport(rows: string[][]): Unwrapped {
  const { header, kept, width, headerRow, dropped } = unwrapCore((r) => rows[r], rows.length);
  const out = kept.map((r) => Array.from({ length: width }, (_, i) => (rows[r][i] ?? "").trim()));
  const columns = Array.from({ length: width }, (_, c) => out.map((row) => row[c]));
  const filledDown = fillDown(columns, out.length);
  for (const c of filledDown) for (let k = 0; k < out.length; k++) out[k][c] = columns[c][k];
  return { header, rows: out, sourceRows: kept, headerRow, dropped, filledDown };
}

/** The header, which rows are data, and what was dropped, for rows read one at a time. */
function unwrapCore(row: (r: number) => string[], n: number): { header: string[]; kept: number[]; width: number; headerRow: number; dropped: DroppedRow[] } {
  const headerRow = headerRowOf(row, n);
  const dropped: DroppedRow[] = [];
  for (let r = 0; r < headerRow; r++) {
    const cells = row(r);
    if (nonEmpty(cells)) dropped.push({ row: r, reason: "title", text: cells.filter(Boolean).join(" ") });
  }

  const headerCells = n > headerRow ? row(headerRow) : null;
  let header = headerCells?.map((c) => c.trim()) ?? [];
  let dataStart = headerRow + 1;
  // a second header row (Q1 Q2 under Revenue Cost): text-only, and the row above has gaps
  const next = headerRow + 1 < n ? row(headerRow + 1) : undefined;
  if (next && nonEmpty(next) >= 2 && textCells(next) === nonEmpty(next) && header.some((h) => h === "")) {
    let carry = "";
    header = header.map((h, i) => {
      if (h) carry = h;
      const below = (next[i] ?? "").trim();
      return [h || carry, below].filter(Boolean).join(" ");
    });
    dataStart++;
  }
  let width = header.length;
  for (let r = dataStart; r < n; r++) {
    const w = row(r).length;
    if (w > width) width = w;
  }
  header = Array.from({ length: width }, (_, i) => header[i] || `column_${i + 1}`);
  const headerKey = headerCells ? headerCells.map((c) => c.trim().toLowerCase()).join("|") : "";

  const kept: number[] = [];
  for (let r = dataStart; r < n; r++) {
    const cells = row(r);
    const text = cells.map((c) => c.trim()).filter(Boolean).join(" ");
    if (!text) {
      dropped.push({ row: r, reason: "blank", text: "" });
      continue;
    }
    if (cells.map((c) => c.trim().toLowerCase()).join("|") === headerKey) {
      dropped.push({ row: r, reason: "repeated header", text });
      continue;
    }
    const firstText = cells.find((c) => c.trim() !== "" && !looksNumeric(c))?.trim() ?? "";
    if (TOTAL.test(firstText)) {
      dropped.push({ row: r, reason: "total", text });
      continue;
    }
    const label = cells.find((c) => c.trim() !== "" && !looksNumeric(c) && !looksLikeDate(c))?.trim() ?? "";
    if (BALANCE_LINE.test(label)) {
      dropped.push({ row: r, reason: "total", text });
      continue;
    }
    if (FOOTER.test(text) || (nonEmpty(cells) === 1 && /page\s+\d+/i.test(text))) {
      dropped.push({ row: r, reason: "footer", text });
      continue;
    }
    kept.push(r);
  }
  return { header, kept, width, headerRow, dropped };
}

/**
 * Group labels: a text column where most rows are blank and each value
 * starts a run gets the label above filled into its blanks (in place).
 * Returns the columns filled.
 */
function fillDown(columns: string[][], n: number): number[] {
  const filledDown: number[] = [];
  for (let c = 0; c < columns.length; c++) {
    const vals = columns[c];
    let filled = 0;
    let numeric = false;
    for (let k = 0; k < n; k++)
      if (vals[k]) {
        filled++;
        if (!numeric && looksNumeric(vals[k])) numeric = true;
      }
    if (filled < 2 || filled > n * 0.6) continue;
    if (numeric) continue;
    if (!vals[0]) continue;
    // other columns must have data on the blank rows, or it's just sparse
    let blanksWithData = 0;
    for (let k = 0; k < n; k++) if (!vals[k] && columns.some((col, x) => x !== c && col[k])) blanksWithData++;
    if (blanksWithData < (n - filled) * 0.8) continue;
    let last = "";
    for (let k = 0; k < n; k++) {
      if (vals[k]) last = vals[k];
      else vals[k] = last;
    }
    filledDown.push(c);
  }
  return filledDown;
}

/** A table held as columns, the way a large file is kept: rows may be ragged, so each row's width (cells as read) is kept too. */
export interface ColumnTable {
  /** columns[c][r]: the cell, "" past the row's width */
  columns: string[][];
  /** cells in each row as read */
  widths: ArrayLike<number>;
  rows: number;
}

/** Rows read one at a time (e.g. from CsvParser) kept as columns: one array per column and a width per row, no array per row. */
export class ColumnCollector implements ColumnTable {
  columns: string[][] = [];
  rows = 0;
  private w = new Uint16Array(1024);

  get widths(): Uint16Array {
    return this.w.subarray(0, this.rows);
  }

  add(row: readonly string[]): void {
    const r = this.rows++;
    if (r === this.w.length) {
      const next = new Uint16Array(this.w.length * 2);
      next.set(this.w);
      this.w = next;
    }
    this.w[r] = row.length;
    while (this.columns.length < row.length) this.columns.push(new Array<string>(r).fill(""));
    for (let c = 0; c < this.columns.length; c++) this.columns[c].push(c < row.length ? row[c] : "");
  }
}

/** Row r of a column table, as read (its own width). */
export function tableRow(t: ColumnTable, r: number): string[] {
  const n = t.widths[r];
  const out = new Array<string>(n);
  for (let c = 0; c < n; c++) out[c] = t.columns[c][r];
  return out;
}

export interface UnwrappedColumns extends Omit<Unwrapped, "rows" | "sourceRows"> {
  /** the data, as columns (columns[c][k] is data row k) */
  columns: string[][];
  rows: number;
  /** which original row each data row came from */
  sourceRows: Int32Array;
}

/**
 * unwrapReport for a table kept as columns, without an array per row: the
 * same rows dropped, the same header, the same fill-down. The table's
 * columns are compacted in place into the data columns (and trimmed), so
 * the original isn't usable afterwards; no second copy of a large file is
 * made.
 */
export function unwrapColumns(t: ColumnTable): UnwrappedColumns {
  const core = unwrapCore((r) => tableRow(t, r), t.rows);
  const { header, kept, width } = core;
  const n = kept.length;
  const columns: string[][] = [];
  for (let c = 0; c < width; c++) {
    // in place: kept is ascending, so kept[k] >= k is read before it is written over
    const col = t.columns[c] ?? [];
    for (let k = 0; k < n; k++) col[k] = (col[kept[k]] ?? "").trim();
    col.length = n;
    columns.push(col);
  }
  t.columns.length = 0;
  const filledDown = fillDown(columns, n);
  return { header, columns, rows: n, sourceRows: Int32Array.from(kept), headerRow: core.headerRow, dropped: core.dropped, filledDown };
}
