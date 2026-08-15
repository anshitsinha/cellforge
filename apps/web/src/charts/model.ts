/**
 * What a chart is, as plain data: the kind of chart, the cells it reads and
 * its options. Everything here is JSON-safe so a chart can be saved with the
 * workbook and replayed by actions ("chart.add" / "chart.update").
 */
import type { DateGroup, PivotAgg, PivotKey, ShowAs } from "@cellforge/core";

export type ChartType =
  | "column"
  | "bar"
  | "line"
  | "area"
  | "pie"
  | "scatter"
  | "combo"
  | "histogram"
  | "waterfall"
  | "pareto"
  | "benford"
  | "ageing";

export const CHART_TYPES: { type: ChartType; label: string }[] = [
  { type: "column", label: "Column" },
  { type: "bar", label: "Bar" },
  { type: "line", label: "Line" },
  { type: "area", label: "Area" },
  { type: "pie", label: "Pie" },
  { type: "scatter", label: "Scatter" },
  { type: "combo", label: "Combo (columns + lines)" },
  { type: "histogram", label: "Histogram" },
  { type: "waterfall", label: "Waterfall" },
  { type: "pareto", label: "Pareto" },
  { type: "benford", label: "Benford (first digits)" },
  { type: "ageing", label: "Ageing" },
];

/** A block of cells on one sheet, zero-based and inclusive. */
export interface ChartRange {
  sheetId: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** One cell whose value is used as a setting (an axis limit, an as-of date). */
export interface CellLink {
  sheetId: string;
  row: number;
  col: number;
}

/** A fixed number, a cell to read the number from, or null for automatic. */
export type Limit = number | CellLink | null;

/**
 * A pivot as saved data (the engine's PivotSpec with filter sets as lists).
 * Fields are column numbers of the sheet; `names` are their names when the
 * pivot was made, so the fields can be found again if columns move.
 */
export interface SavedPivot {
  rows: { field: number; group?: DateGroup }[];
  cols: { field: number; group?: DateGroup }[];
  values: { field: number; agg: PivotAgg; showAs?: ShowAs }[];
  filters: { field: number; group?: DateGroup; keep: PivotKey[] }[];
  subtotals?: boolean;
  grandTotals?: boolean;
  names?: string[];
}

/** A pivot chart reads a pivot of a sheet instead of a range of cells. */
export interface PivotChartSource {
  sheetId: string;
  pivot: SavedPivot;
}

export interface ChartSpec {
  id: string;
  type: ChartType;
  range: ChartRange;
  /** each column of the range is a series, or each row is */
  seriesIn: "columns" | "rows";
  /** the first row (series in columns) or column (in rows) holds series names */
  names: boolean;
  /** the first column (series in columns) or row (in rows) holds category labels, or x values for scatter */
  labels: boolean;
  title: string;
  xTitle: string;
  yTitle: string;
  /** title of the right-hand axis (combo, Pareto) */
  y2Title: string;
  yMin: Limit;
  yMax: Limit;
  xMin: Limit;
  xMax: Limit;
  stacked: boolean;
  /** number format for values; "" takes it from the first value cell */
  numFmt: string;
  /** number format for x values / labels; "" takes it from the first label cell */
  xNumFmt: string;
  /** combo: series (by index) drawn as lines rather than columns */
  lines: number[];
  /** combo: series (by index) on the right-hand axis */
  secondary: number[];
  /** histogram: bin width, or null to choose one */
  binWidth: number | null;
  /** histogram: how to choose the bin width when binWidth is null */
  binRule: "fd" | "sturges";
  /** ageing: the date to age from (null = today) */
  asOf: Limit;
  /** ageing: bucket upper bounds in days */
  buckets: number[];
  /** where the chart window sits, in CSS pixels */
  frame: { x: number; y: number; w: number; h: number };
  /**
   * A pivot chart: the chart draws this pivot of the sheet (worked out again
   * whenever the sheet changes); `range` only says which sheet it sits on.
   */
  pivot?: PivotChartSource;
}

export function defaultSpec(id: string, range: ChartRange, type: ChartType = "column"): ChartSpec {
  return {
    id,
    type,
    range,
    seriesIn: "columns",
    names: true,
    labels: true,
    title: "",
    xTitle: "",
    yTitle: "",
    y2Title: "",
    yMin: null,
    yMax: null,
    xMin: null,
    xMax: null,
    stacked: false,
    numFmt: "",
    xNumFmt: "",
    lines: [],
    secondary: [],
    binWidth: null,
    binRule: "fd",
    asOf: null,
    buckets: [30, 60, 90, 120],
    frame: { x: 120, y: 120, w: 560, h: 360 },
  };
}

// -----------------------------------------------------------------------------
// A1 text

/** "A" -> 0, "Z" -> 25, "AA" -> 26. */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colLetters(col: number): string {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,8})$/;
const COLS = /^\$?([A-Za-z]{1,3})$/;
/** a whole-column range ends here; the reader cuts it to the used rows */
export const LAST_ROW = 2 ** 31 - 1;

/** Parse "B2" (or "$B$2") to a zero-based cell. */
export function parseCell(text: string): { row: number; col: number } | null {
  const m = CELL.exec(text.trim());
  if (!m || Number(m[2]) < 1) return null;
  return { row: Number(m[2]) - 1, col: colIndex(m[1]) };
}

/**
 * Parse "A1:C20", "C20:A1", "B2" or whole columns "A:C". Returns the block in
 * order (top-left first) or null when the text isn't a range.
 */
export function parseRange(text: string): { top: number; left: number; bottom: number; right: number } | null {
  const parts = text.trim().replace(/^.*!/, "").split(":");
  if (parts.length > 2 || !parts[0]) return null;
  const b = parts[1] ?? parts[0];
  const ca = COLS.exec(parts[0]);
  const cb = COLS.exec(b);
  if (ca && cb) {
    const l = colIndex(ca[1]);
    const r = colIndex(cb[1]);
    return { top: 0, left: Math.min(l, r), bottom: LAST_ROW, right: Math.max(l, r) };
  }
  const p = parseCell(parts[0]);
  const q = parseCell(b);
  if (!p || !q) return null;
  return { top: Math.min(p.row, q.row), left: Math.min(p.col, q.col), bottom: Math.max(p.row, q.row), right: Math.max(p.col, q.col) };
}

export function formatRange(r: { top: number; left: number; bottom: number; right: number }): string {
  if (r.bottom >= LAST_ROW && r.top === 0) return `${colLetters(r.left)}:${colLetters(r.right)}`;
  const a = `${colLetters(r.left)}${r.top + 1}`;
  const b = `${colLetters(r.right)}${r.bottom + 1}`;
  return a === b ? a : `${a}:${b}`;
}

export function isLink(l: Limit): l is CellLink {
  return typeof l === "object" && l !== null;
}

/**
 * Parse what was typed for a limit: "" = automatic, a number, or a cell like
 * "F1" on `sheetId`. Returns undefined when it's none of those.
 */
export function parseLimit(text: string, sheetId: string): Limit | undefined {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ""));
  if (Number.isFinite(n)) return n;
  const c = parseCell(t);
  return c ? { sheetId, row: c.row, col: c.col } : undefined;
}

export function limitText(l: Limit): string {
  if (l === null) return "";
  if (typeof l === "number") return String(l);
  return `${colLetters(l.col)}${l.row + 1}`;
}
