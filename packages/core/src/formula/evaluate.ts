import { CellError, errors, type Node, type RangeRef } from "./ast";
import { dateToSerial, parseTyped, serialToParts } from "../numfmt";

// exported so the compiler can call the exact same implementations
export { roundHalfAway };

import { CellArray, firstOf, Lambda, lift2, type Scalar, type Value } from "./arrays";
export type { Scalar, Value };
export { CellArray, Lambda, firstOf };

/** Where a formula gets its inputs from. Implemented by the sheet. */
export interface EvalContext {
  /** Value of a single cell (evaluating it first if it's a formula). */
  cell(row: number, col: number): Scalar;
  /**
   * Visit every cell in a range. The sheet decides how - this is where a
   * columnar fast path can skip per-cell lookups entirely.
   */
  eachInRange(range: RangeRef, visit: (v: Scalar) => void): void;
  /** Another sheet's context, by name (case-insensitive); null if there's no such sheet. */
  sheet?(name: string): EvalContext | null;
  /** The array the formula at (row, col) spilled (for A1#), or null if it didn't. */
  spilled?(row: number, col: number): CellArray | null;
  /** A named range or constant's definition (already parsed), or null. */
  nameDef?(name: string): Node | null;
  /** How many rows the sheet has, so whole-column lookups (A:B) know where to stop. */
  rowCount?: number;
  colCount?: number;
}

/** The context a reference reads from: its own sheet's, or the one it names. */
function contextFor(node: { sheet?: string }, ctx: EvalContext): EvalContext | null {
  if (node.sheet === undefined) return ctx;
  return ctx.sheet?.(node.sheet) ?? null;
}

export type Arg =
  | { kind: "value"; value: Scalar }
  | { kind: "range"; range: RangeRef; ctx: EvalContext }
  | { kind: "array"; array: CellArray }
  | { kind: "lambda"; fn: Lambda };

// ---------------------------------------------------------------------------
// coercion helpers

export const isError = (v: unknown): v is CellError => v instanceof CellError;

export function toNumber(v: Scalar): number | CellError {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isError(v)) return v;
  const trimmed = v.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (!Number.isNaN(n)) return n;
  // "10%", "$1,200", "2024-01-15", "1:30 PM": Excel reads these as numbers too
  const typed = parseTyped(trimmed);
  return typed ? typed.value : errors.value;
}

export function toText(v: Scalar): string | CellError {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isError(v)) return v;
  return String(v);
}

export function toBool(v: Scalar): boolean | CellError {
  if (typeof v === "boolean") return v;
  if (v === null) return false;
  if (typeof v === "number") return v !== 0;
  if (isError(v)) return v;
  const up = v.toUpperCase();
  if (up === "TRUE") return true;
  if (up === "FALSE") return false;
  return errors.value;
}

/**
 * Results are plain IEEE doubles, same as Excel's engine - 0.1+0.2 really is
 * 0.30000000000000004 and it's the display layer's job to show "0.3". Doing
 * the maths unrounded is also what lets the compiled kernels (compile.ts)
 * produce bit-identical results to this interpreter.
 */
export function tidy(n: number): number | CellError {
  return Number.isFinite(n) ? n : errors.num;
}

/** ROUND: half away from zero like Excel, not banker's rounding. */
function roundHalfAway(n: number, digits: number): number {
  const f = 10 ** Math.trunc(digits);
  return (Math.sign(n) * Math.round(Math.abs(n) * f)) / f;
}

/**
 * Excel's comparison: numbers by value, text case-insensitively, TRUE >
 * FALSE, and across types numbers < text < booleans (so 1 = "1" is FALSE).
 * An empty cell takes the other side's type: 0, "" or FALSE.
 */
