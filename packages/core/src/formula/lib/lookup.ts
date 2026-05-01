/**
 * Lookup functions: VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH, XMATCH,
 * CHOOSE, ROWS, COLUMNS. Results are single values for now (a lookup that
 * would return several cells gives #VALUE! until dynamic arrays arrive).
 */
import { CellError, errors, type RangeRef } from "../ast";
import { compare, isError, scalarArg, toBool, toNumber, type Arg, type Scalar } from "../evaluate";
import { define } from "./define";

type RangeArg = Extract<Arg, { kind: "range" }>;

/** The part of a range that exists (whole columns stop at the last row). */
function bounds(a: RangeArg): RangeRef {
  const rows = a.ctx.rowCount ?? 1_048_576;
  const cols = a.ctx.colCount ?? 16_384;
  return { top: a.range.top, left: a.range.left, bottom: Math.min(a.range.bottom, rows - 1), right: Math.min(a.range.right, cols - 1) };
}

const height = (r: RangeRef) => Math.max(0, r.bottom - r.top + 1);
const width = (r: RangeRef) => Math.max(0, r.right - r.left + 1);

/** A 1-D view of a range (a single row or column) as get(i) / length. */
function line(a: Arg): { get: (i: number) => Scalar; length: number } | CellError {
  if (a.kind === "array") {
    if (a.array.cols === 1 || a.array.rows === 1) return { get: (i) => a.array.data[i], length: a.array.data.length };
    return errors.value;
  }
  if (a.kind !== "range") return { get: () => scalarArg(a), length: 1 };
  const r = bounds(a);
  if (width(r) === 1) return { get: (i) => a.ctx.cell(r.top + i, r.left), length: height(r) };
  if (height(r) === 1) return { get: (i) => a.ctx.cell(r.top, r.left + i), length: width(r) };
  return errors.value;
}

/** Excel's "*" "?" "~" wildcards as a regex, for exact matches on text. */
function wildcardRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length) re += escape(pattern[++i]);
    else if (ch === "*") re += "[\\s\\S]*";
    else if (ch === "?") re += "[\\s\\S]";
    else re += escape(ch);
  }
  return new RegExp(`^${re}$`, "i");
}
const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sameType = (a: Scalar, b: Scalar) => typeof a === typeof b || (a === null && b === "") || (a === "" && b === null);

/** Position of an exact match (first, or last when `reverse`), or -1. */
function exact(get: (i: number) => Scalar, n: number, key: Scalar, wildcards: boolean, reverse = false): number {
  const re = wildcards && typeof key === "string" && /[*?~]/.test(key) ? wildcardRegex(key) : null;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    const v = get(i);
    if (re ? typeof v === "string" && re.test(v) : sameType(v, key) && compare(v, key) === 0) return i;
  }
  return -1;
}

/**
 * Binary search in ascending data for the last value <= key (Excel's
 * approximate match). Values of another type are skipped like Excel does.
 */
function approxAscending(get: (i: number) => Scalar, n: number, key: Scalar): number {
  let lo = 0;
  let hi = n - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = get(mid);
    if (v === null || !sameType(v, key)) {
      // step past a cell of another type, as Excel does
      hi = mid - 1;
      continue;
    }
    if (compare(v, key) <= 0) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Linear search for the nearest value on one side of the key (XLOOKUP / MATCH -1). */
function nearest(get: (i: number) => Scalar, n: number, key: Scalar, side: "smaller" | "larger", reverse = false): number {
  let best = -1;
  let bestV: Scalar = null;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    const v = get(i);
    if (v === null || !sameType(v, key)) continue;
    const c = compare(v, key);
    if (c === 0) return i;
    if (side === "smaller" ? c < 0 : c > 0) {
      if (best < 0 || (side === "smaller" ? compare(v, bestV) > 0 : compare(v, bestV) < 0)) {
        best = i;
        bestV = v;
      }
    }
  }
  return best;
}

const key0 = (a: Arg | undefined): Scalar => {
  const v = scalarArg(a);
  return v;
};

function int(a: Arg | undefined, fallback?: number): number | CellError {
  if (a === undefined) return fallback ?? errors.value;
  const n = toNumber(scalarArg(a));
  return isError(n) ? n : Math.trunc(n);
}

// ---------------------------------------------------------------------------

function vhlookup(args: Arg[], vertical: boolean): Scalar {
  if (args.length < 3 || args.length > 4) return errors.value;
  const key = key0(args[0]);
  if (isError(key)) return key;
  const table = args[1];
  if (table.kind !== "range") return errors.value;
  const r = bounds(table);
  const idx = int(args[2]);
  if (isError(idx)) return idx;
  const span = vertical ? width(r) : height(r);
  if (idx < 1) return errors.value;
  if (idx > span) return errors.ref;
  const approx = args.length === 4 ? toBool(scalarArg(args[3])) : true;
  if (isError(approx)) return approx;
  const n = vertical ? height(r) : width(r);
  const get = (i: number) => (vertical ? table.ctx.cell(r.top + i, r.left) : table.ctx.cell(r.top, r.left + i));
  const i = approx ? approxAscending(get, n, key) : exact(get, n, key, true);
  if (i < 0) return errors.na;
  return vertical ? table.ctx.cell(r.top + i, r.left + idx - 1) : table.ctx.cell(r.top + idx - 1, r.left + i);
}

