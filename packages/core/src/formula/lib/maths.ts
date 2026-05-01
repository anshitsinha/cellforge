/**
 * Maths and conditional totals: SUMIFS and friends, SUMPRODUCT, PRODUCT,
 * the rounding family, logs and the small helpers people reach for.
 */
import { CellError, errors, type RangeRef } from "../ast";
import { criterion, eachValue, isError, scalarArg, tidy, toNumber, type Arg, type Scalar } from "../evaluate";
import { define } from "./define";

type RangeArg = Extract<Arg, { kind: "range" }>;

function bounds(a: RangeArg): RangeRef {
  const rows = a.ctx.rowCount ?? 1_048_576;
  const cols = a.ctx.colCount ?? 16_384;
  return { top: a.range.top, left: a.range.left, bottom: Math.min(a.range.bottom, rows - 1), right: Math.min(a.range.right, cols - 1) };
}

/** Every value of a range, row by row. */
function valuesOf(a: RangeArg): Scalar[] {
  const out: Scalar[] = [];
  a.ctx.eachInRange(bounds(a), (v) => out.push(v));
  return out;
}

const sizeOf = (r: RangeRef) => [r.bottom - r.top + 1, r.right - r.left + 1] as const;

/**
 * The *IFS rule: which positions pass every (range, criterion) pair. All
 * ranges must be the same size, as in Excel.
 */
function passing(pairs: Arg[], shape: readonly [number, number]): Uint8Array | CellError {
  if (pairs.length === 0 || pairs.length % 2) return errors.value;
  const n = shape[0] * shape[1];
  const ok = new Uint8Array(n).fill(1);
  for (let p = 0; p < pairs.length; p += 2) {
    const r = pairs[p];
    if (r.kind !== "range") return errors.value;
    const b = bounds(r);
    const [h, w] = sizeOf(b);
    if (h !== shape[0] || w !== shape[1]) return errors.value;
    const test = criterion(scalarArg(pairs[p + 1]));
    let i = 0;
    r.ctx.eachInRange(b, (v) => {
      if (ok[i] && !test(v)) ok[i] = 0;
      i++;
    });
  }
  return ok;
}

/** SUMIFS / AVERAGEIFS / MAXIFS / MINIFS: fold the target's numbers where every criterion passes. */
function foldIfs(target: Arg, pairs: Arg[], fold: (nums: number[]) => Scalar): Scalar {
  if (target.kind !== "range") return errors.value;
  const shape = sizeOf(bounds(target));
  const ok = passing(pairs, shape);
  if (isError(ok)) return ok;
  const values = valuesOf(target);
  const nums: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!ok[i]) continue;
    if (isError(v)) return v;
    if (typeof v === "number") nums.push(v);
  }
  return fold(nums);
}

const sum = (xs: number[]) => tidy(xs.reduce((a, b) => a + b, 0));

function num(a: Arg | undefined): number | CellError {
  if (a === undefined) return errors.value;
  return toNumber(scalarArg(a));
}

/** Clean away float noise before rounding up or down (1.1*100 is 110.00000000000001). */
const clean = (x: number) => Number(x.toPrecision(15));

const one = (name: string, summary: string, fn: (x: number) => Scalar, examples: [string, Scalar][], argName = "number", argDesc = "any number") =>
  define({ name, category: "Maths", summary, args: [{ name: argName, description: argDesc }], examples: examples as [string, string | number | boolean][] }, (args) => {
    if (args.length !== 1) return errors.value;
    const x = num(args[0]);
    return isError(x) ? x : fn(x);
  });

// ------------------------------------------------------------ conditional totals

const pairArgs = [
  { name: "criteria_range1", description: "the first range to check" },
  { name: "criteria1", description: 'its condition, e.g. "North", ">15", "N*"' },
  { name: "criteria_range2, criteria2", description: "more range and condition pairs; every one must pass", optional: true, repeats: true },
];

define(
  {
    name: "SUMIFS",
    category: "Maths",
    summary: "Adds the cells where every condition holds. Each condition checks its own range, all the same size.",
    args: [{ name: "sum_range", description: "the cells to add" }, ...pairArgs],
    examples: [
      ['=SUMIFS(A1:A5, B1:B5, "North")', 40],
      ['=SUMIFS(A1:A5, B1:B5, "North", A1:A5, ">15")', 30],
    ],
  },
  (args) => (args.length < 3 ? errors.value : foldIfs(args[0], args.slice(1), sum)),
);