export function compare(a: Scalar, b: Scalar): number {
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === "number" ? 0 : typeof b === "boolean" ? false : "";
  if (b === null) b = typeof a === "number" ? 0 : typeof a === "boolean" ? false : "";
  const rank = (v: Scalar) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const sa = String(a).toLowerCase();
  const sb = String(b).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ---------------------------------------------------------------------------
// evaluation

let nameDepth = 0;

/** Variables in scope: LET names and LAMBDA parameters (upper case). */
export type Env = ReadonlyMap<string, Value>;

/** Largest array a range or formula may produce (keeps a stray A:A*2 from eating memory). */
const MAX_ARRAY_CELLS = 2_000_000;

/** A range's values as an array (whole columns stop at the sheet's last row). */
export function rangeArray(range: RangeRef, ctx: EvalContext): CellArray | CellError {
  const bottom = Math.min(range.bottom, (ctx.rowCount ?? 1_048_576) - 1);
  const right = Math.min(range.right, (ctx.colCount ?? 16_384) - 1);
  const rows = Math.max(0, bottom - range.top + 1);
  const cols = Math.max(0, right - range.left + 1);
  if (rows * cols > MAX_ARRAY_CELLS) return errors.value;
  const data: Scalar[] = [];
  ctx.eachInRange({ top: range.top, left: range.left, bottom, right }, (v) => data.push(v));
  // eachInRange visits row by row; pad if the sheet reported fewer cells
  while (data.length < rows * cols) data.push(null);
  return new CellArray(rows, cols, data);
}

/**
 * Functions that take single values, so given arrays they work cell by cell
 * and return an array (=UPPER(A1:A3), =ROUND(B2:B9*1.2, 2), =IF(A1:A5>0, "y", "n")).
 */
export const LIFTED = new Set(
  (
    "ABS SQRT INT ROUND ROUNDUP ROUNDDOWN TRUNC MOD POWER SIGN EXP LN LOG LOG10 EVEN ODD FACT CEILING FLOOR MROUND QUOTIENT " +
    "LEN UPPER LOWER TRIM PROPER LEFT RIGHT MID FIND SEARCH SUBSTITUTE REPLACE TEXT VALUE NUMBERVALUE EXACT CLEAN REPT CHAR CODE " +
    "TEXTBEFORE TEXTAFTER IF IFERROR IFNA IFS SWITCH NOT ISERROR ISNA ISNUMBER ISTEXT ISLOGICAL ISBLANK " +
    "DATE TIME YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY EDATE EOMONTH DATEVALUE DAYS WEEKNUM ISOWEEKNUM DATEDIF YEARFRAC DAYS360"
  ).split(" "),
);

/** Turn evaluated values into function arguments. */
function toArg(v: Value): Arg {
  if (v instanceof CellArray) return { kind: "array", array: v };
  if (v instanceof Lambda) return { kind: "lambda", fn: v };
  return { kind: "value", value: v };
}

/** Run a LAMBDA with these argument values. */
export function callLambda(fn: Lambda, values: Value[], ctx: EvalContext): Value {
  if (values.length > fn.params.length) return errors.value;
  const env = new Map(fn.env);
  fn.params.forEach((p, i) => env.set(p, i < values.length ? values[i] : null));
  return evaluate(fn.body, ctx, fn.shift, env);
}

/** A function applied cell by cell over the arrays among its arguments. */
function lifted(fn: Fn, args: Arg[], ctx: EvalContext): Value {
  let rows = 1;
  let cols = 1;
  for (const a of args) {
    if (a.kind === "array") {
      rows = Math.max(rows, a.array.rows);
      cols = Math.max(cols, a.array.cols);
    }
  }
  const data: Scalar[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellArgs: Arg[] = args.map((a) => (a.kind === "array" ? { kind: "value", value: a.array.get(r, c) } : a));
      data.push(firstOf(fn(cellArgs, ctx)));
    }
  }
  return new CellArray(rows, cols, data);
}

/**
 * Evaluate a formula.
 *
 * `rowShift` evaluates it as if it had been filled down that many rows:
 * relative row references move, `$`-anchored ones don't. That's how one
 * template AST serves every row of a filled range without being copied.
 * `env` holds LET names and LAMBDA parameters in scope.
 */
