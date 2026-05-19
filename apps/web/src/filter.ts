/**
 * Filters: per-column conditions that hide the rows that don't match. The
 * conditions are plain data (so actions can carry them and files can save
 * them); which rows they hide is worked out from the sheet and kept by row
 * id, so sorting and editing don't scramble it. Like Excel, a filter is
 * applied when it's set and again on "Reapply", not on every edit.
 */
import type { CellValue } from "@cellforge/grid";

export type TextOp = "contains" | "notContains" | "begins" | "ends" | "equals" | "notEquals";
export type NumberOp = ">" | ">=" | "<" | "<=" | "=" | "!=" | "between" | "top" | "bottom" | "aboveAverage" | "belowAverage";
export type DateOp = "before" | "after" | "on" | "between";

export type FilterCondition =
  /** keep rows whose value is one of these keys ("" = blanks) */
  | { kind: "values"; keys: string[] }
  | { kind: "text"; op: TextOp; value: string }
  | { kind: "number"; op: NumberOp; a?: number; b?: number }
  /** dates as Excel serial numbers; "on" and "between" include whole days */
  | { kind: "date"; op: DateOp; a: number; b?: number }
  | { kind: "blanks"; blank: boolean };

export interface FilterSpec {
  /** the header row (view row), or -1 when the column names are the sheet's header */
  headerRow: number;
  conditions: { col: number; cond: FilterCondition }[];
}

export interface FilterView {
  name: string;
  filter: FilterSpec | null;
  sort: { col: number; descending: boolean }[];
}

/** What a value is, for matching against a values list: case doesn't matter for text. */
export function valueKey(v: CellValue): string {
  if (v === null || v === "") return "";
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "boolean") return `b:${v}`;
  if (typeof v === "string") return `s:${v.toLowerCase()}`;
  return `e:${String(v)}`;
}

export interface FilterSheet {
  getCell(row: number, col: number): CellValue;
  usedRange(): { rows: number; cols: number };
}

const textOf = (v: CellValue): string => (v === null ? "" : typeof v === "string" ? v : String(v));

/** A test for one condition over a column (some conditions look at the whole column first). */
function tester(sheet: FilterSheet, spec: FilterSpec, col: number, cond: FilterCondition): (v: CellValue) => boolean {
  switch (cond.kind) {
    case "values": {
      const keys = new Set(cond.keys);
      return (v) => keys.has(valueKey(v));
    }
    case "blanks":
      return (v) => (v === null || v === "") === cond.blank;
    case "text": {
      const want = cond.value.toLowerCase();
      return (v) => {
        const t = textOf(v).toLowerCase();
        switch (cond.op) {
          case "contains":
            return t.includes(want);
          case "notContains":
            return !t.includes(want);
          case "begins":
            return t.startsWith(want);
          case "ends":
            return t.endsWith(want);
          case "equals":
            return t === want;
          case "notEquals":
            return t !== want;
        }
      };
    }
    case "date": {
      const day = (n: number) => Math.floor(n);
      const a = cond.a;
      const b = cond.b ?? cond.a;
      return (v) => {
        if (typeof v !== "number") return false;
        switch (cond.op) {
          case "before":
            return day(v) < day(a);
          case "after":
            return day(v) > day(a);
          case "on":
            return day(v) === day(a);
          case "between":
            return day(v) >= day(Math.min(a, b)) && day(v) <= day(Math.max(a, b));
        }
      };
    }
    case "number": {
      const a = cond.a ?? 0;
      const b = cond.b ?? 0;
      if (cond.op === "top" || cond.op === "bottom" || cond.op === "aboveAverage" || cond.op === "belowAverage") {
        const nums: number[] = [];
        const { rows } = sheet.usedRange();
        for (let r = spec.headerRow + 1; r < rows; r++) {
          const v = sheet.getCell(r, col);
          if (typeof v === "number") nums.push(v);
        }
        if (cond.op === "aboveAverage" || cond.op === "belowAverage") {
          const avg = nums.reduce((s, x) => s + x, 0) / (nums.length || 1);
          return cond.op === "aboveAverage" ? (v) => typeof v === "number" && v > avg : (v) => typeof v === "number" && v < avg;
        }
        nums.sort((x, y) => x - y);
        const n = Math.max(1, Math.floor(a || 10));
        if (cond.op === "top") {
          const cut = nums[Math.max(0, nums.length - n)] ?? Infinity;
          return (v) => typeof v === "number" && v >= cut;
        }
        const cut = nums[Math.min(nums.length - 1, n - 1)] ?? -Infinity;
        return (v) => typeof v === "number" && v <= cut;
      }
      return (v) => {
        if (typeof v !== "number") return cond.op === "!=";
        switch (cond.op) {
          case ">":
            return v > a;
          case ">=":
            return v >= a;
          case "<":
            return v < a;
          case "<=":
            return v <= a;
          case "=":
            return v === a;
          case "!=":
            return v !== a;
          case "between":
            return v >= Math.min(a, b) && v <= Math.max(a, b);
        }
        return true;
      };
    }
  }
}

