/**
 * Reshaping: unpivot (one column per month -> one row per month) and its
 * opposite, pivot wider (one row per month -> one column per month, with
 * the values summed, counted or picked).
 */
import { parseNumberLoose } from "../clean/values";
import type { Value } from "../table";

type Row = readonly (Value | boolean)[];

export interface UnpivotOptions {
  /** Name of the new column holding the old column names. Default "Attribute". */
  nameColumn?: string;
  /** Name of the new column holding the values. Default "Value". */
  valueColumn?: string;
  /** Leave out blank values. Default true. */
  skipBlanks?: boolean;
}

export interface UnpivotResult {
  header: string[];
  rows: Value[][];
  /** For each output row, the input row it came from. */
  sourceRow: number[];
}

const blank = (v: Value | boolean | undefined) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const plain = (v: Value | boolean | undefined): Value => (v === undefined ? null : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v);

/**
 * One output row per input row and value column: the ID columns repeated,
 * then the value column's name, then its value.
 */
export function unpivot(header: readonly string[], rows: readonly Row[], idCols: readonly number[], valueCols: readonly number[], opts: UnpivotOptions = {}): UnpivotResult {
  const skip = opts.skipBlanks ?? true;
  const out: Value[][] = [];
  const sourceRow: number[] = [];
  rows.forEach((r, i) => {
    for (const c of valueCols) {
      const v = r[c];
      if (skip && blank(v)) continue;
      out.push([...idCols.map((k) => plain(r[k])), header[c] ?? "", plain(v)]);
      sourceRow.push(i);
    }
  });
  return {
    header: [...idCols.map((k) => header[k] ?? ""), opts.nameColumn || "Attribute", opts.valueColumn || "Value"],
    rows: out,
    sourceRow,
  };
}

export type WiderAgg = "sum" | "count" | "first" | "avg" | "min" | "max";

export interface WiderResult {
  /** The row key values of each output row, in order of first appearance. */
  keys: Value[][];
  /** The new column labels, in order of first appearance ("(blank)" for a blank key). */
  columns: string[];
  /** values[row][column]: the aggregate, or null where nothing fell in that cell. */
  values: Value[][];
  /** Values that weren't numbers and so were left out of a sum, average, min or max. */
  skipped: number;
}

/** A key cell as text for matching ("100" and 100 match). */
function keyText(v: Value | boolean | undefined): string {
  if (blank(v)) return "";
  if (typeof v === "number") return String(v);
  return String(v).trim();
}

function asNumber(v: Value | boolean | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return parseNumberLoose(v);
  return null;
}

/**
 * One output row per distinct combination of the row key columns, one
 * output column per distinct value of `colKey`, holding `agg` of `valueCol`.
 */
export function pivotWider(rows: readonly Row[], rowKeys: readonly number[], colKey: number, valueCol: number, agg: WiderAgg = "sum"): WiderResult {
  const rowIndex = new Map<string, number>();
  const colIndex = new Map<string, number>();
  const keys: Value[][] = [];
  const columns: string[] = [];
  // per output row: column index -> running total, count, min, max and first value
  const cells: Map<number, { acc: number; n: number; min: number; max: number; first: Value }>[] = [];
  let skipped = 0;
  for (const r of rows) {
    const rk = rowKeys.map((k) => keyText(r[k])).join("\u0000");
    let ri = rowIndex.get(rk);
    if (ri === undefined) {
      ri = keys.length;
      rowIndex.set(rk, ri);
      keys.push(rowKeys.map((k) => plain(r[k])));
      cells.push(new Map());
    }
    const ck = keyText(r[colKey]);
    let ci = colIndex.get(ck);
    if (ci === undefined) {
      ci = columns.length;
      colIndex.set(ck, ci);
      columns.push(ck === "" ? "(blank)" : ck);
    }
    const v = r[valueCol];
    if (blank(v)) continue;
    let cell = cells[ri].get(ci);
    if (agg === "count" || agg === "first") {
      if (!cell) cells[ri].set(ci, (cell = { acc: 0, n: 0, min: 0, max: 0, first: plain(v) }));
      cell.n++;
      continue;
    }
    const x = asNumber(v);
    if (x === null) {
      skipped++;
      continue;
    }
    if (!cell) cells[ri].set(ci, (cell = { acc: 0, n: 0, min: Infinity, max: -Infinity, first: x }));
    cell.acc += x;
    cell.n++;
    if (x < cell.min) cell.min = x;
    if (x > cell.max) cell.max = x;
  }
  const values = cells.map((m) =>
    columns.map((_, ci) => {
      const c = m.get(ci);
      if (!c) return agg === "count" ? 0 : null;
      switch (agg) {
        case "count":
          return c.n;
        case "first":
          return c.first;
        case "avg":
          return c.acc / c.n;
        case "min":
          return c.min;
        case "max":
          return c.max;
        default:
          return c.acc;
      }
    }),
  );
  return { keys, columns, values, skipped };
}