export function evaluate(node: Node, ctx: EvalContext, rowShift = 0, env?: Env): Value {
  switch (node.type) {
    case "number":
    case "string":
    case "boolean":
      return node.value;
    case "error":
      return new CellError(node.code);
    case "missing":
      return null;
    case "name": {
      const v = env?.get(node.name);
      if (v !== undefined) return v;
      // a defined name: evaluate its definition (absolute, so no shift)
      const def = ctx.nameDef?.(node.name);
      if (!def) return errors.name;
      if (++nameDepth > 64) {
        nameDepth = 0;
        return errors.cycle;
      }
      try {
        return evaluate(def, ctx, 0);
      } finally {
        nameDepth = Math.max(0, nameDepth - 1);
      }
    }
    case "ref": {
      const row = node.absRow ? node.row : node.row + rowShift;
      const target = contextFor(node, ctx);
      if (row < 0 || !target) return errors.ref;
      if (node.spill) return target.spilled?.(row, node.col) ?? errors.ref;
      return target.cell(row, node.col);
    }
    case "range": {
      // a range on its own (=A1:A3, =A1:A3*2) is an array that spills
      const range = shiftRange(node, rowShift);
      const target = contextFor(node, ctx);
      if (!range || !target) return errors.ref;
      return rangeArray(range, target);
    }
    case "array": {
      const rows: Scalar[][] = node.rows.map((r) => r.map((e) => firstOf(evaluate(e, ctx, rowShift, env))));
      return CellArray.of(rows);
    }
    case "unary": {
      const v = evaluate(node.arg, ctx, rowShift, env);
      const one = (x: Scalar): Scalar => {
        const n = toNumber(x);
        if (isError(n)) return n;
        if (node.op === "-") return -n;
        if (node.op === "%") return tidy(n / 100);
        return n;
      };
      if (v instanceof Lambda) return errors.value;
      return v instanceof CellArray ? v.map(one) : one(v);
    }
    case "binary":
      return lift2(evaluate(node.left, ctx, rowShift, env), evaluate(node.right, ctx, rowShift, env), (a, b) => binary(node.op, a, b));
    case "call": {
      const special = SPECIAL[node.name];
      if (special) return special(node.args, ctx, rowShift, env);
      const fn = FUNCTIONS[node.name];
      if (!fn) {
        // a LAMBDA kept in a LET name: =LET(sq, LAMBDA(n, n*n), sq(4))
        const bound = env?.get(node.name);
        if (bound instanceof Lambda) return callLambda(bound, node.args.map((a) => evaluate(a, ctx, rowShift, env)), ctx);
        return errors.name;
      }
      const lift = LIFTED.has(node.name);
      const args: Arg[] = [];
      for (const a0 of node.args) {
        // a defined name that is a range acts as that range (=COUNTIF(Region, "North"))
        let a = a0;
        let shift = rowShift;
        if (a.type === "name" && !env?.has(a.name)) {
          const def = ctx.nameDef?.(a.name);
          if (def && (def.type === "range" || def.type === "ref")) {
            a = def.type === "ref" ? { type: "range", range: { top: def.row, bottom: def.row, left: def.col, right: def.col }, sheet: def.sheet, absTop: true, absBottom: true, absLeft: true, absRight: true } : def;
            shift = 0;
          }
        }
        if (a.type === "range" && !lift) {
          const range = shiftRange(a, shift);
          const target = contextFor(a, ctx);
          if (!range || !target) return errors.ref;
          args.push({ kind: "range", range, ctx: target });
        } else {
          args.push(toArg(evaluate(a, ctx, rowShift, env)));
        }
      }
      if (lift && args.some((a) => a.kind === "array")) return lifted(fn, args, ctx);
      return fn(args, ctx);
    }
  }
}

type Special = (args: Node[], ctx: EvalContext, rowShift: number, env: Env | undefined) => Value;

/** Lambda arguments: a LAMBDA written inline or a name holding one. */
function lambdaOf(v: Value): Lambda | null {
  return v instanceof Lambda ? v : null;
}

/** An argument as an array (a single value becomes 1x1). */
function arrayOf(node: Node, ctx: EvalContext, rowShift: number, env: Env | undefined): CellArray | CellError {
  const v = evaluate(node, ctx, rowShift, env);
  if (v instanceof Lambda) return errors.value;
  if (v instanceof CellArray) return v;
  return new CellArray(1, 1, [v]);
}

