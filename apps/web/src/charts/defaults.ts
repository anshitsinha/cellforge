/**
 * Sensible first charts. A ledger has a date, a reference, a vendor, an
 * account code and an amount; charting "every column" gives a meaningless
 * picture. Here each column is profiled (date, number, text, identifier or
 * code) and a chart is suggested: an amount over time, or summed by a
 * category, never the IDs or account codes as series.
 *
 * Pure: profileColumns reads cells through ChartSource (a sample of rows,
 * so it stays quick on 100M rows), suggestChart only looks at the profile.
 */
import { isDateFormat, type DateGroup } from "@cellforge/core";
import type { CellValue } from "@cellforge/grid";
import { clampRange, type ChartSource } from "./data";
import type { ChartRange, ChartType } from "./model";

export type ColumnKind = "date" | "number" | "text" | "empty";

export interface ColumnInfo {
  /** sheet column */
  col: number;
  name: string;
  kind: ColumnKind;
  /** non-blank values seen (in the sample) */
  count: number;
  /** distinct non-blank values seen */
  distinct: number;
  /** every number seen is a whole number */
  integer: boolean;
  /** numbers (or dates) never go down */
  sorted: boolean;
  min: number;
  max: number;
  /** longest text seen, in characters */
  maxLength: number;
}

export type ChartSuggestion =
  | { kind: "range"; type: ChartType; labelCol: number | null; series: number[]; title: string }
  | { kind: "pivot"; type: ChartType; rowField: number; group?: DateGroup; values: number[]; agg: "sum" | "count"; title: string }
  | { kind: "none"; reason: string };

