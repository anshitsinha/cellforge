import { CellError, errors, type Node, type RangeRef } from "./ast";

// exported so the compiler can call the exact same implementations
export { roundHalfAway };

export type Scalar = number | string | boolean | null | CellError;

/** Where a formula gets its inputs from. Implemented by the sheet. */
export interface EvalContext {
  /** Value of a single cell (evaluating it first if it's a formula). */
  cell(row: number, col: number): Scalar;
  /**
   * Visit every cell in a range. The sheet decides how - this is where a
   * columnar fast path can skip per-cell lookups entirely.
   */
  eachInRange(range: RangeRef, visit: (v: Scalar) => void): void;
}

type Arg = { kind: "value"; value: Scalar } | { kind: "range"; range: RangeRef };

// ---------------------------------------------------------------------------
// coercion helpers

const isError = (v: unknown): v is CellError => v instanceof CellError;

function toNumber(v: Scalar): number | CellError {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isError(v)) return v;
  const trimmed = v.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  return Number.isNaN(n) ? errors.value : n;
}

function toText(v: Scalar): string | CellError {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isError(v)) return v;
  return String(v);
}

function toBool(v: Scalar): boolean | CellError {
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
function tidy(n: number): number | CellError {
  return Number.isFinite(n) ? n : errors.num;
}

/** ROUND: half away from zero like Excel, not banker's rounding. */
function roundHalfAway(n: number, digits: number): number {
  const f = 10 ** Math.trunc(digits);
  return (Math.sign(n) * Math.round(Math.abs(n) * f)) / f;
}

function compare(a: Scalar, b: Scalar): number {
  // numbers compare numerically, everything else case-insensitively as text.
  // (Excel orders number < text < boolean across types; not bothering yet.)
  const na = typeof a === "number" || a === null ? (a ?? 0) : null;
  const nb = typeof b === "number" || b === null ? (b ?? 0) : null;
  if (na !== null && nb !== null) return na - nb;
  const sa = String(toText(a)).toLowerCase();
  const sb = String(toText(b)).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// ---------------------------------------------------------------------------
// evaluation

/**
 * Evaluate a formula.
 *
 * `rowShift` evaluates it as if it had been filled down that many rows:
 * relative row references move, `$`-anchored ones don't. That's how one
 * template AST serves every row of a filled range without being copied.
 */
export function evaluate(node: Node, ctx: EvalContext, rowShift = 0): Scalar {
  switch (node.type) {
    case "number":
    case "string":
    case "boolean":
      return node.value;
    case "ref": {
      const row = node.absRow ? node.row : node.row + rowShift;
      return row < 0 ? errors.ref : ctx.cell(row, node.col);
    }
    case "range":
      // a bare range outside a function (=A1:A3) - Excel would spill it; we
      // just don't support that
      return errors.value;
    case "unary": {
      const n = toNumber(evaluate(node.arg, ctx, rowShift));
      if (isError(n)) return n;
      if (node.op === "-") return -n;
      if (node.op === "%") return tidy(n / 100);
      return n;
    }
    case "binary":
      return binary(node.op, evaluate(node.left, ctx, rowShift), evaluate(node.right, ctx, rowShift));
    case "call": {
      const fn = FUNCTIONS[node.name];
      if (!fn) return errors.name;
      const args: Arg[] = [];
      for (const a of node.args) {
        if (a.type === "range") {
          const range = shiftRange(a, rowShift);
          if (!range) return errors.ref;
          args.push({ kind: "range", range });
        } else {
          args.push({ kind: "value", value: evaluate(a, ctx, rowShift) });
        }
      }
      return fn(args, ctx);
    }
  }
}

/** Apply a fill-down shift to a range node. null if it'd go above row 1. */
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

type Fn = (args: Arg[], ctx: EvalContext) => Scalar;

/**
 * Walk every value an argument list contains - ranges expanded, scalars as-is.
 * `fromRange` lets aggregates apply Excel's rule that text inside a range is
 * ignored but text passed directly ("=SUM("abc")") is an error.
 */
function eachValue(args: Arg[], ctx: EvalContext, visit: (v: Scalar, fromRange: boolean) => void) {
  for (const arg of args) {
    if (arg.kind === "range") ctx.eachInRange(arg.range, (v) => visit(v, true));
    else visit(arg.value, false);
  }
}

/** Shared implementation for SUM/AVERAGE/MIN/MAX/COUNT. */
function numericFold(args: Arg[], ctx: EvalContext): { nums: number; sum: number; min: number; max: number; err: CellError | null } {
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

/** Parse a COUNTIF/SUMIF criterion like ">10", "<>x", "apple" or 5. */
function criterion(c: Scalar): (v: Scalar) => boolean {
  if (typeof c === "number" || typeof c === "boolean") return (v) => v === c;
  const s = String(toText(c));
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(s)!;
  const op = m[1] ?? "=";
  const rhsText = m[2];
  const rhsNum = rhsText.trim() !== "" && !Number.isNaN(Number(rhsText)) ? Number(rhsText) : null;
  const rhs: Scalar = rhsNum ?? rhsText;
  return (v) => {
    if (v === null && op === "=" && rhsText === "") return true;
    if (v === null || isError(v)) return op === "<>";
    // a numeric criterion only matches numbers, a text one matches text
    if (rhsNum !== null && typeof v !== "number") return op === "<>";
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

const scalarArg = (a: Arg | undefined): Scalar => (a && a.kind === "value" ? a.value : errors.value);

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
  COUNTIF: (args, ctx) => {
    if (args.length !== 2 || args[0].kind !== "range") return errors.value;
    const test = criterion(scalarArg(args[1]));
    let n = 0;
    ctx.eachInRange(args[0].range, (v) => {
      if (test(v)) n++;
    });
    return n;
  },
  SUMIF: (args, ctx) => {
    // SUMIF(range, criterion) - the 3-arg form needs paired iteration over two
    // ranges, which eachInRange doesn't do yet
    if (args.length !== 2 || args[0].kind !== "range") return errors.value;
    const test = criterion(scalarArg(args[1]));
    let sum = 0;
    ctx.eachInRange(args[0].range, (v) => {
      if (typeof v === "number" && test(v)) sum += v;
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