/** Functions that control when (or whether) their arguments are evaluated. */
const SPECIAL: Record<string, Special> = {
  LET: (args, ctx, rowShift, env) => {
    if (args.length < 3 || args.length % 2 === 0) return errors.value;
    const scope = new Map(env ?? []);
    for (let i = 0; i < args.length - 1; i += 2) {
      const name = args[i];
      if (name.type !== "name") return errors.value;
      scope.set(name.name, evaluate(args[i + 1], ctx, rowShift, scope));
    }
    return evaluate(args[args.length - 1], ctx, rowShift, scope);
  },
  LAMBDA: (args, _ctx, rowShift, env) => {
    if (!args.length) return errors.value;
    const params = args.slice(0, -1);
    if (!params.every((p) => p.type === "name")) return errors.value;
    return new Lambda(
      params.map((p) => (p as { name: string }).name),
      args[args.length - 1],
      env ?? new Map(),
      rowShift,
    );
  },
  __INVOKE: (args, ctx, rowShift, env) => {
    const fn = lambdaOf(evaluate(args[0], ctx, rowShift, env));
    if (!fn) return errors.value;
    return callLambda(
      fn,
      args.slice(1).map((a) => evaluate(a, ctx, rowShift, env)),
      ctx,
    );
  },
  MAP: (args, ctx, rowShift, env) => {
    if (args.length < 2) return errors.value;
    const fn = lambdaOf(evaluate(args[args.length - 1], ctx, rowShift, env));
    if (!fn) return errors.value;
    const arrays: CellArray[] = [];
    for (const a of args.slice(0, -1)) {
      const arr = arrayOf(a, ctx, rowShift, env);
      if (isError(arr)) return arr;
      arrays.push(arr);
    }
    const rows = Math.max(...arrays.map((a) => a.rows));
    const cols = Math.max(...arrays.map((a) => a.cols));
    const data: Scalar[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data.push(firstOf(callLambda(fn, arrays.map((a) => a.get(r, c)), ctx)));
    return new CellArray(rows, cols, data);
  },
  REDUCE: (args, ctx, rowShift, env) => {
    if (args.length !== 3) return errors.value;
    let acc = evaluate(args[0], ctx, rowShift, env);
    const arr = arrayOf(args[1], ctx, rowShift, env);
    const fn = lambdaOf(evaluate(args[2], ctx, rowShift, env));
    if (isError(arr)) return arr;
    if (!fn) return errors.value;
    for (const v of arr.data) acc = callLambda(fn, [acc, v], ctx);
    return acc;
  },
  SCAN: (args, ctx, rowShift, env) => {
    if (args.length !== 3) return errors.value;
    let acc = evaluate(args[0], ctx, rowShift, env);
    const arr = arrayOf(args[1], ctx, rowShift, env);
    const fn = lambdaOf(evaluate(args[2], ctx, rowShift, env));
    if (isError(arr)) return arr;
    if (!fn) return errors.value;
    return new CellArray(
      arr.rows,
      arr.cols,
      arr.data.map((v) => {
        acc = callLambda(fn, [acc, v], ctx);
        return firstOf(acc);
      }),
    );
  },
  BYROW: (args, ctx, rowShift, env) => {
    if (args.length !== 2) return errors.value;
    const arr = arrayOf(args[0], ctx, rowShift, env);
    const fn = lambdaOf(evaluate(args[1], ctx, rowShift, env));
    if (isError(arr)) return arr;
    if (!fn) return errors.value;
    return CellArray.column(Array.from({ length: arr.rows }, (_, r) => firstOf(callLambda(fn, [new CellArray(1, arr.cols, arr.row(r))], ctx))));
  },
  BYCOL: (args, ctx, rowShift, env) => {
    if (args.length !== 2) return errors.value;
    const arr = arrayOf(args[0], ctx, rowShift, env);
    const fn = lambdaOf(evaluate(args[1], ctx, rowShift, env));
    if (isError(arr)) return arr;
    if (!fn) return errors.value;
    return new CellArray(1, arr.cols, Array.from({ length: arr.cols }, (_, c) => firstOf(callLambda(fn, [CellArray.column(arr.column(c))], ctx))));
  },
  MAKEARRAY: (args, ctx, rowShift, env) => {
    if (args.length !== 3) return errors.value;
    const rows = toNumber(firstOf(evaluate(args[0], ctx, rowShift, env)));
    const cols = toNumber(firstOf(evaluate(args[1], ctx, rowShift, env)));
    const fn = lambdaOf(evaluate(args[2], ctx, rowShift, env));
    if (isError(rows)) return rows;
    if (isError(cols)) return cols;
    if (!fn) return errors.value;
    const r = Math.trunc(rows);
    const c = Math.trunc(cols);
    if (r < 1 || c < 1 || r * c > MAX_ARRAY_CELLS) return errors.value;
    const data: Scalar[] = [];
    for (let i = 1; i <= r; i++) for (let j = 1; j <= c; j++) data.push(firstOf(callLambda(fn, [i, j], ctx)));
    return new CellArray(r, c, data);
  },
};

/** Names handled by SPECIAL, for the reference and autocomplete checks. */
export const SPECIAL_NAMES = Object.keys(SPECIAL).filter((n) => !n.startsWith("__"));


/** A range moved down by a fill shift ($-anchored edges stay). */
export function shiftRange(node: Extract<Node, { type: "range" }>, shift: number): RangeRef | null {
  if (shift === 0) return node.range;
  const { top, bottom, left, right } = node.range;
  const t = node.absTop ? top : top + shift;
  // whole-column ranges (bottom = Infinity) never move
  const b = node.absBottom || bottom === Infinity ? bottom : bottom + shift;
  if (t < 0) return null;
  return { top: Math.min(t, b), bottom: Math.max(t, b), left, right };
}

function binary(op: string, a: Scalar, b: Scalar): Scalar {
  if (op === "&") {
    const sa = toText(a);
    const sb = toText(b);
    if (isError(sa)) return sa;
    if (isError(sb)) return sb;
    return sa + sb;
  }
  if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    if (isError(a)) return a;
    if (isError(b)) return b;
    const c = compare(a, b);
    switch (op) {
      case "=":
        return c === 0;
      case "<>":
        return c !== 0;
      case "<":
        return c < 0;
      case ">":
        return c > 0;
      case "<=":
        return c <= 0;
      default:
        return c >= 0;
    }
  }

  const x = toNumber(a);
  const y = toNumber(b);
  if (isError(x)) return x;
  if (isError(y)) return y;
  switch (op) {
    case "+":
      return tidy(x + y);
    case "-":
      return tidy(x - y);
    case "*":
      return tidy(x * y);
    case "/":
      return y === 0 ? errors.div0 : tidy(x / y);
    case "^":
      return tidy(x ** y);
  }
  return errors.syntax;
}

