/**
 * Functions that return arrays (they spill): FILTER, SORT, SORTBY, UNIQUE,
 * SEQUENCE, TRANSPOSE and the shaping ones (TAKE, DROP, HSTACK, VSTACK,
 * TOCOL, TOROW, CHOOSECOLS, CHOOSEROWS).
 */
import { CellError, errors } from "../ast";
import { CellArray } from "../arrays";
import { compare, isError, rangeArray, scalarArg, toBool, toNumber, type Arg, type Scalar } from "../evaluate";
import { define } from "./define";

/** Any argument as an array. */
function arr(a: Arg | undefined): CellArray | CellError {
  if (!a) return errors.value;
  if (a.kind === "array") return a.array;
  if (a.kind === "range") return rangeArray(a.range, a.ctx);
  if (a.kind === "lambda") return errors.value;
  return new CellArray(1, 1, [a.value]);
}

function int(a: Arg | undefined, fallback: number): number | CellError {
  if (!a || (a.kind === "value" && a.value === null)) return fallback;
  const n = toNumber(scalarArg(a));
  return isError(n) ? n : Math.trunc(n);
}

const fromRows = (rows: Scalar[][], cols: number) => new CellArray(rows.length, cols, rows.flat());
const rowsOf = (a: CellArray) => Array.from({ length: a.rows }, (_, r) => a.row(r));

define(
  {
    name: "FILTER",
    category: "Lookup",
    summary: "The rows (or columns) of a range where a condition is true. Spills the result.",
    args: [
      { name: "array", description: "the data" },
      { name: "include", description: "TRUE/FALSE per row, e.g. B1:B5=\"North\"; combine with * for AND, + for OR" },
      { name: "if_empty", description: "what to show when nothing matches (#CALC! otherwise)", optional: true },
    ],
    examples: [
      ['=ROWS(FILTER(A1:B5, B1:B5="North"))', 2],
      ['=INDEX(FILTER(A1:A5, B1:B5="East"), 1)', "apple"],
      ['=FILTER(A1:A5, B1:B5="West", "none")', "none"],
    ],
  },
  (args) => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const data = arr(args[0]);
    const inc = arr(args[1]);
    if (isError(data)) return data;
    if (isError(inc)) return inc;
    const byRow = inc.cols === 1 && inc.rows === data.rows;
    const byCol = inc.rows === 1 && inc.cols === data.cols && !byRow;
    if (!byRow && !byCol) return errors.value;
    const keep = (i: number): boolean | CellError => {
      const v = inc.data[i];
      if (isError(v)) return v;
      const b = toBool(v === null ? false : v);
      return isError(b) ? errors.value : b;
    };
    if (byRow) {
      const out: Scalar[][] = [];
      for (let r = 0; r < data.rows; r++) {
        const k = keep(r);
        if (isError(k)) return k;
        if (k) out.push(data.row(r));
      }
      if (out.length) return fromRows(out, data.cols);
    } else {
      const cols: number[] = [];
      for (let c = 0; c < data.cols; c++) {
        const k = keep(c);
        if (isError(k)) return k;
        if (k) cols.push(c);
      }
      if (cols.length) return fromRows(rowsOf(data).map((row) => cols.map((c) => row[c])), cols.length);
    }
    return args[2] ? scalarArg(args[2]) : errors.calc;
  },
);

function sortRows(rows: Scalar[][], keys: Scalar[][], orders: number[]): Scalar[][] {
  const idx = rows.map((_, i) => i);
  idx.sort((a, b) => {
    for (let k = 0; k < orders.length; k++) {
      const x = keys[k][a];
      const y = keys[k][b];
      // empty cells go last whichever way
      if (x === null || y === null) {
        if (x !== y) return x === null ? 1 : -1;
        continue;
      }
      const c = compare(x, y);
      if (c) return c * orders[k];
    }
    return a - b;
  });
  return idx.map((i) => rows[i]);
}

