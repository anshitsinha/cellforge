/**
 * Statistics: MEDIAN, MODE, STDEV, VAR, LARGE, SMALL, RANK, PERCENTILE,
 * QUARTILE, COUNTBLANK, CORREL. Like SUM, they skip text, TRUE/FALSE and
 * empty cells inside ranges and take numbers typed as arguments.
 */
import { CellError, errors, type RangeRef } from "../ast";
import { eachValue, isError, scalarArg, tidy, toNumber, type Arg, type EvalContext, type Scalar } from "../evaluate";
import { define } from "./define";

/** The numbers in the arguments, Excel style; the first error wins. */
function numbers(args: Arg[], ctx: EvalContext): number[] | CellError {
  const xs: number[] = [];
  let err: CellError | null = null;
  eachValue(args, ctx, (v, fromRange) => {
    if (err) return;
    if (isError(v)) return void (err = v);
    if (typeof v === "number") xs.push(v);
    else if (!fromRange) {
      const n = toNumber(v);
      if (isError(n)) err = n;
      else xs.push(n);
    }
  });
  return err ?? xs;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function variance(xs: number[], sample: boolean): number | CellError {
  if (xs.length < (sample ? 2 : 1)) return errors.div0;
  const m = mean(xs);
  const ss = xs.reduce((a, x) => a + (x - m) ** 2, 0);
  return ss / (xs.length - (sample ? 1 : 0));
}

const numArgs = [
  { name: "number1", description: "a number, cell or range" },
  { name: "number2", description: "more", optional: true, repeats: true },
];

function onNumbers(name: string, summary: string, fn: (xs: number[]) => Scalar, examples: [string, string | number | boolean][], aliases: string[] = []) {
  const impl = (args: Arg[], ctx: EvalContext) => {
    const xs = numbers(args, ctx);
    return isError(xs) ? xs : fn(xs);
  };
  define({ name, category: "Statistics", summary, args: numArgs, examples }, impl);
  for (const a of aliases) define({ name: a, category: "Statistics", summary: `The same as ${name}.`, args: numArgs, examples: [[examples[0][0].replace(name, a), examples[0][1]]] }, impl);
}

onNumbers(
  "MEDIAN",
  "The middle value (the average of the two middle ones for an even count).",
  (xs) => {
    if (!xs.length) return errors.num;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : tidy((s[m - 1] + s[m]) / 2);
  },
  [["=MEDIAN(A1:A5)", 20], ["=MEDIAN(1, 2, 3, 4)", 2.5]],
);

onNumbers(
  "MODE.SNGL",
  "The most common value (the first one if there's a tie); #N/A if no value repeats.",
  (xs) => {
    const counts = new Map<number, number>();
    let best: number | null = null;
    let bestN = 1;
    for (const x of xs) {
      const n = (counts.get(x) ?? 0) + 1;
      counts.set(x, n);
      if (n > bestN) {
        bestN = n;
        best = x;
      }
    }
    // ties go to the value that appeared first
    if (best !== null) for (const x of xs) if (counts.get(x) === bestN) return x;
    return errors.na;
  },
  [["=MODE.SNGL(1, 2, 2, 3, 3)", 2]],
  ["MODE"],
);

onNumbers("STDEV.S", "Standard deviation of a sample (divides by n - 1).", (xs) => {
  const v = variance(xs, true);
  return isError(v) ? v : tidy(Math.sqrt(v));
}, [["=STDEV.S(A1:A5)", 10]], ["STDEV"]);

onNumbers("STDEV.P", "Standard deviation of a whole population (divides by n).", (xs) => {
  const v = variance(xs, false);
  return isError(v) ? v : tidy(Math.sqrt(v));
}, [["=ROUND(STDEV.P(A1:A5), 4)", 8.165]], ["STDEVP"]);

onNumbers("VAR.S", "Variance of a sample (divides by n - 1).", (xs) => {
  const v = variance(xs, true);
  return isError(v) ? v : tidy(v);
}, [["=VAR.S(A1:A5)", 100]], ["VAR"]);

onNumbers("VAR.P", "Variance of a whole population (divides by n).", (xs) => {
  const v = variance(xs, false);
  return isError(v) ? v : tidy(Number(v.toPrecision(15)));
}, [["=ROUND(VAR.P(A1:A5), 4)", 66.6667]], ["VARP"]);

function kth(largest: boolean) {
  return (args: Arg[], ctx: EvalContext): Scalar => {
    if (args.length !== 2) return errors.value;
    const xs = numbers([args[0]], ctx);
    if (isError(xs)) return xs;
    const k = toNumber(scalarArg(args[1]));
    if (isError(k)) return k;
    const i = Math.ceil(k);
    if (i < 1 || i > xs.length) return errors.num;
    const s = [...xs].sort((a, b) => (largest ? b - a : a - b));
    return s[i - 1];
  };
}

define(
  {
    name: "LARGE",
    category: "Statistics",
    summary: "The k-th largest value (1 = the largest).",
    args: [{ name: "range", description: "the numbers" }, { name: "k", description: "which one, 1 = the largest" }],
    examples: [["=LARGE(A1:A5, 2)", 20]],
  },
  kth(true),
);

define(
  {
    name: "SMALL",
    category: "Statistics",
    summary: "The k-th smallest value (1 = the smallest).",
    args: [{ name: "range", description: "the numbers" }, { name: "k", description: "which one, 1 = the smallest" }],
    examples: [["=SMALL(A1:A5, 1)", 10]],
  },
  kth(false),
);

const rankImpl = (args: Arg[], ctx: EvalContext): Scalar => {
  if (args.length < 2 || args.length > 3) return errors.value;
  const x = toNumber(scalarArg(args[0]));
  if (isError(x)) return x;
  const xs = numbers([args[1]], ctx);
  if (isError(xs)) return xs;
  const asc = args[2] ? toNumber(scalarArg(args[2])) : 0;
  if (isError(asc)) return asc;
  if (!xs.includes(x)) return errors.na;
  // ties share the best rank (RANK.EQ)
  return 1 + xs.filter((v) => (asc ? v < x : v > x)).length;
};

define(
  {
    name: "RANK.EQ",
    category: "Statistics",
    summary: "Where a number ranks in a list (1 = the largest, or the smallest if order is 1). Ties share a rank.",
    args: [
      { name: "number", description: "the number to rank" },
      { name: "range", description: "the list" },
      { name: "order", description: "0 or left out: largest first; 1: smallest first", optional: true },
    ],
    examples: [
      ["=RANK.EQ(20, A1:A5)", 2],
      ["=RANK.EQ(20, A1:A5, 1)", 2],
      ["=RANK.EQ(10, A1:A5, 1)", 1],
    ],
  },
  rankImpl,
);
define(
  {
    name: "RANK",
    category: "Statistics",
    summary: "The same as RANK.EQ.",
    args: [
      { name: "number", description: "the number to rank" },
      { name: "range", description: "the list" },
      { name: "order", description: "0: largest first; 1: smallest first", optional: true },
    ],
    examples: [["=RANK(30, A1:A5)", 1]],
  },
  rankImpl,
);

function percentileOf(xs: number[], p: number): number | CellError {
  if (!xs.length || p < 0 || p > 1) return errors.num;
  const s = [...xs].sort((a, b) => a - b);
  const pos = p * (s.length - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return tidy(lo + 1 < s.length ? s[lo] + frac * (s[lo + 1] - s[lo]) : s[lo]);
}

const pctImpl = (args: Arg[], ctx: EvalContext): Scalar => {
  if (args.length !== 2) return errors.value;
  const xs = numbers([args[0]], ctx);
  if (isError(xs)) return xs;
  const p = toNumber(scalarArg(args[1]));
  return isError(p) ? p : percentileOf(xs, p);
};

define(
  {
    name: "PERCENTILE.INC",
    category: "Statistics",
    summary: "The value below which a given share of the data falls (0.9 = 90th percentile), interpolating between values.",
    args: [{ name: "range", description: "the numbers" }, { name: "k", description: "a share from 0 to 1" }],
    examples: [["=PERCENTILE.INC(A1:A5, 0.5)", 20], ["=PERCENTILE.INC(A1:A5, 0.25)", 15]],
  },
  pctImpl,
);
define(
  {
    name: "PERCENTILE",
    category: "Statistics",
    summary: "The same as PERCENTILE.INC.",
    args: [{ name: "range", description: "the numbers" }, { name: "k", description: "a share from 0 to 1" }],
    examples: [["=PERCENTILE(A1:A5, 1)", 30]],
  },
  pctImpl,
);

const quartImpl = (args: Arg[], ctx: EvalContext): Scalar => {
  if (args.length !== 2) return errors.value;
  const xs = numbers([args[0]], ctx);
  if (isError(xs)) return xs;
  const q = toNumber(scalarArg(args[1]));
  if (isError(q)) return q;
  const k = Math.trunc(q);
  if (k < 0 || k > 4) return errors.num;
  return percentileOf(xs, k / 4);
};

define(
  {
    name: "QUARTILE.INC",
    category: "Statistics",
    summary: "A quartile: 0 minimum, 1 first quartile, 2 median, 3 third quartile, 4 maximum.",
    args: [{ name: "range", description: "the numbers" }, { name: "quart", description: "0 to 4" }],
    examples: [["=QUARTILE.INC(A1:A5, 3)", 25]],
  },
  quartImpl,
);
define(
  {
    name: "QUARTILE",
    category: "Statistics",
    summary: "The same as QUARTILE.INC.",
    args: [{ name: "range", description: "the numbers" }, { name: "quart", description: "0 to 4" }],
    examples: [["=QUARTILE(A1:A5, 1)", 15]],
  },
  quartImpl,
);

define(
  {
    name: "COUNTBLANK",
    category: "Statistics",
    summary: 'How many cells in a range are empty (a formula showing "" counts as empty here).',
    args: [{ name: "range", description: "the cells to check" }],
    examples: [["=COUNTBLANK(A1:A5)", 1]],
  },
  (args) => {
    const a = args[0];
    if (args.length !== 1 || a.kind !== "range") return errors.value;
    const rows = a.ctx.rowCount ?? 1_048_576;
    const r: RangeRef = { ...a.range, bottom: Math.min(a.range.bottom, rows - 1) };
    let n = 0;
    a.ctx.eachInRange(r, (v) => {
      if (v === null || v === "") n++;
    });
    return n;
  },
);

define(
  {
    name: "CORREL",
    category: "Statistics",
    summary: "How closely two lists move together, from -1 to 1. Pairs where either side isn't a number are skipped.",
    args: [{ name: "array1", description: "the first list" }, { name: "array2", description: "the second list, same size" }],
    examples: [["=CORREL(A1:A3, A1:A3)", 1]],
  },
  (args) => {
    if (args.length !== 2 || args[0].kind !== "range" || args[1].kind !== "range") return errors.value;
    const a: Scalar[] = [];
    const b: Scalar[] = [];
    args[0].ctx.eachInRange(args[0].range, (v) => a.push(v));
    args[1].ctx.eachInRange(args[1].range, (v) => b.push(v));
    if (a.length !== b.length) return errors.na;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (isError(x)) return x;
      if (isError(y)) return y;
      if (typeof x === "number" && typeof y === "number") {
        xs.push(x);
        ys.push(y);
      }
    }
    if (xs.length < 2) return errors.div0;
    const mx = mean(xs);
    const my = mean(ys);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    if (sxx === 0 || syy === 0) return errors.div0;
    return tidy(Number((sxy / Math.sqrt(sxx * syy)).toPrecision(15)));
  },
);
