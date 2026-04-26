import { CellError, errors, type Node, type RangeRef } from "./ast";
import { dateToSerial, parseTyped, serialToParts } from "../numfmt";

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
  /** Another sheet's context, by name (case-insensitive); null if there's no such sheet. */
  sheet?(name: string): EvalContext | null;
}

/** The context a reference reads from: its own sheet's, or the one it names. */
function contextFor(node: { sheet?: string }, ctx: EvalContext): EvalContext | null {
  if (node.sheet === undefined) return ctx;
  return ctx.sheet?.(node.sheet) ?? null;
}

type Arg = { kind: "value"; value: Scalar } | { kind: "range"; range: RangeRef; ctx: EvalContext };

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
  if (!Number.isNaN(n)) return n;
  // "10%", "$1,200", "2024-01-15", "1:30 PM": Excel reads these as numbers too
  const typed = parseTyped(trimmed);
  return typed ? typed.value : errors.value;
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
    case "error":
      return new CellError(node.code);
    case "ref": {
      const row = node.absRow ? node.row : node.row + rowShift;
      const target = contextFor(node, ctx);
      return row < 0 || !target ? errors.ref : target.cell(row, node.col);
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
          const target = contextFor(a, ctx);
          if (!range || !target) return errors.ref;
          args.push({ kind: "range", range, ctx: target });
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
function eachValue(args: Arg[], _ctx: EvalContext, visit: (v: Scalar, fromRange: boolean) => void) {
  for (const arg of args) {
    if (arg.kind === "range") arg.ctx.eachInRange(arg.range, (v) => visit(v, true));
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
function criterion(c: Scalar): (v: Scalar) => boolean {
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