define(
  {
    name: "SORT",
    category: "Lookup",
    summary: "A range sorted by one of its columns (or rows). Spills the result; the original stays as it is.",
    args: [
      { name: "array", description: "the data" },
      { name: "sort_index", description: "which column to sort by, 1 = the first (default)", optional: true },
      { name: "order", description: "1 ascending (default), -1 descending", optional: true },
      { name: "by_col", description: "TRUE to sort columns instead of rows", optional: true },
    ],
    examples: [
      ["=INDEX(SORT(A1:A3, 1, -1), 1)", 30],
      ['=INDEX(SORT(B1:B5), 1)', "East"],
    ],
  },
  (args) => {
    const data = arr(args[0]);
    if (isError(data)) return data;
    const index = int(args[1], 1);
    const order = int(args[2], 1);
    if (isError(index)) return index;
    if (isError(order)) return order;
    const byCol = args[3] ? scalarArg(args[3]) === true : false;
    if (order !== 1 && order !== -1) return errors.value;
    if (byCol) {
      if (index < 1 || index > data.rows) return errors.value;
      const cols = Array.from({ length: data.cols }, (_, c) => data.column(c));
      const sorted = sortRows(cols, [data.row(index - 1)], [order]);
      return new CellArray(data.rows, data.cols, Array.from({ length: data.rows }, (_, r) => sorted.map((col) => col[r])).flat());
    }
    if (index < 1 || index > data.cols) return errors.value;
    return fromRows(sortRows(rowsOf(data), [data.column(index - 1)], [order]), data.cols);
  },
);

define(
  {
    name: "SORTBY",
    category: "Lookup",
    summary: "A range sorted by other ranges (one or more keys, each ascending or descending).",
    args: [
      { name: "array", description: "the data" },
      { name: "by_array1", description: "what to sort by (same number of rows)" },
      { name: "order1", description: "1 ascending (default), -1 descending", optional: true },
      { name: "by_array2, order2", description: "more keys", optional: true, repeats: true },
    ],
    examples: [["=INDEX(SORTBY(B1:B3, A1:A3, -1), 1)", "North"]],
  },
  (args) => {
    const data = arr(args[0]);
    if (isError(data)) return data;
    const keys: Scalar[][] = [];
    const orders: number[] = [];
    for (let i = 1; i < args.length; i += 2) {
      const k = arr(args[i]);
      if (isError(k)) return k;
      if (k.data.length !== data.rows) return errors.value;
      const o = int(args[i + 1], 1);
      if (isError(o)) return o;
      if (o !== 1 && o !== -1) return errors.value;
      keys.push(k.data);
      orders.push(o);
    }
    if (!keys.length) return errors.value;
    return fromRows(sortRows(rowsOf(data), keys, orders), data.cols);
  },
);

define(
  {
    name: "UNIQUE",
    category: "Lookup",
    summary: "The distinct rows of a range (text compared ignoring case), in the order they first appear; or only those that appear once.",
    args: [
      { name: "array", description: "the data" },
      { name: "by_col", description: "TRUE to compare columns instead of rows", optional: true },
      { name: "exactly_once", description: "TRUE for values that appear exactly once", optional: true },
    ],
    examples: [
      ["=ROWS(UNIQUE(B1:B5))", 3],
      ["=ROWS(UNIQUE(B1:B5, FALSE, TRUE))", 1],
    ],
  },
  (args) => {
    const data = arr(args[0]);
    if (isError(data)) return data;
    const byCol = args[1] ? scalarArg(args[1]) === true : false;
    const once = args[2] ? scalarArg(args[2]) === true : false;
    const items = byCol ? Array.from({ length: data.cols }, (_, c) => data.column(c)) : rowsOf(data);
    const keyOf = (row: Scalar[]) => JSON.stringify(row.map((v) => (typeof v === "string" ? `s:${v.toLowerCase()}` : isError(v) ? `e:${v.code}` : v)));
    const counts = new Map<string, number>();
    for (const it of items) counts.set(keyOf(it), (counts.get(keyOf(it)) ?? 0) + 1);
    const seen = new Set<string>();
    const out: Scalar[][] = [];
    for (const it of items) {
      const k = keyOf(it);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!once || counts.get(k) === 1) out.push(it);
    }
    if (!out.length) return errors.calc;
    if (byCol) return new CellArray(data.rows, out.length, Array.from({ length: data.rows }, (_, r) => out.map((col) => col[r])).flat());
    return fromRows(out, data.cols);
  },
);