// ---------------------------------------------------------------------------
// functions

export type Fn = (args: Arg[], ctx: EvalContext) => Value;

/**
 * Walk every value an argument list contains - ranges expanded, scalars as-is.
 * `fromRange` lets aggregates apply Excel's rule that text inside a range is
 * ignored but text passed directly ("=SUM("abc")") is an error.
 */
export function eachValue(args: Arg[], _ctx: EvalContext, visit: (v: Scalar, fromRange: boolean) => void) {
  for (const arg of args) {
    if (arg.kind === "range") arg.ctx.eachInRange(arg.range, (v) => visit(v, true));
    else if (arg.kind === "array") for (const v of arg.array.data) visit(v, true);
    else if (arg.kind === "lambda") visit(errors.value, false);
    else visit(arg.value, false);
  }
}

/** Every value in one argument: a range's cells, an array's items, or the value itself. */
export function argValues(a: Arg): Scalar[] {
  if (a.kind === "value") return [a.value];
  if (a.kind === "array") return a.array.data;
  if (a.kind === "lambda") return [errors.value];
  const out: Scalar[] = [];
  const bottom = Math.min(a.range.bottom, (a.ctx.rowCount ?? 1_048_576) - 1);
  a.ctx.eachInRange({ ...a.range, bottom }, (v) => out.push(v));
  return out;
}

/** Shared implementation for SUM/AVERAGE/MIN/MAX/COUNT. */
export function numericFold(args: Arg[], ctx: EvalContext): { nums: number; sum: number; min: number; max: number; err: CellError | null } {
  let nums = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let err: CellError | null = null;
  eachValue(args, ctx, (v, fromRange) => {
    if (err) return;
    if (isError(v)) {
      err = v;
      return;
    }
    let n: number;
    if (typeof v === "number") n = v;
    else if (fromRange) return; // blanks, text and booleans in ranges are skipped
    else {
      const c = toNumber(v);
      if (isError(c)) {
        err = c;
        return;
      }
      n = c;
    }
    nums++;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
  });
  return { nums, sum, min, max, err };
}

