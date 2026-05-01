/**
 * Financial functions: PMT, PV, FV, NPER, RATE, NPV, IRR, XNPV, XIRR, SLN.
 * Signs follow Excel: money you pay out is negative, money you receive is
 * positive.
 */
import { CellError, errors } from "../ast";
import { argValues, isError, scalarArg, tidy, toNumber, type Arg, type EvalContext, type Scalar } from "../evaluate";
import { define } from "./define";

function nums(args: Arg[], from: number, count: number, defaults: number[] = []): number[] | CellError {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = args[from + i];
    if (a === undefined || (a.kind === "value" && a.value === null)) {
      if (defaults[i] === undefined) return errors.value;
      out.push(defaults[i]);
      continue;
    }
    const n = toNumber(scalarArg(a));
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

/** The numbers in a list of ranges/values, in order (text and blanks skipped, like NPV). */
function cashflows(args: Arg[], ctx: EvalContext): number[] | CellError {
  const out: number[] = [];
  for (const a of args) {
    if (a.kind === "range") {
      let err: CellError | null = null;
      a.ctx.eachInRange(a.range, (v) => {
        if (err) return;
        if (isError(v)) err = v;
        else if (typeof v === "number") out.push(v);
      });
      if (err) return err;
    } else {
      for (const v of argValues(a)) {
        const n = toNumber(v);
        if (isError(n)) return n;
        out.push(n);
      }
    }
  }
  void ctx;
  return out;
}

/** Future value of a loan / annuity (Excel's FV), type 1 = payments at the start. */
function fv(rate: number, nper: number, pmt: number, pv: number, type: number): number {
  if (rate === 0) return -(pv + pmt * nper);
  const g = (1 + rate) ** nper;
  return -(pv * g + (pmt * (1 + rate * type) * (g - 1)) / rate);
}

const money = (x: number) => tidy(Number(x.toPrecision(15)));

const loanArgs = {
  rate: { name: "rate", description: "interest rate per period (e.g. 5%/12 for monthly)" },
  nper: { name: "nper", description: "number of periods" },
  pmt: { name: "pmt", description: "payment each period (negative when you pay)" },
  pv: { name: "pv", description: "present value: the loan amount or investment now" },
  fv: { name: "fv", description: "the value wanted after the last payment; 0 if left out", optional: true },
  type: { name: "type", description: "0 (default): payments at the end of each period; 1: at the start", optional: true },
};

define(
  {
    name: "PMT",
    category: "Financial",
    summary: "The payment per period for a loan or annuity with a fixed rate.",
    args: [loanArgs.rate, loanArgs.nper, loanArgs.pv, loanArgs.fv, loanArgs.type],
    examples: [["=ROUND(PMT(5%/12, 60, 10000), 2)", -188.71], ["=PMT(0, 10, 1000)", -100]],
  },
  (args) => {
    const n = nums(args, 0, 5, [NaN, NaN, NaN, 0, 0]);
    if (isError(n)) return n;
    const [rate, nper, pv, fvv, type] = n;
    if (nper === 0) return errors.num;
    if (rate === 0) return money(-(pv + fvv) / nper);
    const g = (1 + rate) ** nper;
    return money((-rate * (pv * g + fvv)) / ((1 + rate * type) * (g - 1)));
  },
);

define(
  {
    name: "FV",
    category: "Financial",
    summary: "What regular payments and a starting amount grow to at a fixed rate.",
    args: [loanArgs.rate, loanArgs.nper, loanArgs.pmt, { ...loanArgs.pv, optional: true }, loanArgs.type],
    examples: [
      ["=ROUND(FV(6%/12, 10, -200, -500, 1), 2)", 2581.4],
      ["=ROUND(FV(6%/12, 10, -200, -500), 2)", 2571.18],
    ],
  },
  (args) => {
    const n = nums(args, 0, 5, [NaN, NaN, NaN, 0, 0]);
    if (isError(n)) return n;
    return money(fv(n[0], n[1], n[2], n[3], n[4]));
  },
);

define(
  {
    name: "PV",
    category: "Financial",
    summary: "What a series of future payments is worth today at a fixed rate.",
    args: [loanArgs.rate, loanArgs.nper, loanArgs.pmt, loanArgs.fv, loanArgs.type],
    examples: [["=ROUND(PV(8%/12, 240, 500), 2)", -59777.15]],
  },
  (args) => {
    const n = nums(args, 0, 5, [NaN, NaN, NaN, 0, 0]);
    if (isError(n)) return n;
    const [rate, nper, pmt, fvv, type] = n;
    if (rate === 0) return money(-(fvv + pmt * nper));
    const g = (1 + rate) ** nper;
    return money(-(fvv + (pmt * (1 + rate * type) * (g - 1)) / rate) / g);
  },
);

define(
  {
    name: "NPER",
    category: "Financial",
    summary: "How many periods a loan or saving takes at a fixed payment and rate.",
    args: [loanArgs.rate, loanArgs.pmt, loanArgs.pv, loanArgs.fv, loanArgs.type],
    examples: [["=ROUND(NPER(1%, -100, 1000), 2)", 10.59]],
  },
  (args) => {
    const n = nums(args, 0, 5, [NaN, NaN, NaN, 0, 0]);
    if (isError(n)) return n;
    const [rate, pmt, pv, fvv, type] = n;
    if (rate === 0) return pmt === 0 ? errors.num : money(-(pv + fvv) / pmt);
    const a = pmt * (1 + rate * type);
    const num = (a - fvv * rate) / (a + pv * rate);
    if (num <= 0) return errors.num;
    return money(Math.log(num) / Math.log(1 + rate));
  },
);

/** Newton's method with a fallback bisection; null if it doesn't settle. */
function solve(f: (x: number) => number, guess: number): number | null {
  let x = guess;
  for (let i = 0; i < 100; i++) {
    const y = f(x);
    if (Math.abs(y) < 1e-10) return x;
    const h = Math.max(1e-7, Math.abs(x) * 1e-7);
    const d = (f(x + h) - y) / h;
    if (!Number.isFinite(d) || d === 0) break;
    const next = x - y / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - x) < 1e-12) return next;
    x = next;
  }
  // bisection over a wide bracket
  let lo = -0.9999;
  let hi = 10;
  let flo = f(lo);
  if (!Number.isFinite(flo) || flo * f(hi) > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-10) return mid;
    if (flo * fm < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

define(
  {
    name: "RATE",
    category: "Financial",
    summary: "The interest rate per period of a loan or annuity.",
    args: [loanArgs.nper, loanArgs.pmt, loanArgs.pv, loanArgs.fv, loanArgs.type, { name: "guess", description: "a starting guess; 10% if left out", optional: true }],
    examples: [["=ROUND(RATE(48, -200, 8000), 6)", 0.007701]],
  },
  (args) => {
    const n = nums(args, 0, 6, [NaN, NaN, NaN, 0, 0, 0.1]);
    if (isError(n)) return n;
    const [nper, pmt, pv, fvv, type, guess] = n;
    const r = solve((rate) => (rate === 0 ? pv + pmt * nper + fvv : pv * (1 + rate) ** nper + (pmt * (1 + rate * type) * ((1 + rate) ** nper - 1)) / rate + fvv), guess);
    return r === null ? errors.num : money(r);
  },
);

define(
  {
    name: "NPV",
    category: "Financial",
    summary: "Net present value of cash flows at the end of each period (the first flow is discounted one period, as in Excel).",
    args: [
      { name: "rate", description: "discount rate per period" },
      { name: "value1", description: "cash flows: numbers, cells or ranges, in order" },
      { name: "value2", description: "more", optional: true, repeats: true },
    ],
    examples: [["=ROUND(NPV(10%, -10000, 3000, 4200, 6800), 2)", 1188.44]],
  },
  (args, ctx) => {
    if (args.length < 2) return errors.value;
    const rate = toNumber(scalarArg(args[0]));
    if (isError(rate)) return rate;
    const cf = cashflows(args.slice(1), ctx);
    if (isError(cf)) return cf;
    return money(cf.reduce((acc, c, i) => acc + c / (1 + rate) ** (i + 1), 0));
  },
);

define(
  {
    name: "IRR",
    category: "Financial",
    summary: "The internal rate of return of regular cash flows: the rate at which their NPV is zero.",
    args: [{ name: "values", description: "cash flows in order; at least one negative and one positive" }, { name: "guess", description: "a starting guess; 10% if left out", optional: true }],
    examples: [
      ["=ROUND(IRR(G1:G6), 4)", 0.0866],
      ["=ROUND(IRR(G1:G5), 4)", -0.0212],
      ["=IRR(A1:A3)", "#NUM!"],
    ],
    notes: "Needs both an outflow and an inflow. For flows on irregular dates use XIRR.",
  },
  (args, ctx) => {
    if (args.length < 1 || args.length > 2) return errors.value;
    const cf = cashflows([args[0]], ctx);
    if (isError(cf)) return cf;
    if (!cf.some((c) => c < 0) || !cf.some((c) => c > 0)) return errors.num;
    const guess = args[1] ? toNumber(scalarArg(args[1])) : 0.1;
    if (isError(guess)) return guess;
    const r = solve((rate) => cf.reduce((acc, c, i) => acc + c / (1 + rate) ** i, 0), guess);
    return r === null ? errors.num : money(r);
  },
);

function datedFlows(args: Arg[]): { cf: number[]; days: number[] } | CellError {
  const read = (a: Arg | undefined): Scalar[] => {
    return a ? argValues(a) : [];
  };
  const v = read(args[0]);
  const d = read(args[1]);
  if (v.length !== d.length || v.length < 2) return errors.num;
  const cf: number[] = [];
  const days: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const a = toNumber(v[i]);
    const b = toNumber(d[i]);
    if (isError(a)) return a;
    if (isError(b)) return b;
    cf.push(a);
    days.push(Math.floor(b));
  }
  return { cf, days };
}