define(
  {
    name: "SEQUENCE",
    category: "Maths",
    summary: "A grid of numbers counting up (or by any step): SEQUENCE(12) is 1 to 12 down a column.",
    args: [
      { name: "rows", description: "how many rows" },
      { name: "columns", description: "how many columns; 1 if left out", optional: true },
      { name: "start", description: "the first number; 1 if left out", optional: true },
      { name: "step", description: "the step; 1 if left out", optional: true },
    ],
    examples: [
      ["=SUM(SEQUENCE(10))", 55],
      ["=INDEX(SEQUENCE(2, 3, 0, 5), 2, 3)", 25],
    ],
  },
  (args) => {
    const rows = int(args[0], NaN);
    const cols = int(args[1], 1);
    const start = args[2] && !(args[2].kind === "value" && args[2].value === null) ? toNumber(scalarArg(args[2])) : 1;
    const step = args[3] && !(args[3].kind === "value" && args[3].value === null) ? toNumber(scalarArg(args[3])) : 1;
    if (isError(rows)) return rows;
    if (isError(cols)) return cols;
    if (isError(start)) return start;
    if (isError(step)) return step;
    if (!(rows >= 1) || cols < 1) return errors.value;
    if (rows * cols > 2_000_000) return errors.num;
    return new CellArray(rows, cols, Array.from({ length: rows * cols }, (_, i) => start + i * step));
  },
);

define(
  {
    name: "TRANSPOSE",
    category: "Lookup",
    summary: "Turns rows into columns and columns into rows.",
    args: [{ name: "array", description: "the data" }],
    examples: [["=COLUMNS(TRANSPOSE(A1:A5))", 5]],
  },
  (args) => {
    const data = arr(args[0]);
    if (isError(data)) return data;
    const out: Scalar[] = [];
    for (let c = 0; c < data.cols; c++) for (let r = 0; r < data.rows; r++) out.push(data.data[r * data.cols + c]);
    return new CellArray(data.cols, data.rows, out);
  },
);

function takeDrop(take: boolean) {
  return (args: Arg[]) => {
    const data = arr(args[0]);
    if (isError(data)) return data;
    const r = int(args[1], take ? data.rows : 0);
    const c = int(args[2], take ? data.cols : 0);
    if (isError(r)) return r;
    if (isError(c)) return c;
    const span = (n: number, total: number): [number, number] => {
      if (take) return n >= 0 ? [0, Math.min(n, total)] : [Math.max(0, total + n), total];
      return n >= 0 ? [Math.min(n, total), total] : [0, Math.max(0, total + n)];
    };
    const [r0, r1] = span(r, data.rows);
    const [c0, c1] = span(c, data.cols);
    if (r1 <= r0 || c1 <= c0) return errors.calc;
    const out: Scalar[][] = [];
    for (let i = r0; i < r1; i++) out.push(data.row(i).slice(c0, c1));
    return fromRows(out, c1 - c0);
  };
}

define(
  {
    name: "TAKE",
    category: "Lookup",
    summary: "The first (or, with a negative number, last) rows and columns of an array.",
    args: [
      { name: "array", description: "the data" },
      { name: "rows", description: "how many rows; negative takes from the end", optional: true },
      { name: "columns", description: "how many columns; negative takes from the end", optional: true },
    ],
    examples: [["=SUM(TAKE(A1:A5, 2))", 30], ["=SUM(TAKE(A1:A3, -1))", 30]],
  },
  takeDrop(true),
);

define(
  {
    name: "DROP",
    category: "Lookup",
    summary: "An array without its first (or, with a negative number, last) rows and columns.",
    args: [
      { name: "array", description: "the data" },
      { name: "rows", description: "how many rows to drop; negative drops from the end", optional: true },
      { name: "columns", description: "how many columns to drop", optional: true },
    ],
    examples: [["=SUM(DROP(A1:A3, 1))", 50]],
  },
  takeDrop(false),
);

function stack(vertical: boolean) {
  return (args: Arg[]) => {
    const parts: CellArray[] = [];
    for (const a of args) {
      const x = arr(a);
      if (isError(x)) return x;
      parts.push(x);
    }
    if (!parts.length) return errors.value;
    if (vertical) {
      const cols = Math.max(...parts.map((p) => p.cols));
      const rows: Scalar[][] = [];
      for (const p of parts) for (let r = 0; r < p.rows; r++) rows.push(Array.from({ length: cols }, (_, c) => (c < p.cols ? p.data[r * p.cols + c] : errors.na)));
      return fromRows(rows, cols);
    }
    const rowsN = Math.max(...parts.map((p) => p.rows));
    const rows: Scalar[][] = [];
    for (let r = 0; r < rowsN; r++) rows.push(parts.flatMap((p) => (r < p.rows ? p.row(r) : Array.from({ length: p.cols }, () => errors.na))));
    return fromRows(rows, parts.reduce((n, p) => n + p.cols, 0));
  };
}

