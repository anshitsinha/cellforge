/**
 * Profiling a population: stratification into value bands, the largest
 * items, Pareto (how few items make up most of the value) and ageing
 * buckets from a date and an as-of date.
 */
import type { DateOrder } from "../clean/values";
import { cellDate, cellNumber, plain, type Cell } from "./values";

// --------------------------------------------------------- stratify --

export interface Stratum {
  /** Lower bound (included), or null for "below the first boundary". */
  from: number | null;
  /** Upper bound (not included), or null for "and over". */
  to: number | null;
  label: string;
  count: number;
  total: number;
  /** Shares of the count and of the absolute value, 0 to 1. */
  countShare: number;
  valueShare: number;
  min: number;
  max: number;
}

export interface StratifyResult {
  strata: Stratum[];
  /** Boundaries used, ascending. */
  bounds: number[];
  count: number;
  total: number;
  /** Rows that aren't numbers. */
  ignored: number;
  /** The stratum each row is in, or -1. */
  rowStratum: Int32Array;
}

/** A round step near `x`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Round boundaries splitting min..max into about `bands` equal-width bands. */
export function autoBounds(min: number, max: number, bands = 5): number[] {
  if (!(max > min)) return [];
  const step = niceStep((max - min) / Math.max(1, bands));
  const out: number[] = [];
  for (let b = Math.floor(min / step) * step + step; b <= max && out.length < 1000; b += step) out.push(Math.round(b / step) * step);
  return out;
}

/**
 * Split numbers into bands. `bounds` are the boundaries between bands
 * (ascending): [1000, 10000] gives under 1,000, 1,000 to under 10,000, and
 * 10,000 and over. Without bounds, round ones are picked for `bands` bands.
 */
export function stratify(values: Cell[], opts: { bounds?: number[]; bands?: number } = {}): StratifyResult {
  const nums = values.map((v) => cellNumber(v));
  let min = Infinity;
  let max = -Infinity;
  for (const x of nums) {
    if (x === null) continue;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const bounds = opts.bounds ? [...new Set(opts.bounds)].sort((a, b) => a - b) : autoBounds(min, max, opts.bands ?? 5);
  const strata: Stratum[] = [];
  for (let i = 0; i <= bounds.length; i++) {
    const from = i ? bounds[i - 1] : null;
    const to = i < bounds.length ? bounds[i] : null;
    const label = from === null && to === null ? "All" : from === null ? `Under ${plain(to!)}` : to === null ? `${plain(from)} and over` : `${plain(from)} to under ${plain(to)}`;
    strata.push({ from, to, label, count: 0, total: 0, countShare: 0, valueShare: 0, min: NaN, max: NaN });
  }
  const rowStratum = new Int32Array(values.length).fill(-1);
  let count = 0;
  let total = 0;
  let absTotal = 0;
  nums.forEach((x, r) => {
    if (x === null) return;
    // first boundary above x
    let lo = 0;
    let hi = bounds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bounds[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    const s = strata[lo];
    s.count++;
    s.total += x;
    s.min = Number.isNaN(s.min) ? x : Math.min(s.min, x);
    s.max = Number.isNaN(s.max) ? x : Math.max(s.max, x);
    rowStratum[r] = lo;
    count++;
    total += x;
    absTotal += Math.abs(x);
  });
  const absBy = new Float64Array(strata.length);
  nums.forEach((x, r) => {
    if (x !== null) absBy[rowStratum[r]] += Math.abs(x);
  });
  strata.forEach((s, i) => {
    s.countShare = count ? s.count / count : 0;
    s.valueShare = absTotal ? absBy[i] / absTotal : 0;
  });
  return { strata, bounds, count, total, ignored: values.length - count, rowStratum };
}

// ------------------------------------------------------------ top N --

export interface RankedItem {
  row: number;
  value: number;
  /** Share of the total absolute value, and running share. */
  share: number;
  cumulative: number;
}

/** The `n` largest values (by absolute size if `abs`), biggest first. */
export function topN(values: Cell[], n: number, opts: { abs?: boolean } = {}): { items: RankedItem[]; total: number; count: number } {
  const rows: number[] = [];
  const nums = new Float64Array(values.length);
  let total = 0;
  values.forEach((v, r) => {
    const x = cellNumber(v);
    if (x === null) return;
    nums[r] = x;
    rows.push(r);
    total += Math.abs(x);
  });
  const size = (r: number) => (opts.abs ? Math.abs(nums[r]) : nums[r]);
  rows.sort((a, b) => size(b) - size(a) || a - b);
  let cum = 0;
  const items = rows.slice(0, Math.max(0, n)).map((row) => {
    const share = total ? Math.abs(nums[row]) / total : 0;
    cum += share;
    return { row, value: nums[row], share, cumulative: cum };
  });
  return { items, total, count: rows.length };
}

// ----------------------------------------------------------- Pareto --

export interface ParetoItem {
  /** The group's name (the key value), or the row number as text when there are no keys. */
  key: string;
  rows: number[];
  total: number;
  share: number;
  cumulative: number;
}

export interface ParetoResult {
  items: ParetoItem[];
  total: number;
  /** Items needed to reach `cutoff` of the total. */
  itemsToCutoff: number;
  cutoff: number;
}

/**
 * Totals per key (vendor, account…) by absolute value, largest first,
 * with each one's share and the running share. Without keys each row is
 * its own item.
 */
export function pareto(values: Cell[], keys?: Cell[], cutoff = 0.8): ParetoResult {
  const groups = new Map<string, ParetoItem>();
  let total = 0;
  values.forEach((v, r) => {
    const x = cellNumber(v);
    if (x === null) return;
    const key = keys ? String(keys[r] ?? "").trim() : String(r);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, rows: [], total: 0, share: 0, cumulative: 0 }));
    g.rows.push(r);
    g.total += x;
    total += Math.abs(x);
  });
  const items = [...groups.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.rows[0] - b.rows[0]);
  let absTotal = 0;
  for (const g of items) absTotal += Math.abs(g.total);
  let cum = 0;
  let itemsToCutoff = 0;
  for (const g of items) {
    g.share = absTotal ? Math.abs(g.total) / absTotal : 0;
    const before = cum;
    cum += g.share;
    g.cumulative = cum;
    if (before < cutoff - 1e-12) itemsToCutoff++;
  }
  return { items, total, itemsToCutoff, cutoff };
}