define(
  {
    name: "COUNTIFS",
    category: "Statistics",
    summary: "How many rows meet every condition.",
    args: pairArgs,
    examples: [['=COUNTIFS(B1:B5, "South", A1:A5, ">15")', 1]],
  },
  (args) => {
    const first = args[0];
    if (!first || first.kind !== "range") return errors.value;
    const ok = passing(args, sizeOf(bounds(first)));
    if (isError(ok)) return ok;
    let n = 0;
    for (const x of ok) n += x;
    return n;
  },
);

define(
  {
    name: "AVERAGEIF",
    category: "Statistics",
    summary: "The average of the cells that meet a condition, optionally taken from a parallel range.",
    args: [
      { name: "range", description: "the cells to check" },
      { name: "criteria", description: 'the condition, e.g. "North" or ">15"' },
      { name: "average_range", description: "the cells to average, if not the ones checked", optional: true },
    ],
    examples: [['=AVERAGEIF(B1:B5, "North", A1:A5)', 20]],
  },
  (args) => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const target = args[2] ?? args[0];
    if (target.kind !== "range" || args[0].kind !== "range") return errors.value;
    // like SUMIF, the average range takes the checked range's shape
    const shaped: RangeArg = { ...target, range: { ...target.range, bottom: target.range.top + (args[0].range.bottom - args[0].range.top), right: target.range.left + (args[0].range.right - args[0].range.left) } };
    return foldIfs(shaped, [args[0], args[1]], (xs) => (xs.length ? tidy(xs.reduce((a, b) => a + b, 0) / xs.length) : errors.div0));
  },
);

define(
  {
    name: "AVERAGEIFS",
    category: "Statistics",
    summary: "The average of the cells where every condition holds.",
    args: [{ name: "average_range", description: "the cells to average" }, ...pairArgs],
    examples: [['=AVERAGEIFS(A1:A5, B1:B5, "North")', 20]],
  },
  (args) => (args.length < 3 ? errors.value : foldIfs(args[0], args.slice(1), (xs) => (xs.length ? tidy(xs.reduce((a, b) => a + b, 0) / xs.length) : errors.div0))),
);

define(
  {
    name: "MAXIFS",
    category: "Statistics",
    summary: "The largest value where every condition holds (0 if none).",
    args: [{ name: "max_range", description: "the cells to take the largest from" }, ...pairArgs],
    examples: [['=MAXIFS(A1:A5, B1:B5, "North")', 30]],
  },
  (args) => (args.length < 3 ? errors.value : foldIfs(args[0], args.slice(1), (xs) => (xs.length ? Math.max(...xs) : 0))),
);

define(
  {
    name: "MINIFS",
    category: "Statistics",
    summary: "The smallest value where every condition holds (0 if none).",
    args: [{ name: "min_range", description: "the cells to take the smallest from" }, ...pairArgs],
    examples: [['=MINIFS(A1:A5, B1:B5, "North")', 10]],
  },
  (args) => (args.length < 3 ? errors.value : foldIfs(args[0], args.slice(1), (xs) => (xs.length ? Math.min(...xs) : 0))),
);

define(
  {
    name: "SUMPRODUCT",
    category: "Maths",
    summary: "Multiplies ranges position by position and adds the results. Text and empty cells count as 0.",
    args: [
      { name: "array1", description: "a range" },
      { name: "array2", description: "more ranges of the same size", optional: true, repeats: true },
    ],
    examples: [
      ["=SUMPRODUCT(A1:A3, A1:A3)", 1400],
      ["=SUMPRODUCT(A1:A3)", 60],
    ],
  },
  (args) => {
    if (!args.length) return errors.value;
    let shape: readonly [number, number] | null = null;
    let acc: number[] | null = null;
    for (const a of args) {
      let vals: Scalar[];
      if (a.kind === "range") {
        const s = sizeOf(bounds(a));
        if (shape && (s[0] !== shape[0] || s[1] !== shape[1])) return errors.value;
        shape = s;
        vals = valuesOf(a);
      } else if (a.kind === "array") {
        const s = [a.array.rows, a.array.cols] as const;
        if (shape && (s[0] !== shape[0] || s[1] !== shape[1])) return errors.value;
        shape = s;
        vals = a.array.data;
      } else vals = [scalarArg(a)];
      const nums: number[] = [];
      for (const v of vals) {
        if (isError(v)) return v;
        nums.push(typeof v === "number" ? v : 0);
      }
      if (!acc) acc = nums;
      else {
        if (acc.length !== nums.length) return errors.value;
        for (let i = 0; i < acc.length; i++) acc[i] *= nums[i];
      }
    }
    return sum(acc ?? []);
  },
);