define(
  {
    name: "VSTACK",
    category: "Lookup",
    summary: "Stacks arrays on top of each other (for combining months or regions into one list).",
    args: [{ name: "array1", description: "the first block" }, { name: "array2", description: "more blocks", optional: true, repeats: true }],
    examples: [["=ROWS(VSTACK(A1:A3, A1:A2))", 5]],
  },
  stack(true),
);

define(
  {
    name: "HSTACK",
    category: "Lookup",
    summary: "Puts arrays side by side.",
    args: [{ name: "array1", description: "the first block" }, { name: "array2", description: "more blocks", optional: true, repeats: true }],
    examples: [["=COLUMNS(HSTACK(A1:A3, B1:B3))", 2]],
  },
  stack(false),
);

function flatten(asColumn: boolean) {
  return (args: Arg[]) => {
    const data = arr(args[0]);
    if (isError(data)) return data;
    const ignore = int(args[1], 0);
    if (isError(ignore)) return ignore;
    const byCol = args[2] ? scalarArg(args[2]) === true : false;
    const values: Scalar[] = [];
    if (byCol) for (let c = 0; c < data.cols; c++) values.push(...data.column(c));
    else values.push(...data.data);
    const kept = values.filter((v) => !((ignore === 1 || ignore === 3) && v === null) && !((ignore === 2 || ignore === 3) && isError(v)));
    if (!kept.length) return errors.calc;
    return asColumn ? CellArray.column(kept) : new CellArray(1, kept.length, kept);
  };
}

const flatArgs = [
  { name: "array", description: "the data" },
  { name: "ignore", description: "0 keep everything (default), 1 skip blanks, 2 skip errors, 3 skip both", optional: true },
  { name: "scan_by_column", description: "TRUE to read column by column", optional: true },
];

define(
  {
    name: "TOCOL",
    category: "Lookup",
    summary: "An array as one column.",
    args: flatArgs,
    examples: [["=ROWS(TOCOL(A1:B2))", 4], ["=ROWS(TOCOL(A1:A5, 1))", 4]],
  },
  flatten(true),
);

define(
  {
    name: "TOROW",
    category: "Lookup",
    summary: "An array as one row.",
    args: flatArgs,
    examples: [["=COLUMNS(TOROW(A1:A3))", 3]],
  },
  flatten(false),
);

function choose(cols: boolean) {
  return (args: Arg[]) => {
    const data = arr(args[0]);
    if (isError(data)) return data;
    const total = cols ? data.cols : data.rows;
    const picks: number[] = [];
    for (const a of args.slice(1)) {
      const list = arr(a);
      if (isError(list)) return list;
      for (const v of list.data) {
        const n = toNumber(v);
        if (isError(n)) return n;
        const i = Math.trunc(n);
        const idx = i < 0 ? total + i : i - 1;
        if (i === 0 || idx < 0 || idx >= total) return errors.value;
        picks.push(idx);
      }
    }
    if (!picks.length) return errors.value;
    if (cols) return fromRows(rowsOf(data).map((row) => picks.map((c) => row[c])), picks.length);
    return fromRows(picks.map((r) => data.row(r)), data.cols);
  };
}

define(
  {
    name: "CHOOSECOLS",
    category: "Lookup",
    summary: "Some columns of an array, in the order given (negative numbers count from the end).",
    args: [{ name: "array", description: "the data" }, { name: "col_num1", description: "a column number" }, { name: "col_num2", description: "more", optional: true, repeats: true }],
    examples: [['=INDEX(CHOOSECOLS(A1:B5, 2), 1)', "North"]],
  },
  choose(true),
);

define(
  {
    name: "CHOOSEROWS",
    category: "Lookup",
    summary: "Some rows of an array, in the order given (negative numbers count from the end).",
    args: [{ name: "array", description: "the data" }, { name: "row_num1", description: "a row number" }, { name: "row_num2", description: "more", optional: true, repeats: true }],
    examples: [["=SUM(CHOOSEROWS(A1:A3, 1, -1))", 40]],
  },
  choose(false),
);