// ----------------------------------------------------------- ageing --

export interface AgeBucket {
  label: string;
  /** Days old, inclusive; null for open ends. */
  from: number | null;
  to: number | null;
  count: number;
  total: number;
  /** Share of the total amount (or of the count without amounts). */
  share: number;
}

export interface AgeingResult {
  buckets: AgeBucket[];
  /** Days between each row's date and the as-of date (NaN when no date). */
  rowDays: Float64Array;
  /** The bucket each row is in, or -1 when it has no date. */
  rowBucket: Int32Array;
  noDate: number;
  total: number;
}

/**
 * Age items by days from their date to `asOf` (a date serial). `limits` are
 * the bucket ends: [30, 60, 90] gives 0-30, 31-60, 61-90 and over 90.
 * Dates after the as-of date go in "Not yet due".
 */
export function ageing(dates: Cell[], asOf: number, opts: { limits?: number[]; amounts?: Cell[]; dateOrder?: DateOrder } = {}): AgeingResult {
  const limits = [...new Set(opts.limits ?? [30, 60, 90])].filter((x) => x >= 0).sort((a, b) => a - b);
  const buckets: AgeBucket[] = [{ label: "Not yet due", from: null, to: -1, count: 0, total: 0, share: 0 }];
  let prev = 0;
  for (const l of limits) {
    buckets.push({ label: `${prev}-${l}`, from: prev, to: l, count: 0, total: 0, share: 0 });
    prev = l + 1;
  }
  buckets.push({ label: limits.length ? `Over ${limits[limits.length - 1]}` : "0 and over", from: prev, to: null, count: 0, total: 0, share: 0 });
  const rowDays = new Float64Array(dates.length).fill(NaN);
  const rowBucket = new Int32Array(dates.length).fill(-1);
  const today = Math.floor(asOf);
  let noDate = 0;
  let total = 0;
  dates.forEach((v, r) => {
    const d = cellDate(v, opts.dateOrder);
    if (d === null) {
      noDate++;
      return;
    }
    const days = today - Math.floor(d);
    rowDays[r] = days;
    let b: number;
    if (days < 0) b = 0;
    else {
      b = buckets.length - 1;
      for (let i = 0; i < limits.length; i++) {
        if (days <= limits[i]) {
          b = i + 1;
          break;
        }
      }
    }
    rowBucket[r] = b;
    const amount = opts.amounts ? (cellNumber(opts.amounts[r]) ?? 0) : 1;
    buckets[b].count++;
    buckets[b].total += amount;
    total += amount;
  });
  for (const b of buckets) b.share = total ? b.total / total : 0;
  return { buckets, rowDays, rowBucket, noDate, total };
}