define(
  {
    name: "PRODUCT",
    category: "Maths",
    summary: "Multiplies numbers. Text and empty cells inside ranges are skipped.",
    args: [
      { name: "number1", description: "a number, cell or range" },
      { name: "number2", description: "more", optional: true, repeats: true },
    ],
    examples: [["=PRODUCT(A1:A3)", 6000]],
  },
  (args, ctx) => {
    let p = 1;
    let any = false;
    let err: CellError | null = null;
    eachValue(args, ctx, (v, fromRange) => {
      if (err) return;
      if (isError(v)) return void (err = v);
      if (typeof v === "number") {
        p *= v;
        any = true;
      } else if (!fromRange) {
        const n = toNumber(v);
        if (isError(n)) err = n;
        else {
          p *= n;
          any = true;
        }
      }
    });
    return err ?? (any ? tidy(p) : 0);
  },
);

define(
  {
    name: "SUMSQ",
    category: "Maths",
    summary: "Adds the squares of the numbers.",
    args: [
      { name: "number1", description: "a number, cell or range" },
      { name: "number2", description: "more", optional: true, repeats: true },
    ],
    examples: [["=SUMSQ(A1:A3)", 1400]],
  },
  (args, ctx) => {
    let s = 0;
    let err: CellError | null = null;
    eachValue(args, ctx, (v, fromRange) => {
      if (err) return;
      if (isError(v)) return void (err = v);
      if (typeof v === "number") s += v * v;
      else if (!fromRange) {
        const n = toNumber(v);
        if (isError(n)) err = n;
        else s += n * n;
      }
    });
    return err ?? tidy(s);
  },
);

// ------------------------------------------------------------ rounding

function digitsArg(args: Arg[], i: number, fallback?: number): number | CellError {
  if (args[i] === undefined) return fallback ?? errors.value;
  const d = num(args[i]);
  return isError(d) ? d : Math.trunc(d);
}

function roundWith(args: Arg[], mode: (x: number) => number, optionalDigits = false): Scalar {
  if (args.length < (optionalDigits ? 1 : 2) || args.length > 2) return errors.value;
  const x = num(args[0]);
  const d = digitsArg(args, 1, optionalDigits ? 0 : undefined);
  if (isError(x)) return x;
  if (isError(d)) return d;
  const f = 10 ** d;
  return tidy((Math.sign(x) * mode(clean(Math.abs(x) * f))) / f);
}

define(
  {
    name: "ROUNDUP",
    category: "Maths",
    summary: "Rounds away from zero to a number of decimal places.",
    args: [{ name: "number", description: "the number" }, { name: "digits", description: "decimal places (negative for tens, hundreds…)" }],
    examples: [
      ["=ROUNDUP(2.341, 2)", 2.35],
      ["=ROUNDUP(-2.341, 1)", -2.4],
      ["=ROUNDUP(1.1, 1)", 1.1],
    ],
  },
  (args) => roundWith(args, Math.ceil),
);

define(
  {
    name: "ROUNDDOWN",
    category: "Maths",
    summary: "Rounds towards zero to a number of decimal places.",
    args: [{ name: "number", description: "the number" }, { name: "digits", description: "decimal places (negative for tens, hundreds…)" }],
    examples: [
      ["=ROUNDDOWN(2.349, 2)", 2.34],
      ["=ROUNDDOWN(-2.349, 1)", -2.3],
    ],
  },
  (args) => roundWith(args, Math.floor),
);

define(
  {
    name: "TRUNC",
    category: "Maths",
    summary: "Cuts off decimals without rounding (towards zero).",
    args: [{ name: "number", description: "the number" }, { name: "digits", description: "decimal places to keep (0 if left out)", optional: true }],
    examples: [
      ["=TRUNC(8.9)", 8],
      ["=TRUNC(-8.9)", -8],
      ["=TRUNC(3.14159, 2)", 3.14],
    ],
  },
  (args) => roundWith(args, Math.floor, true),
);