define(
  {
    name: "VLOOKUP",
    category: "Lookup",
    summary:
      "Finds a value in the first column of a table and returns the value from another column of that row. Give FALSE as the last argument for an exact match; the default (TRUE) assumes the first column is sorted.",
    args: [
      { name: "lookup_value", description: "what to look for" },
      { name: "table", description: "the table; the value is looked for in its first column" },
      { name: "col_index", description: "which column to return, 1 = the first" },
      { name: "approximate", description: "FALSE for an exact match (what you usually want); TRUE or left out for sorted data", optional: true },
    ],
    examples: [
      ['=VLOOKUP("East", B1:B5, 1, FALSE)', "East"],
      ['=VLOOKUP("West", B1:B5, 1, FALSE)', "#N/A"],
      ["=VLOOKUP(25, A1:A3, 1)", 20],
    ],
    notes: "Leaving out the last argument means an approximate match on sorted data, Excel's default and a classic source of wrong answers. cellforge's checks flag it.",
  },
  (args) => vhlookup(args, true),
);

define(
  {
    name: "HLOOKUP",
    category: "Lookup",
    summary: "VLOOKUP sideways: finds a value in the first row of a table and returns the value from another row of that column.",
    args: [
      { name: "lookup_value", description: "what to look for" },
      { name: "table", description: "the table; the value is looked for in its first row" },
      { name: "row_index", description: "which row to return, 1 = the first" },
      { name: "approximate", description: "FALSE for an exact match; TRUE or left out for sorted data", optional: true },
    ],
    examples: [["=HLOOKUP(10, A1:A3, 2, FALSE)", 20]],
  },
  (args) => vhlookup(args, false),
);

define(
  {
    name: "MATCH",
    category: "Lookup",
    summary: "The position of a value in a row or column (1 = the first). Use 0 for an exact match.",
    args: [
      { name: "lookup_value", description: "what to look for" },
      { name: "range", description: "a single row or column" },
      { name: "match_type", description: "0 exact; 1 (default) largest value ≤ it in ascending data; -1 smallest value ≥ it in descending data", optional: true },
    ],
    examples: [
      ['=MATCH("East", B1:B5, 0)', 4],
      ["=MATCH(25, A1:A3, 1)", 2],
      ['=MATCH("so*", B1:B5, 0)', 2],
    ],
  },
  (args) => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const key = key0(args[0]);
    if (isError(key)) return key;
    const l = line(args[1]);
    if (isError(l)) return errors.na;
    const type = int(args[2], 1);
    if (isError(type)) return type;
    let i: number;
    if (type === 0) i = exact(l.get, l.length, key, true);
    else if (type > 0) i = approxAscending(l.get, l.length, key);
    else {
      // descending data: the last value >= key, scanning while values stay >= key
      i = -1;
      for (let k = 0; k < l.length; k++) {
        const v = l.get(k);
        if (v === null || !sameType(v, key)) continue;
        if (compare(v, key) >= 0) i = k;
        else break;
      }
    }
    return i < 0 ? errors.na : i + 1;
  },
);

function xsearch(get: (i: number) => Scalar, n: number, key: Scalar, matchMode: number, searchMode: number): number {
  const reverse = searchMode === -1 || searchMode === -2;
  if (matchMode === 0) return exact(get, n, key, false, reverse);
  if (matchMode === 2) return exact(get, n, key, true, reverse);
  if (matchMode === -1) return nearest(get, n, key, "smaller", reverse);
  if (matchMode === 1) return nearest(get, n, key, "larger", reverse);
  return -2;
}

