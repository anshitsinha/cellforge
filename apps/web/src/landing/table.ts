/**
 * A small in-memory sheet for the light demos: a header row and rows of
 * values, laid out and formatted the way the app's templates lay out the
 * same sheets (bold grey header, dates as yyyy-mm-dd, amounts with brackets).
 * Editable, so a visitor can change a number and watch the engine re-run.
 */
import type { CellStyle, CellValue, DataSource } from "@cellforge/grid";
import { dateToSerial, formatValue } from "./engine";

/** The templates' header look (templates.ts `header()`). */
export const HEADER_STYLE: CellStyle = { bold: true, fill: "#e8eaed", color: "#202124" };
export const AMOUNT = "#,##0.00;(#,##0.00)";
export const DATE = "yyyy-mm-dd";

export interface TableOptions {
  /** number format per column */
  formats?: (string | null)[];
  /** blank rows under the data, so it looks like a sheet and not a list */
  spare?: number;
  /** extra style for a data cell (row is 0-based in `rows`) */
  styleOf?: (row: number, col: number) => CellStyle | null;
}

export class TableSource implements DataSource {
  readonly colCount: number;
  private spare: number;

  constructor(
    readonly header: string[],
    readonly rows: CellValue[][],
    private readonly opts: TableOptions = {},
  ) {
    this.colCount = header.length;
    this.spare = opts.spare ?? 4;
  }

  get rowCount(): number {
    return this.rows.length + 1 + this.spare;
  }

  getCell(row: number, col: number): CellValue {
    if (row === 0) return this.header[col] ?? null;
    return this.rows[row - 1]?.[col] ?? null;
  }

  getEditText(row: number, col: number): string {
    const v = this.getCell(row, col);
    if (v === null) return "";
    const fmt = row > 0 ? this.opts.formats?.[col] : null;
    if (typeof v === "number" && fmt === DATE) return formatValue(v, DATE).text;
    return String(v);
  }

  getStyle(row: number, col: number): CellStyle | null {
    if (row === 0) return HEADER_STYLE;
    if (row > this.rows.length) return null;
    const fmt = this.opts.formats?.[col];
    const extra = this.opts.styleOf?.(row - 1, col) ?? null;
    if (!fmt) return extra;
    return extra ? { numFmt: fmt, ...extra } : { numFmt: fmt };
  }

  formatValue(value: CellValue, style: CellStyle | null): { text: string; color?: string } {
    if (typeof value !== "number") return { text: value === null ? "" : String(value) };
    const f = formatValue(value, style?.numFmt);
    return f.color ? { text: f.text, color: f.color } : { text: f.text };
  }

  /** Set a cell from what was typed: numbers (1,234.50 or (12.00)) and dates in this column's format are read as such. */
  set(row: number, col: number, text: string): boolean {
    if (row < 1) return false;
    const i = row - 1;
    while (this.rows.length <= i) this.rows.push(Array<CellValue>(this.colCount).fill(null));
    const fmt = this.opts.formats?.[col];
    this.rows[i][col] = parseInput(text, fmt ?? null);
    return true;
  }
}

/** What a typed value becomes in a column with this format. */
export function parseInput(text: string, fmt: string | null): CellValue {
  const t = text.trim();
  if (!t) return null;
  if (fmt === DATE) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    if (m) return dateToSerial(+m[1], +m[2], +m[3]);
  }
  const neg = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[(),\s]/g, ""));
  if (t !== "" && /^[(]?-?[\d,]*\.?\d+[)]?$/.test(t.replace(/\s/g, "")) && Number.isFinite(n)) return neg ? -n : n;
  return t;
}