/** The view rows a filter hides (all conditions must hold for a row to stay). */
export function filteredOutRows(sheet: FilterSheet, spec: FilterSpec): number[] {
  const { rows } = sheet.usedRange();
  const tests = spec.conditions.map(({ col, cond }) => ({ col, test: tester(sheet, spec, col, cond) }));
  const out: number[] = [];
  if (!tests.length) return out;
  for (let r = spec.headerRow + 1; r < rows; r++) {
    for (const t of tests) {
      if (!t.test(sheet.getCell(r, t.col))) {
        out.push(r);
        break;
      }
    }
  }
  return out;
}

export interface DistinctValue {
  key: string;
  label: string;
  count: number;
}

/**
 * A column's values for the filter list, blanks first then in order (numbers
 * by size, text alphabetically). `rows` limits the list to the rows other
 * filters leave showing, as Excel does.
 */
export function distinctValues(
  sheet: FilterSheet,
  col: number,
  headerRow: number,
  label: (v: CellValue) => string,
  include: (row: number) => boolean = () => true,
  limit = 10_000,
): { values: DistinctValue[]; truncated: boolean } {
  const { rows } = sheet.usedRange();
  const map = new Map<string, DistinctValue & { sort: CellValue }>();
  let truncated = false;
  for (let r = headerRow + 1; r < rows; r++) {
    if (!include(r)) continue;
    const v = sheet.getCell(r, col);
    const key = valueKey(v);
    const got = map.get(key);
    if (got) got.count++;
    else if (map.size < limit) map.set(key, { key, label: key === "" ? "(Blanks)" : label(v), count: 1, sort: v });
    else truncated = true;
  }
  const values = [...map.values()].sort((x, y) => {
    if (x.key === "") return -1;
    if (y.key === "") return 1;
    const a = x.sort;
    const b = y.sort;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return textOf(a).localeCompare(textOf(b), undefined, { numeric: true, sensitivity: "base" });
  });
  return { values: values.map(({ key, label: l, count }) => ({ key, label: l, count })), truncated };
}

/** A short description of a condition, for menus and the history list. */
export function describeCondition(cond: FilterCondition): string {
  switch (cond.kind) {
    case "values":
      return `${cond.keys.length} value${cond.keys.length === 1 ? "" : "s"}`;
    case "blanks":
      return cond.blank ? "blanks" : "not blank";
    case "text":
      return `${{ contains: "contains", notContains: "doesn't contain", begins: "begins with", ends: "ends with", equals: "is", notEquals: "isn't" }[cond.op]} "${cond.value}"`;
    case "number":
      return cond.op === "between"
        ? `between ${cond.a} and ${cond.b}`
        : cond.op === "top" || cond.op === "bottom"
          ? `${cond.op} ${cond.a ?? 10}`
          : cond.op === "aboveAverage"
            ? "above average"
            : cond.op === "belowAverage"
              ? "below average"
              : `${cond.op} ${cond.a}`;
    case "date":
      return `${cond.op} a date`;
  }
}
