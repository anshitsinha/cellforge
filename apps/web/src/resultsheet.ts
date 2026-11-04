/**
 * Results sheets: what a tool hands back as a sheet (reconciliation lines,
 * join output, JE flags, compare results…). Every tool writes them through
 * here so they read like a finance workpaper, not a data dump:
 *
 *   row 1  title                      (bold, larger)
 *   row 2  one-line summary           (italic)
 *   row 3  totals of the money columns (live SUM formulas, only when useful)
 *   row 4  column headers             (bold, rule under, numbers right-aligned)
 *   row 5… the data, with the tool's number and date formats
 *
 * The rows down to the header are frozen; column widths are fitted to the
 * content (capped); columns that are empty all the way down are left out. No
 * fills or text colours are set, so the sheet reads the same in light and
 * dark themes. `headerRowOf` lets tools read such a sheet back (its header
 * is the last frozen row).
 */
import { formatValue, isDateFormat, Table, type ColumnData } from "@cellforge/core";
import type { Action } from "@cellforge/actions";
import { BlankSource, EditableSource, parseInput, type Stored } from "./editable";
import type { Workbook } from "./workbook";

export const MONEY_FMT = "#,##0.00;(#,##0.00)";
export const DATE_FMT = "yyyy-mm-dd";
export const INT_FMT = "#,##0";

export interface ResultSheetSpec {
  /** sheet name (cut to 31 characters) */
  name: string;
  /** the data columns; their names become the header row */
  columns: ColumnData[];
  /** number format per column ("" for none) */
  numFmts?: readonly string[];
  /** values to put over the data after it is laid out: [data row, column, value] (numbers inside text columns) */
  fixes?: ReadonlyArray<readonly [number, number, Stored]>;
  /** row 1 (default: the sheet name) */
  title?: string;
  /** row 2: one plain sentence saying what this is */
  summary?: string;
  /** which columns get a total: "auto" (default) totals money columns when there are 2+ rows; false for none */
  totals?: "auto" | false | readonly number[];
  /** keep columns that are empty all the way down (default: drop them) */
  keepEmpty?: boolean;
  /** where the data came from (lineage) */
  origin?: string;
}

/** Above this many cells the sheet keeps the column names in the grid header instead of a title block (cells are cheap; this is a safety net). */
const MAX_LAYOUT_CELLS = 1_500_000;
const MIN_W = 56;
const MAX_W = 360;
const CHAR_W = 7.2;
const PAD = 18;
const RULE = { style: "thin" as const, color: "#9aa0a6" };

const isMoneyFmt = (f: string) => /#,##0\.0+/.test(f) && !/%/.test(f);
const NOT_SUMMED = /\b(row|rows|rank|score|group|days?|weight|no|number|id|year|period|line)\b|%/i;