/** Header words that mark an identifier or a code, never a measure. */
const ID_WORDS = /(^|[\s_\-./#])(id|ids|ref|refs|reference|no|nr|num|number|code|codes|account|acct|gl|key|invoice|inv|doc|document|voucher|je|batch|sku|ean|upc|zip|postcode|postal|phone|tel|iban|seq|sequence|line|row|index|#)($|[\s_\-./#:])/i;
/** Header words that mark a measure worth plotting. */
const MEASURE_WORDS = /amount|amt|total|value|balance|debit|credit|sales|revenue|income|cost|expense|spend|price|net|gross|qty|quantity|units|volume|budget|actual|forecast|variance|profit|margin|fee|paid|due|outstanding|tax|vat amount|turnover|count/i;
/** Header words for dates. */
const DATE_WORDS = /date|day|period|month|posted|posting|when|time/i;

const SAMPLE = 5000;

/**
 * Profile the columns of `range` (the first row holds names when `names`).
 * Reads at most a few thousand rows, spread over the range.
 */
export function profileColumns(src: ChartSource, range: ChartRange, names: boolean, columnName?: (col: number) => string | undefined): ColumnInfo[] {
  const r = clampRange(src, range);
  const first = r.top + (names ? 1 : 0);
  const rows = Math.max(0, r.bottom - first + 1);
  const step = rows > SAMPLE ? rows / SAMPLE : 1;
  const out: ColumnInfo[] = [];
  for (let c = r.left; c <= r.right; c++) {
    const head = names ? src.getCell(r.top, c) : null;
    const name = head !== null && head !== "" ? String(head) : (columnName?.(c) ?? "");
    const values: CellValue[] = [];
    for (let k = 0; k < Math.min(rows, SAMPLE); k++) values.push(src.getCell(first + Math.floor(k * step), c));
    const fmt = rows ? (src.getStyle?.(first, c)?.numFmt ?? "") : "";
    out.push(describeColumn(c, name, values, isDateFormat(fmt)));
  }
  return out;
}

/** The profile of one column from its values (pure). */
export function describeColumn(col: number, name: string, values: readonly CellValue[], dateFormatted = false): ColumnInfo {
  let numbers = 0;
  let texts = 0;
  let integer = true;
  let sorted = true;
  let prev = -Infinity;
  let min = Infinity;
  let max = -Infinity;
  let maxLength = 0;
  const seen = new Set<string | number>();
  for (const v of values) {
    if (v === null || v === "" || v === undefined) continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
      numbers++;
      if (!Number.isInteger(v)) integer = false;
      if (v < prev) sorted = false;
      prev = v;
      if (v < min) min = v;
      if (v > max) max = v;
      seen.add(v);
    } else {
      const s = String(v);
      texts++;
      maxLength = Math.max(maxLength, s.length);
      seen.add(s);
    }
  }
  const count = numbers + texts;
  let kind: ColumnKind = "empty";
  if (count) kind = numbers >= count * 0.9 ? (dateFormatted ? "date" : "number") : "text";
  if (kind === "number" && !dateFormatted && DATE_WORDS.test(name) && integer && min > 20000 && max < 80000 && !MEASURE_WORDS.test(name)) kind = "date";
  return { col, name, kind, count, distinct: seen.size, integer: kind !== "text" && integer, sorted: kind !== "text" && sorted, min: count && kind !== "text" ? min : 0, max: count && kind !== "text" ? max : 0, maxLength };
}

/**
 * An identifier or a code: plotted as a series it means nothing. Named like
 * one (Ref, Account, Invoice no, ID), or whole numbers that count up one by
 * one, or a handful of 4+ digit whole numbers repeated (account codes).
 */
export function isIdLike(c: ColumnInfo): boolean {
  if (c.kind === "date" || c.kind === "empty") return false;
  if (ID_WORDS.test(c.name) && !MEASURE_WORDS.test(c.name.replace(ID_WORDS, " "))) return true;
  if (c.kind !== "number" || !c.integer || c.count < 3) return false;
  // 1, 2, 3, … or 10001, 10002, …: a row number or document number
  if (c.sorted && c.distinct === c.count && c.max - c.min === c.count - 1) return true;
  // 6000, 6010, 6020 over and over: account or cost-centre codes
  if (c.min >= 1000 && c.distinct <= Math.max(3, Math.min(30, c.count / 3))) return true;
  return false;
}

/** Number columns worth plotting, best first (named like an amount), at most `limit`. */
export function measureColumns(cols: readonly ColumnInfo[], limit = 4): number[] {
  const nums = cols.filter((c) => c.kind === "number" && !isIdLike(c) && c.count > 0);
  const named = nums.filter((c) => MEASURE_WORDS.test(c.name));
  const pick = named.length ? named : nums;
  return pick.slice(0, limit).map((c) => c.col);
}

/** How to group a date axis that spans min..max (spreadsheet serials). */
export function dateGroupFor(min: number, max: number): DateGroup {
  const span = max - min;
  if (span <= 62) return "day";
  if (span <= 3 * 366) return "month";
  return "year";
}

const GROUP_WORD: Record<DateGroup, string> = { day: "day", month: "month", quarter: "quarter", year: "year" };

/**
 * The chart to start with. `canPivot` says whether summing by a category
 * (a pivot chart of the whole sheet) is possible; without it, only the
 * cells of the range are drawn.
 */
export function suggestChart(cols: readonly ColumnInfo[], opts: { canPivot?: boolean } = {}): ChartSuggestion {
  const used = cols.filter((c) => c.kind !== "empty");
  if (!used.length) return { kind: "none", reason: "There's nothing to chart here yet. Select a block of cells with numbers in it." };
  const measures = measureColumns(cols);
  const nameOf = (col: number) => cols.find((c) => c.col === col)?.name || "values";
  const date = used.find((c) => c.kind === "date");
  const cats = used.filter((c) => c.kind === "text" && !isIdLike(c));
  // a category that summarises: repeats, and not too many distinct values
  const cat = cats.find((c) => c.distinct < c.count && c.distinct <= 60) ?? cats.find((c) => c.distinct <= 60) ?? null;
  const labelText = cats[0] ?? used.find((c) => c.kind === "text") ?? null;

  if (!measures.length) {
    if (opts.canPivot && cat && cat.distinct < cat.count) return { kind: "pivot", type: cat.distinct > 8 ? "bar" : "column", rowField: cat.col, values: [cat.col], agg: "count", title: `Count of rows by ${cat.name || "category"}` };
    return { kind: "none", reason: "None of these columns hold amounts to chart (IDs, codes and text are left out). Select a column of numbers." };
  }
  const what = measures.length === 1 ? nameOf(measures[0]) : measures.map(nameOf).join(", ");

  if (date) {
    const unique = date.distinct === date.count;
    if (unique && date.sorted) return { kind: "range", type: "line", labelCol: date.col, series: measures, title: `${what} over time` };
    if (opts.canPivot) {
      const group = dateGroupFor(date.min, date.max);
      return { kind: "pivot", type: "column", rowField: date.col, group, values: measures.slice(0, 2), agg: "sum", title: `${measures.slice(0, 2).map(nameOf).join(" and ")} by ${GROUP_WORD[group]}` };
    }
    return { kind: "range", type: unique ? "line" : "column", labelCol: date.col, series: measures, title: `${what} by ${date.name || "date"}` };
  }
  if (cat && opts.canPivot && cat.distinct < cat.count) {
    return { kind: "pivot", type: cat.distinct > 8 ? "bar" : "column", rowField: cat.col, values: measures.slice(0, 1), agg: "sum", title: `${nameOf(measures[0])} by ${cat.name || "category"}` };
  }
  const label = labelText && labelText.col !== measures[0] ? labelText : null;
  const long = (label?.maxLength ?? 0) > 14 || (label?.count ?? 0) > 12;
  return { kind: "range", type: label && long ? "bar" : "column", labelCol: label?.col ?? null, series: measures, title: label ? `${what} by ${label.name || "item"}` : what };
}