function toMultiple(args: Arg[], up: boolean): Scalar {
  if (args.length < 1 || args.length > 2) return errors.value;
  const x = num(args[0]);
  const sig = args[1] === undefined ? (x as number) < 0 ? -1 : 1 : num(args[1]);
  if (isError(x)) return x;
  if (isError(sig)) return sig;
  if (sig === 0 || x === 0) return 0;
  if (x > 0 && sig < 0) return errors.num;
  const q = clean(x / sig);
  // negative number with negative significance rounds away from zero (Excel)
  const r = x < 0 && sig < 0 ? (up ? Math.ceil(q) : Math.floor(q)) : up ? Math.ceil(q) : Math.floor(q);
  return tidy(r * sig);
}

define(
  {
    name: "CEILING",
    category: "Maths",
    summary: "Rounds up to the nearest multiple (e.g. prices to the next 0.05).",
    args: [{ name: "number", description: "the number" }, { name: "significance", description: "the multiple; 1 if left out", optional: true }],
    examples: [
      ["=CEILING(2.31, 0.05)", 2.35],
      ["=CEILING(-2.5, 2)", -2],
      ["=CEILING(-2.5, -2)", -4],
    ],
  },
  (args) => toMultiple(args, true),
);

define(
  {
    name: "FLOOR",
    category: "Maths",
    summary: "Rounds down to the nearest multiple.",
    args: [{ name: "number", description: "the number" }, { name: "significance", description: "the multiple; 1 if left out", optional: true }],
    examples: [
      ["=FLOOR(2.39, 0.05)", 2.35],
      ["=FLOOR(-2.5, 2)", -4],
    ],
  },
  (args) => toMultiple(args, false),
);

define(
  {
    name: "MROUND",
    category: "Maths",
    summary: "Rounds to the nearest multiple, halves away from zero.",
    args: [{ name: "number", description: "the number" }, { name: "multiple", description: "the multiple; must have the same sign" }],
    examples: [
      ["=MROUND(10, 3)", 9],
      ["=MROUND(7.5, 5)", 10],
      ["=MROUND(5, -2)", "#NUM!"],
    ],
  },
  (args) => {
    if (args.length !== 2) return errors.value;
    const x = num(args[0]);
    const m = num(args[1]);
    if (isError(x)) return x;
    if (isError(m)) return m;
    if (m === 0) return 0;
    if (x * m < 0) return errors.num;
    const q = clean(Math.abs(x / m));
    return tidy(Math.sign(x) * Math.round(q) * Math.abs(m));
  },
);

one("SIGN", "1 for a positive number, -1 for a negative one, 0 for zero.", (x) => Math.sign(x) + 0, [["=SIGN(-4)", -1], ["=SIGN(0)", 0]]);
one("EXP", "e raised to a power.", (x) => tidy(Math.exp(x)), [["=EXP(0)", 1]], "power", "the exponent");
one("LN", "Natural logarithm. Zero or less gives #NUM!.", (x) => (x <= 0 ? errors.num : tidy(Math.log(x))), [["=LN(1)", 0], ["=LN(0)", "#NUM!"]]);
one("LOG10", "Base-10 logarithm.", (x) => (x <= 0 ? errors.num : tidy(Math.log10(x))), [["=LOG10(1000)", 3]]);
one("EVEN", "Rounds away from zero to the next even whole number.", (x) => tidy(Math.sign(x) * Math.ceil(clean(Math.abs(x)) / 2) * 2), [["=EVEN(3.2)", 4], ["=EVEN(-1)", -2]]);
one("ODD", "Rounds away from zero to the next odd whole number.", (x) => {
  const a = Math.ceil(clean(Math.abs(x)));
  return (x < 0 ? -1 : 1) * (a % 2 === 1 ? a : a + 1);
}, [["=ODD(2)", 3], ["=ODD(-2.5)", -3]]);
one("FACT", "The factorial (5! = 120).", (x) => {
  if (x < 0) return errors.num;
  let f = 1;
  for (let i = 2; i <= Math.trunc(x); i++) f *= i;
  return tidy(f);
}, [["=FACT(5)", 120]]);