function colLetter(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellOf(col: ColumnData, r: number): string | number | null {
  if (col.kind === "number") {
    const v = col.values[r];
    return Number.isNaN(v) ? null : v;
  }
  const code = col.codes[r];
  return code === 0 ? null : col.dict[code - 1];
}

const rowsOf = (c: ColumnData | undefined) => (!c ? 0 : c.kind === "number" ? c.values.length : c.codes.length);

function isEmptyColumn(col: ColumnData): boolean {
  if (col.kind === "number") {
    for (const v of col.values) if (!Number.isNaN(v)) return false;
    return true;
  }
  for (const c of col.codes) if (c !== 0 && col.dict[c - 1] !== "") return false;
  return true;
}

/** Which columns get totals. */
export function totalColumns(spec: Pick<ResultSheetSpec, "columns" | "numFmts" | "totals">, rows: number): number[] {
  if (spec.totals === false) return [];
  if (Array.isArray(spec.totals)) return [...(spec.totals as readonly number[])];
  if (rows < 2) return [];
  const out: number[] = [];
  spec.columns.forEach((c, i) => {
    if (c.kind === "number" && isMoneyFmt(spec.numFmts?.[i] ?? "") && !NOT_SUMMED.test(c.name)) out.push(i);
  });
  return out;
}

/** A width in px for text shown in a column (header text is bold, so a little wider). */
export function fitWidth(texts: Iterable<string>, header = ""): number {
  let chars = header.length * 1.08;
  for (const t of texts) if (t.length > chars) chars = t.length;
  return Math.round(Math.min(MAX_W, Math.max(MIN_W, chars * CHAR_W + PAD)));
}

export interface ResultLayout {
  source: EditableSource;
  /** view row of the header */
  headerRow: number;
  /** view row of the first data row */
  firstRow: number;
  /** the columns kept (indices into spec.columns) */
  kept: number[];
}

/** Lay a results sheet out (pure: no workbook needed). */
export function buildResultSheet(spec: ResultSheetSpec): ResultLayout {
  const rows = rowsOf(spec.columns[0]);
  const fixed = new Set((spec.fixes ?? []).map(([, c]) => c));
  const kept = spec.columns.map((_, i) => i).filter((i) => spec.keepEmpty || fixed.has(i) || !isEmptyColumn(spec.columns[i]) || spec.columns.length === 1);
  const fmts = kept.map((i) => spec.numFmts?.[i] ?? "");
  const cols = kept.map((i) => spec.columns[i]);
  const totalsAt = totalColumns({ columns: cols, numFmts: fmts, totals: Array.isArray(spec.totals) ? (spec.totals as number[]).map((t) => kept.indexOf(t)).filter((t) => t >= 0) : spec.totals }, rows);

  // very large: the plain layout (names in the grid's header), still formatted and fitted
  if (rows * Math.max(1, cols.length) > MAX_LAYOUT_CELLS) {
    const source = new EditableSource(new Table(cols), 5);
    for (const [r, c, v] of spec.fixes ?? []) if (kept.indexOf(c) >= 0) source.setCell(r, kept.indexOf(c), v);
    fmts.forEach((f, c) => f && source.styles.apply(c, "all", { numFmt: f }));
    cols.forEach((col, c) => source.setColWidths([c], widthFor(col, fmts[c], rows)));
    return { source, headerRow: -1, firstRow: 0, kept };
  }

  const title = spec.title ?? spec.name;
  const lead: Array<"title" | "summary" | "totals"> = ["title"];
  if (spec.summary) lead.push("summary");
  if (totalsAt.length) lead.push("totals");
  const headerRow = lead.length;
  const first = headerRow + 1;
  const width = Math.max(1, cols.length);
  const source = new EditableSource(new BlankSource(first + rows, width), 5);
  const edits: { row: number; col: number; value: Stored }[] = [];
  edits.push({ row: 0, col: 0, value: title });
  if (spec.summary) edits.push({ row: lead.indexOf("summary"), col: 0, value: spec.summary });
  cols.forEach((col, c) => {
    edits.push({ row: headerRow, col: c, value: col.name });
    for (let r = 0; r < rows; r++) {
      const v = cellOf(col, r);
      if (v !== null && v !== "") edits.push({ row: first + r, col: c, value: v });
    }
  });
  for (const [r, c, v] of spec.fixes ?? []) {
    const k = kept.indexOf(c);
    if (k >= 0) edits.push({ row: first + r, col: k, value: v });
  }
  const totalsRow = lead.indexOf("totals");
  if (totalsRow >= 0) {
    const labelCol = [...Array(width).keys()].find((c) => !totalsAt.includes(c)) ?? -1;
    if (labelCol >= 0) edits.push({ row: totalsRow, col: labelCol, value: "Total" });
    for (const c of totalsAt) {
      const L = colLetter(c);
      edits.push({ row: totalsRow, col: c, value: parseInput(`=SUM(${L}${first + 1}:${L}${first + rows})`) });
    }
  }
  source.loadEdits(edits);

  // looks
  const all = (r: number): [number, number][] => [[r, r]];
  source.styles.apply(0, all(0), { bold: true, size: 14 });
  if (spec.summary) source.styles.apply(0, all(lead.indexOf("summary")), { italic: true });
  cols.forEach((col, c) => {
    const f = fmts[c];
    const numeric = col.kind === "number";
    source.styles.apply(c, all(headerRow), { bold: true, borderBottom: RULE, ...(numeric ? { align: "right" } : {}) });
    if (f && rows) source.styles.apply(c, [[first, first + rows - 1]], { numFmt: f });
    if (totalsRow >= 0 && totalsAt.includes(c)) source.styles.apply(c, all(totalsRow), { bold: true, numFmt: f || MONEY_FMT, borderBottom: { style: "double", color: RULE.color } });
    source.setColWidths([c], widthFor(col, f, rows));
  });
  if (totalsRow >= 0) {
    const labelCol = [...Array(width).keys()].find((c) => !totalsAt.includes(c));
    if (labelCol !== undefined) source.styles.apply(labelCol, all(totalsRow), { bold: true });
  }
  source.frozen = { rows: first, cols: 0 };
  return { source, headerRow, firstRow: first, kept };
}

/** Width for a column from a sample of its values as shown. */
function widthFor(col: ColumnData, fmt: string, rows: number): number {
  const texts: string[] = [];
  const step = rows > 2000 ? Math.ceil(rows / 2000) : 1;
  for (let r = 0; r < rows; r += step) {
    const v = cellOf(col, r);
    if (v === null) continue;
    texts.push(typeof v === "number" ? formatValue(v, fmt || "General").text : v);
  }
  // money columns also hold the total, which is wider than any line
  if (col.kind === "number" && isMoneyFmt(fmt)) {
    let sum = 0;
    for (const v of col.values) if (!Number.isNaN(v)) sum += Math.abs(v);
    texts.push(formatValue(-sum, fmt).text);
  }
  return fitWidth(texts, col.name);
}

/**
 * The header row of a sheet laid out by `buildResultSheet` (or any sheet
 * with a title block frozen above its header): the last frozen row, when
 * the grid shows no column names and that row is all text. -1 otherwise.
 */
export function headerRowOf(src: Pick<EditableSource, "frozen" | "getCell" | "usedRange" | "getColumnName">): number {
  const { cols } = src.usedRange();
  if (Array.from({ length: cols }, (_, c) => src.getColumnName?.(c) ?? "").some(Boolean)) return -1;
  const r = src.frozen.rows - 1;
  if (r < 1) return -1;
  let texts = 0;
  for (let c = 0; c < cols; c++) {
    const v = src.getCell(r, c);
    if (v === null || v === "") continue;
    if (typeof v !== "string") return -1;
    texts++;
  }
  return texts >= 1 ? r : -1;
}

/** Strip characters sheet names can't hold and cut to 31. */
export function sheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31);
}

export interface ResultWriter {
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  /** given: `replace` can find the sheets an earlier run made */
  workbook?: () => Workbook;
}

/**
 * Add results sheets to the workbook. With `replace`, a sheet of the same
 * name made by an earlier run is swapped for the new one (so running a
 * test again updates its sheet instead of adding "… (2)").
 * Returns the names the sheets got.
 */
export async function addResultSheets(d: ResultWriter, sheets: readonly ResultSheetSpec[], opts: { replace?: boolean } = {}): Promise<string[]> {
  const names: string[] = [];
  for (const s of sheets) {
    const name = sheetName(s.name);
    if (opts.replace && d.workbook) {
      const old = d.workbook().byName(name);
      if (old) await d.run({ type: "sheet.delete", params: { sheet: old.id } });
    }
    const { source } = buildResultSheet(s);
    await d.run({ type: "sheet.insert", params: { name, source: d.putBlob(source), ...(s.origin ? { origin: s.origin } : {}) } });
    names.push(d.workbook?.().sheets.at(-1)?.name ?? name);
  }
  return names;
}

/** Is this format a date (for callers that pick formats by column). */
export const isDateFmt = (f: string) => !!f && isDateFormat(f);