/** Excel wildcard text (* ? and ~ to escape) as a whole-string, case-insensitive regex. */
function wildcard(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (ch === "*") re += "[\\s\\S]*";
    else if (ch === "?") re += "[\\s\\S]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** Parse a COUNTIF/SUMIF criterion like ">10", "<>x", "apple" or 5. */
export function criterion(c: Scalar): (v: Scalar) => boolean {
  if (typeof c === "number" || typeof c === "boolean") return (v) => v === c;
  const s = String(toText(c));
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(s)!;
  const op = m[1] ?? "=";
  const rhsText = m[2];
  const rhsNum = rhsText.trim() !== "" && !Number.isNaN(Number(rhsText)) ? Number(rhsText) : null;
  const rhs: Scalar = rhsNum ?? rhsText;
  const wild = rhsNum === null && /[*?]/.test(rhsText) ? wildcard(rhsText) : null;
  return (v) => {
    if (v === null && op === "=" && rhsText === "") return true;
    if (v === null || isError(v)) return op === "<>";
    // a numeric criterion only matches numbers, a text one matches text
    if (rhsNum !== null && typeof v !== "number") return op === "<>";
    // * any run, ? one character, ~ escapes them (text matches only)
    if (wild && (op === "=" || op === "<>")) {
      const hit = typeof v === "string" && wild.test(v);
      return op === "=" ? hit : !hit;
    }
    const c2 = compare(v, rhs);
    switch (op) {
      case "=":
        return c2 === 0;
      case "<>":
        return c2 !== 0;
      case "<":
        return c2 < 0;
      case ">":
        return c2 > 0;
      case "<=":
        return c2 <= 0;
      default:
        return c2 >= 0;
    }
  };
}

/** A single value argument; a 1x1 array counts, anything bigger is #VALUE!. */
export const scalarArg = (a: Arg | undefined): Scalar =>
  !a ? errors.value : a.kind === "value" ? a.value : a.kind === "array" && a.array.data.length === 1 ? a.array.data[0] : errors.value;

function mathFn(f: (n: number) => number): Fn {
  return (args) => {
    if (args.length !== 1) return errors.value;
    const n = toNumber(scalarArg(args[0]));
    return isError(n) ? n : tidy(f(n));
  };
}

function textFn(f: (s: string) => Scalar): Fn {
  return (args) => {
    if (args.length !== 1) return errors.value;
    const s = toText(scalarArg(args[0]));
    return isError(s) ? s : f(s);
  };
}

/** YEAR, MONTH... : one part of a date serial. */
function datePart(pick: (p: ReturnType<typeof serialToParts>) => number): Fn {
  return (args) => {
    if (args.length !== 1) return errors.value;
    const n = toNumber(scalarArg(args[0]));
    if (isError(n)) return n;
    if (n < 0) return errors.num;
    return pick(serialToParts(n));
  };
}

/** EDATE / EOMONTH: a date some months away (EOMONTH: that month's last day). */
function monthShift(args: Arg[], endOfMonth: boolean): Scalar {
  if (args.length !== 2) return errors.value;
  const start = toNumber(scalarArg(args[0]));
  const months = toNumber(scalarArg(args[1]));
  if (isError(start)) return start;
  if (isError(months)) return months;
  if (start < 0) return errors.num;
  const p = serialToParts(start);
  const total = p.y * 12 + (p.m - 1) + Math.trunc(months);
  const y = Math.floor(total / 12);
  const m = (((total % 12) + 12) % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const serial = dateToSerial(y, m, endOfMonth ? last : Math.min(p.d, last));
  return serial < 0 ? errors.num : serial;
}

export const FUNCTIONS: Record<string, Fn> = {
  SUM: (args, ctx) => {
    const r = numericFold(args, ctx);
    return r.err ?? tidy(r.sum);
  },
  AVERAGE: (args, ctx) => {
    const r = numericFold(args, ctx);
    if (r.err) return r.err;
    return r.nums === 0 ? errors.div0 : tidy(r.sum / r.nums);
  },
  MIN: (args, ctx) => {
    const r = numericFold(args, ctx);
    return r.err ?? (r.nums ? r.min : 0);
  },
  MAX: (args, ctx) => {
    const r = numericFold(args, ctx);
    return r.err ?? (r.nums ? r.max : 0);
  },
  COUNT: (args, ctx) => {
    let n = 0;
    eachValue(args, ctx, (v) => {
      if (typeof v === "number") n++;
    });
    return n;
  },
  COUNTA: (args, ctx) => {
    let n = 0;
    eachValue(args, ctx, (v) => {
      if (v !== null && v !== "") n++;
    });
    return n;
  },
  COUNTIF: (args) => {
    if (args.length !== 2 || args[0].kind !== "range") return errors.value;
    const test = criterion(scalarArg(args[1]));
    let n = 0;
    args[0].ctx.eachInRange(args[0].range, (v) => {
      if (test(v)) n++;
    });
    return n;
  },
  SUMIF: (args) => {
    if (args.length < 2 || args.length > 3 || args[0].kind !== "range") return errors.value;
    const test = criterion(scalarArg(args[1]));
    const checked = args[0];
    if (args.length === 2) {
      let sum = 0;
      checked.ctx.eachInRange(checked.range, (v) => {
        if (typeof v === "number" && test(v)) sum += v;
      });
      return tidy(sum);
    }
    const target = args[2];
    if (target.kind !== "range") return errors.value;
    // Excel: the sum range takes the checked range's shape from its top-left
    const r = checked.range;
    const shaped = {
      top: target.range.top,
      left: target.range.left,
      bottom: r.bottom === Infinity ? Infinity : target.range.top + (r.bottom - r.top),
      right: target.range.left + (r.right - r.left),
    };
    const hits: boolean[] = [];
    checked.ctx.eachInRange(r, (v) => hits.push(test(v)));
    let sum = 0;
    let i = 0;
    target.ctx.eachInRange(shaped, (v) => {
      if (hits[i++] && typeof v === "number") sum += v;
    });
    return tidy(sum);
  },
  IF: (args) => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const cond = toBool(scalarArg(args[0]));
    if (isError(cond)) return cond;
    if (cond) return scalarArg(args[1]);
    return args.length === 3 ? scalarArg(args[2]) : false;
  },
  IFERROR: (args) => {
    if (args.length !== 2) return errors.value;
    const v = scalarArg(args[0]);
    return isError(v) ? scalarArg(args[1]) : v;
  },
  AND: (args, ctx) => {
    let result = true;
    let err: CellError | null = null;
    eachValue(args, ctx, (v) => {
      if (err || v === null) return;
      const b = toBool(v);
      if (isError(b)) err = b;
      else result = result && b;
    });
    return err ?? result;
  },
  OR: (args, ctx) => {
    let result = false;
    let err: CellError | null = null;
    eachValue(args, ctx, (v) => {
      if (err || v === null) return;
      const b = toBool(v);
      if (isError(b)) err = b;
      else result = result || b;
    });
    return err ?? result;
  },
  NOT: (args) => {
    const b = toBool(scalarArg(args[0]));
    return isError(b) ? b : !b;
  },
  ABS: mathFn(Math.abs),
  SQRT: (args) => {
    const n = toNumber(scalarArg(args[0]));
    if (isError(n)) return n;
    return n < 0 ? errors.num : tidy(Math.sqrt(n));
  },
  INT: mathFn(Math.floor),
  ROUND: (args) => {
    const n = toNumber(scalarArg(args[0]));
    const digits = args.length > 1 ? toNumber(scalarArg(args[1])) : 0;
    if (isError(n)) return n;
    if (isError(digits)) return digits;
    return tidy(roundHalfAway(n, digits));
  },
  MOD: (args) => {
    const a = toNumber(scalarArg(args[0]));
    const b = toNumber(scalarArg(args[1]));
    if (isError(a)) return a;
    if (isError(b)) return b;
    if (b === 0) return errors.div0;
    // result takes the sign of the divisor, like Excel
    return tidy(a - b * Math.floor(a / b));
  },
  POWER: (args) => binary("^", scalarArg(args[0]), scalarArg(args[1])),

  // ------------------------------------------------------------ dates
  DATE: (args) => {
    if (args.length !== 3) return errors.value;
    const [y0, m, d] = args.map((a) => toNumber(scalarArg(a)));
    for (const x of [y0, m, d]) if (isError(x)) return x;
    let y = Math.trunc(y0 as number);
    if (y < 0 || y > 9999) return errors.num;
    if (y < 1900) y += 1900; // Excel: DATE(24, 1, 1) is 1924
    const serial = dateToSerial(y, Math.trunc(m as number), Math.trunc(d as number));
    return serial < 0 ? errors.num : serial;
  },
  TIME: (args) => {
    if (args.length !== 3) return errors.value;
    const [h, m, sec] = args.map((a) => toNumber(scalarArg(a)));
    for (const x of [h, m, sec]) if (isError(x)) return x;
    const total = Math.trunc(h as number) * 3600 + Math.trunc(m as number) * 60 + Math.trunc(sec as number);
    if (total < 0) return errors.num;
    return (total % 86_400) / 86_400;
  },
  YEAR: datePart((p) => p.y),
  MONTH: datePart((p) => p.m),
  DAY: datePart((p) => p.d),
  HOUR: datePart((p) => p.h),
  MINUTE: datePart((p) => p.mi),
  SECOND: datePart((p) => p.s + (p.ms >= 500 ? 1 : 0)),
  WEEKDAY: (args) => {
    if (args.length < 1 || args.length > 2) return errors.value;
    const n = toNumber(scalarArg(args[0]));
    if (isError(n)) return n;
    if (n < 0) return errors.num;
    const type = args.length === 2 ? toNumber(scalarArg(args[1])) : 1;
    if (isError(type)) return type;
    const wd = serialToParts(n).wd; // 0 = Sunday
    if (type === 1) return wd + 1;
    if (type === 2) return ((wd + 6) % 7) + 1;
    if (type === 3) return (wd + 6) % 7;
    return errors.num;
  },
  TODAY: (args) => {
    if (args.length) return errors.value;
    const now = new Date();
    return dateToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
  },
  NOW: (args) => {
    if (args.length) return errors.value;
    const now = new Date();
    return dateToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
  },
  EDATE: (args) => monthShift(args, false),
  EOMONTH: (args) => monthShift(args, true),
  DATEVALUE: (args) => {
    if (args.length !== 1) return errors.value;
    const v = scalarArg(args[0]);
    if (isError(v)) return v;
    if (typeof v !== "string") return errors.value;
    const typed = parseTyped(v);
    if (!typed || !/[dy]|m{3}/i.test(typed.format)) return errors.value;
    return Math.floor(typed.value);
  },

  // ------------------------------------------------------ information
  ISERROR: (args) => (args.length === 1 ? isError(scalarArg(args[0])) : errors.value),
  ISNA: (args) => {
    if (args.length !== 1) return errors.value;
    const v = scalarArg(args[0]);
    return isError(v) && v.code === "#N/A";
  },
  ISNUMBER: (args) => (args.length === 1 ? typeof scalarArg(args[0]) === "number" : errors.value),
  ISTEXT: (args) => (args.length === 1 ? typeof scalarArg(args[0]) === "string" : errors.value),
  ISLOGICAL: (args) => (args.length === 1 ? typeof scalarArg(args[0]) === "boolean" : errors.value),
  ISBLANK: (args) => (args.length === 1 ? scalarArg(args[0]) === null : errors.value),
  NA: (args) => (args.length ? errors.value : errors.na),
  LEN: textFn((s) => s.length),
  UPPER: textFn((s) => s.toUpperCase()),
  LOWER: textFn((s) => s.toLowerCase()),
  TRIM: textFn((s) => s.trim().replace(/\s+/g, " ")),
  CONCAT: (args, ctx) => {
    let out = "";
    let err: CellError | null = null;
    eachValue(args, ctx, (v) => {
      if (err) return;
      const s = toText(v);
      if (isError(s)) err = s;
      else out += s;
    });
    return err ?? out;
  },
};