define(
  {
    name: "XLOOKUP",
    category: "Lookup",
    summary: "Finds a value in one range and returns the value at the same position in another. Exact by default, with a value to show when nothing is found.",
    args: [
      { name: "lookup_value", description: "what to look for" },
      { name: "lookup_array", description: "where to look (one row or column)" },
      { name: "return_array", description: "what to return from (same size)" },
      { name: "if_not_found", description: "what to show when there's no match (#N/A otherwise)", optional: true },
      { name: "match_mode", description: "0 exact (default), -1 exact or next smaller, 1 exact or next larger, 2 wildcards", optional: true },
      { name: "search_mode", description: "1 first to last (default), -1 last to first", optional: true },
    ],
    examples: [
      ['=XLOOKUP("East", B1:B5, A1:A5)', "apple"],
      ['=XLOOKUP("West", B1:B5, A1:A5, "none")', "none"],
      ['=XLOOKUP("North", B1:B5, A1:A5, , 0, -1)', 30],
      ["=XLOOKUP(25, A1:A3, A1:A3, , -1)", 20],
    ],
  },
  (args) => {
    if (args.length < 3 || args.length > 6) return errors.value;
    const key = key0(args[0]);
    if (isError(key)) return key;
    const look = line(args[1]);
    const ret = line(args[2]);
    if (isError(look) || isError(ret)) return errors.value;
    if (look.length !== ret.length) return errors.value;
    const mm = args[4] && !(args[4].kind === "value" && args[4].value === null) ? int(args[4]) : 0;
    const sm = args[5] ? int(args[5]) : 1;
    if (isError(mm)) return mm;
    if (isError(sm)) return sm;
    const i = xsearch(look.get, look.length, key, mm, sm);
    if (i === -2) return errors.value;
    if (i < 0) {
      if (args[3] && !(args[3].kind === "value" && args[3].value === null)) return scalarArg(args[3]);
      return errors.na;
    }
    return ret.get(i);
  },
);

define(
  {
    name: "XMATCH",
    category: "Lookup",
    summary: "The position of a value in a row or column, exact by default (the modern MATCH).",
    args: [
      { name: "lookup_value", description: "what to look for" },
      { name: "lookup_array", description: "a single row or column" },
      { name: "match_mode", description: "0 exact (default), -1 or next smaller, 1 or next larger, 2 wildcards", optional: true },
      { name: "search_mode", description: "1 first to last (default), -1 last to first", optional: true },
    ],
    examples: [
      ['=XMATCH("South", B1:B5)', 2],
      ['=XMATCH("South", B1:B5, 0, -1)', 5],
    ],
  },
  (args) => {
    if (args.length < 2 || args.length > 4) return errors.value;
    const key = key0(args[0]);
    if (isError(key)) return key;
    const l = line(args[1]);
    if (isError(l)) return errors.value;
    const mm = int(args[2], 0);
    const sm = int(args[3], 1);
    if (isError(mm)) return mm;
    if (isError(sm)) return sm;
    const i = xsearch(l.get, l.length, key, mm, sm);
    return i === -2 ? errors.value : i < 0 ? errors.na : i + 1;
  },
);

define(
  {
    name: "INDEX",
    category: "Lookup",
    summary: "The value at a row and column position inside a range. With MATCH, a lookup that works in any direction.",
    args: [
      { name: "range", description: "where to look" },
      { name: "row", description: "row number inside the range, 1 = the first" },
      { name: "column", description: "column number inside the range (for a single row, the position)", optional: true },
    ],
    examples: [
      ["=INDEX(A1:B5, 2, 2)", "South"],
      ['=INDEX(A1:A5, MATCH("East", B1:B5, 0))', "apple"],
    ],
  },
  (args) => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const a = args[0];
    if (a.kind !== "range") return args.length === 2 ? scalarArg(a) : errors.value;
    const r = bounds(a);
    let row = int(args[1]);
    let col = args.length === 3 ? int(args[2]) : 1;
    if (isError(row)) return row;
    if (isError(col)) return col;
    // one row and one position: the position is the column
    if (args.length === 2 && height(r) === 1 && width(r) > 1) {
      col = row;
      row = 1;
    }
    if (row < 1 || col < 1) return errors.value; // 0 = whole row/column needs dynamic arrays
    if (row > height(r) || col > width(r)) return errors.ref;
    return a.ctx.cell(r.top + row - 1, r.left + col - 1);
  },
);

define(
  {
    name: "CHOOSE",
    category: "Lookup",
    summary: "Picks one of several values by number.",
    args: [
      { name: "index", description: "which value, 1 = the first" },
      { name: "value1", description: "the first choice" },
      { name: "value2", description: "more choices", optional: true, repeats: true },
    ],
    examples: [['=CHOOSE(2, "low", "mid", "high")', "mid"]],
  },
  (args) => {
    if (args.length < 2) return errors.value;
    const i = int(args[0]);
    if (isError(i)) return i;
    if (i < 1 || i >= args.length) return errors.value;
    return scalarArg(args[i]);
  },
);

define(
  {
    name: "ROWS",
    category: "Lookup",
    summary: "How many rows a range has.",
    args: [{ name: "range", description: "a range" }],
    examples: [["=ROWS(A1:B5)", 5]],
  },
  (args) => (args.length === 1 && args[0].kind === "range" ? height(bounds(args[0])) : args.length === 1 ? 1 : errors.value),
);

define(
  {
    name: "COLUMNS",
    category: "Lookup",
    summary: "How many columns a range has.",
    args: [{ name: "range", description: "a range" }],
    examples: [["=COLUMNS(A1:C5)", 3]],
  },
  (args) => (args.length === 1 && args[0].kind === "range" ? width(bounds(args[0])) : args.length === 1 ? 1 : errors.value),
);
