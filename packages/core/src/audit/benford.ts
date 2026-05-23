/**
 * Benford's law: in many sets of amounts the leading digit is 1 about 30%
 * of the time and 9 under 5%. Compares the actual first digits (or first
 * two digits) with that, with a chi-square test, the mean absolute
 * deviation (MAD) against Nigrini's conformity bands, and a z-statistic per
 * digit to show which digits stand out.
 */
import { cellNumber, type Cell } from "./values";

export type BenfordTest = "first" | "firstTwo";
export type Conformity = "close" | "acceptable" | "marginal" | "nonconformity";

export interface BenfordDigit {
  digit: number;
  /** Expected share, 0 to 1. */
  expected: number;
  expectedCount: number;
  count: number;
  /** Actual share, 0 to 1. */
  actual: number;
  /** Nigrini's z-statistic (with the continuity correction); above 1.96 is significant at 5%. */
  z: number;
}

export interface BenfordResult {
  test: BenfordTest;
  /** Values tested. */
  n: number;
  /** Values left out: blank, not a number, zero, or below the minimum. */
  ignored: number;
  digits: BenfordDigit[];
  chiSquare: number;
  df: number;
  /** Chance of a chi-square this big if the data followed Benford. */
  pValue: number;
  /** Chi-square needed to reject at 5%. */
  critical5: number;
  mad: number;
  conformity: Conformity;
  /** Upper MAD limits for close / acceptable / marginal conformity. */
  bands: [number, number, number];
  /** The digit each input row was counted under, or -1 if left out. */
  rowDigits: Int16Array;
}

/** Nigrini (2012) MAD conformity ranges. */
export const BENFORD_BANDS: Record<BenfordTest, [number, number, number]> = {
  first: [0.006, 0.012, 0.015],
  firstTwo: [0.0012, 0.0018, 0.0022],
};

/** First digit (1-9) or first two digits (10-99) of a non-zero number. */
export function leadingDigits(x: number, two: boolean): number {
  const s = Math.abs(x).toExponential(14); // "1.23450000000000e+3"
  return two ? Number(s[0]) * 10 + Number(s[2]) : Number(s[0]);
}

export function benford(values: Cell[], test: BenfordTest = "first", opts: { min?: number } = {}): BenfordResult {
  const two = test === "firstTwo";
  const lo = two ? 10 : 1;
  const hi = two ? 99 : 9;
  const min = opts.min ?? (two ? 10 : 0);
  const counts = new Float64Array(hi + 1);
  const rowDigits = new Int16Array(values.length).fill(-1);
  let n = 0;
  values.forEach((v, i) => {
    const x = cellNumber(v);
    if (x === null || x === 0 || Math.abs(x) < min) return;
    const d = leadingDigits(x, two);
    counts[d]++;
    rowDigits[i] = d;
    n++;
  });
  const digits: BenfordDigit[] = [];
  let chiSquare = 0;
  let mad = 0;
  for (let d = lo; d <= hi; d++) {
    const p = Math.log10(1 + 1 / d);
    const count = counts[d];
    const actual = n ? count / n : 0;
    const expectedCount = p * n;
    if (n) chiSquare += (count - expectedCount) ** 2 / expectedCount;
    mad += Math.abs(actual - p);
    let z = 0;
    if (n) {
      const diff = Math.abs(actual - p);
      const cc = 1 / (2 * n);
      z = (cc < diff ? diff - cc : diff) / Math.sqrt((p * (1 - p)) / n);
    }
    digits.push({ digit: d, expected: p, expectedCount, count, actual, z });
  }
  const k = hi - lo + 1;
  mad /= k;
  const bands = BENFORD_BANDS[test];
  const conformity: Conformity = mad <= bands[0] ? "close" : mad <= bands[1] ? "acceptable" : mad <= bands[2] ? "marginal" : "nonconformity";
  const df = k - 1;
  return {
    test,
    n,
    ignored: values.length - n,
    digits,
    chiSquare,
    df,
    pValue: n ? 1 - chiSquareCdf(chiSquare, df) : 1,
    critical5: chiSquareCritical(df, 0.05),
    mad,
    conformity,
    bands,
    rowDigits,
  };
}

// ---------------------------------------------------------------- stats --

function logGamma(x: number): number {
  // Lanczos approximation
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised lower incomplete gamma P(a, x). */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const lg = logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lg);
  }
  // continued fraction for Q, then P = 1 - Q
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lg) * h;
}

/** Chi-square cumulative distribution. */
export function chiSquareCdf(x: number, df: number): number {
  return gammaP(df / 2, x / 2);
}

/** The chi-square value with `alpha` of the distribution above it. */
export function chiSquareCritical(df: number, alpha = 0.05): number {
  let lo = 0;
  let hi = Math.max(10, df * 4);
  while (1 - chiSquareCdf(hi, df) > alpha) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (1 - chiSquareCdf(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