define(
  {
    name: "LOG",
    category: "Maths",
    summary: "Logarithm in any base (10 if left out).",
    args: [{ name: "number", description: "a positive number" }, { name: "base", description: "the base; 10 if left out", optional: true }],
    examples: [
      ["=LOG(8, 2)", 3],
      ["=LOG(100)", 2],
    ],
  },
  (args) => {
    if (args.length < 1 || args.length > 2) return errors.value;
    const x = num(args[0]);
    const b = args[1] === undefined ? 10 : num(args[1]);
    if (isError(x)) return x;
    if (isError(b)) return b;
    if (x <= 0 || b <= 0 || b === 1) return errors.num;
    return tidy(clean(Math.log(x) / Math.log(b)));
  },
);

define(
  { name: "PI", category: "Maths", summary: "π to 15 digits.", args: [], examples: [["=ROUND(PI(), 4)", 3.1416]] },
  (args) => (args.length ? errors.value : Math.PI),
);

define(
  {
    name: "QUOTIENT",
    category: "Maths",
    summary: "The whole-number part of a division.",
    args: [{ name: "numerator", description: "the number to divide" }, { name: "denominator", description: "what to divide by" }],
    examples: [["=QUOTIENT(17, 5)", 3], ["=QUOTIENT(-17, 5)", -3]],
  },
  (args) => {
    if (args.length !== 2) return errors.value;
    const a = num(args[0]);
    const b = num(args[1]);
    if (isError(a)) return a;
    if (isError(b)) return b;
    return b === 0 ? errors.div0 : Math.trunc(a / b);
  },
);

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function intsOf(args: Arg[], ctx: Parameters<typeof eachValue>[1]): number[] | CellError {
  const xs: number[] = [];
  let err: CellError | null = null;
  eachValue(args, ctx, (v) => {
    if (err) return;
    if (isError(v)) return void (err = v);
    const n = toNumber(v);
    if (isError(n)) return void (err = n);
    if (n < 0) return void (err = errors.num);
    xs.push(Math.trunc(n));
  });
  return err ?? xs;
}

define(
  {
    name: "GCD",
    category: "Maths",
    summary: "The greatest common divisor.",
    args: [{ name: "number1", description: "a whole number ≥ 0" }, { name: "number2", description: "more", optional: true, repeats: true }],
    examples: [["=GCD(24, 36)", 12]],
  },
  (args, ctx) => {
    const xs = intsOf(args, ctx);
    return isError(xs) ? xs : xs.reduce(gcd, 0);
  },
);

define(
  {
    name: "LCM",
    category: "Maths",
    summary: "The least common multiple.",
    args: [{ name: "number1", description: "a whole number ≥ 0" }, { name: "number2", description: "more", optional: true, repeats: true }],
    examples: [["=LCM(4, 6)", 12]],
  },
  (args, ctx) => {
    const xs = intsOf(args, ctx);
    if (isError(xs)) return xs;
    return xs.reduce((a, b) => (a === 0 || b === 0 ? 0 : (a / gcd(a, b)) * b), 1);
  },
);

define(
  {
    name: "RAND",
    category: "Maths",
    summary: "A random number from 0 up to (not including) 1, new on every recalculation.",
    args: [],
    examples: [["=AND(RAND()>=0, RAND()<1)", true]],
    notes: "Changes on every edit, so results built on it can't be reproduced; avoid it in workpapers.",
  },
  (args) => (args.length ? errors.value : Math.random()),
);

define(
  {
    name: "RANDBETWEEN",
    category: "Maths",
    summary: "A random whole number between two numbers, inclusive. New on every recalculation.",
    args: [{ name: "bottom", description: "the smallest it can be" }, { name: "top", description: "the largest it can be" }],
    examples: [["=RANDBETWEEN(5, 5)", 5]],
    notes: "Changes on every edit; sample selection should use a recorded seed instead (coming with audit sampling).",
  },
  (args) => {
    if (args.length !== 2) return errors.value;
    const lo = num(args[0]);
    const hi = num(args[1]);
    if (isError(lo)) return lo;
    if (isError(hi)) return hi;
    const a = Math.ceil(lo);
    const b = Math.floor(hi);
    if (b < a) return errors.num;
    return a + Math.floor(Math.random() * (b - a + 1));
  },
);