const xnpv = (rate: number, cf: number[], days: number[]) => cf.reduce((acc, c, i) => acc + c / (1 + rate) ** ((days[i] - days[0]) / 365), 0);

define(
  {
    name: "XNPV",
    category: "Financial",
    summary: "Net present value of cash flows on specific dates (365-day years, from the first date).",
    args: [
      { name: "rate", description: "the annual discount rate" },
      { name: "values", description: "the cash flows" },
      { name: "dates", description: "their dates, same count" },
    ],
    examples: [["=ROUND(XNPV(9%, E1:E5, F1:F5), 2)", 2086.65]],
  },
  (args) => {
    if (args.length !== 3) return errors.value;
    const rate = toNumber(scalarArg(args[0]));
    if (isError(rate)) return rate;
    const f = datedFlows([args[1], args[2]]);
    if (isError(f)) return f;
    return money(xnpv(rate, f.cf, f.days));
  },
);

define(
  {
    name: "XIRR",
    category: "Financial",
    summary: "The annual internal rate of return of cash flows on specific dates.",
    args: [
      { name: "values", description: "the cash flows; at least one negative and one positive" },
      { name: "dates", description: "their dates, same count" },
      { name: "guess", description: "a starting guess; 10% if left out", optional: true },
    ],
    examples: [["=ROUND(XIRR(E1:E5, F1:F5), 6)", 0.373363]],
  },
  (args) => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const f = datedFlows([args[0], args[1]]);
    if (isError(f)) return f;
    if (!f.cf.some((c) => c < 0) || !f.cf.some((c) => c > 0)) return errors.num;
    const guess = args[2] ? toNumber(scalarArg(args[2])) : 0.1;
    if (isError(guess)) return guess;
    const r = solve((rate) => xnpv(rate, f.cf, f.days), guess);
    return r === null ? errors.num : money(r);
  },
);

define(
  {
    name: "SLN",
    category: "Financial",
    summary: "Straight-line depreciation per period.",
    args: [
      { name: "cost", description: "what the asset cost" },
      { name: "salvage", description: "its value at the end" },
      { name: "life", description: "how many periods it's depreciated over" },
    ],
    examples: [["=SLN(30000, 7500, 10)", 2250]],
  },
  (args) => {
    const n = nums(args, 0, 3);
    if (isError(n)) return n;
    return n[2] === 0 ? errors.div0 : money((n[0] - n[1]) / n[2]);
  },
);
