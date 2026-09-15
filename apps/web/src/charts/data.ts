/**
 * Turning cells into something to draw: reading series out of a range, and
 * the calculations behind the analyst charts (histogram bins, waterfall
 * running totals, Pareto, Benford, ageing buckets). Also the downsampling
 * that lets a line or scatter of millions of points draw in a few ms.
 *
 * Nothing here touches the DOM, so it's all unit tested.
 */
import { dateToSerial, formatValue, isDateFormat, type ColumnData } from "@cellforge/core";
import type { CellValue } from "@cellforge/grid";
import { isLink, LAST_ROW, type ChartRange, type ChartSpec, type Limit } from "./model";

/** The bits of a sheet a chart reads. EditableSource fits. */
export interface ChartSource {
  getCell(row: number, col: number): CellValue;
  getStyle?(row: number, col: number): { numFmt?: string } | null | undefined;
  usedRange?(): { rows: number; cols: number };
  /** fast path for untouched imported number columns */
  baseColumn?(col: number): ColumnData | null;
  readonly rowOrder?: unknown;
}

// -----------------------------------------------------------------------------
// reading a block

export interface Block {
  names: string[];
  /** label (or x) of each point as a number, NaN when it isn't one */
  labelNums: Float64Array | null;
  /** label of each point when it's text (null where it's a number or blank) */
  labelTexts: (string | null)[] | null;
  series: Float64Array[];
  valueFmt: string;
  labelFmt: string;
  /** every non-blank label is a number (or date) */
  labelsNumeric: boolean;
}

const num = (v: CellValue): number => (typeof v === "number" ? v : NaN);

/** The range cut down to the cells the sheet actually uses. */
export function clampRange(src: ChartSource, r: ChartRange): ChartRange {
  const used = src.usedRange?.();
  if (!used) return r.bottom >= LAST_ROW ? { ...r, bottom: r.top } : r;
  return { ...r, bottom: Math.min(r.bottom, Math.max(r.top, used.rows - 1)), right: Math.min(r.right, Math.max(r.left, used.cols - 1)) };
}

function readColumn(src: ChartSource, col: number, r0: number, r1: number): Float64Array {
  if (r1 < r0) return new Float64Array(0);
  if (!src.rowOrder && src.baseColumn) {
    const c = src.baseColumn(col);
    if (c && c.kind === "number" && r1 < c.values.length) return c.values.subarray(r0, r1 + 1);
  }
  const out = new Float64Array(r1 - r0 + 1);
  for (let r = r0; r <= r1; r++) out[r - r0] = num(src.getCell(r, col));
  return out;
}

/** Read names, labels and series out of the chart's range. */
export function readBlock(src: ChartSource, spec: Pick<ChartSpec, "range" | "seriesIn" | "names" | "labels" | "series" | "labelCol">): Block {
  const r = clampRange(src, spec.range);
  const byCol = spec.seriesIn === "columns";
  // "point" runs along rows when series are columns, along columns otherwise
  const p0 = (byCol ? r.top : r.left) + (spec.names ? 1 : 0);
  const p1 = byCol ? r.bottom : r.right;
  const s0 = (byCol ? r.left : r.top) + (spec.labels ? 1 : 0);
  const s1 = byCol ? r.right : r.bottom;
  const cell = (s: number, p: number) => (byCol ? src.getCell(p, s) : src.getCell(s, p));
  const style = (s: number, p: number) => (byCol ? src.getStyle?.(p, s) : src.getStyle?.(s, p));
  const nameAt = byCol ? r.top : r.left;
  // series in columns may name the label column and the series columns (charts/defaults.ts)
  const labelAt = byCol && spec.labelCol !== undefined && spec.labelCol >= r.left && spec.labelCol <= r.right ? spec.labelCol : byCol ? r.left : r.top;
  const chosen = byCol && spec.series?.length ? spec.series.filter((c) => c >= r.left && c <= r.right) : null;
  const order: number[] = [];
  if (chosen) order.push(...chosen);
  else for (let s = s0; s <= s1; s++) order.push(s);

  const series: Float64Array[] = [];
  const names: string[] = [];
  for (const s of order) {
    if (byCol) series.push(readColumn(src, s, p0, p1));
    else {
      const a = new Float64Array(Math.max(0, p1 - p0 + 1));
      for (let p = p0; p <= p1; p++) a[p - p0] = num(cell(s, p));
      series.push(a);
    }
    const nv = spec.names ? cell(s, nameAt) : null;
    names.push(nv === null || nv === "" ? `Series ${names.length + 1}` : typeof nv === "number" ? formatValue(nv, style(s, nameAt)?.numFmt).text : nv);
  }

  let labelNums: Float64Array | null = null;
  let labelTexts: (string | null)[] | null = null;
  let labelsNumeric = false;
  if (spec.labels) {
    let numbers = 0;
    let texts = 0;
    const fast = byCol && p1 >= p0 && !src.rowOrder ? src.baseColumn?.(labelAt) : null;
    if (fast && fast.kind === "number" && p1 < fast.values.length) {
      labelNums = fast.values.subarray(p0, p1 + 1);
      numbers = 1;
    } else {
      labelNums = new Float64Array(Math.max(0, p1 - p0 + 1));
      for (let p = p0; p <= p1; p++) {
        const v = cell(labelAt, p);
        if (typeof v === "number") {
          labelNums[p - p0] = v;
          numbers++;
        } else {
          labelNums[p - p0] = NaN;
          if (v !== null && v !== "") {
            labelTexts ??= new Array<string | null>(p1 - p0 + 1).fill(null);
            labelTexts[p - p0] = v;
            texts++;
          }
        }
      }
    }
    labelsNumeric = numbers > 0 && texts === 0;
  }
  return {
    names,
    labelNums,
    labelTexts,
    series,
    valueFmt: (order.length && p1 >= p0 ? style(order[0], p0)?.numFmt : undefined) ?? "",
    labelFmt: (spec.labels && p1 >= p0 ? style(labelAt, p0)?.numFmt : undefined) ?? "",
    labelsNumeric,
  };
}

/** Text of point i's label, in the label cells' number format. */
export function labelOf(b: Block, i: number, fmt = b.labelFmt): string {
  const t = b.labelTexts?.[i];
  if (t) return t;
  const n = b.labelNums?.[i];
  if (n === undefined) return String(i + 1);
  return n === n ? formatValue(n, fmt).text : "";
}

/**
 * Guess the layout of a fresh range: names in the first row if it has text,
 * labels in the first column if it has text or dates, and series in rows
 * when the block is wider than it is tall.
 */
export function guessLayout(src: ChartSource, range: ChartRange): Pick<ChartSpec, "seriesIn" | "names" | "labels"> {
  const r = clampRange(src, range);
  const rows = r.bottom - r.top + 1;
  const cols = r.right - r.left + 1;
  const isText = (v: CellValue) => typeof v === "string" && v !== "";
  let names = false;
  for (let c = r.left; c <= r.right && !names; c++) names = isText(src.getCell(r.top, c));
  let labels = false;
  const first = r.top + (names ? 1 : 0);
  for (let row = first; row <= Math.min(r.bottom, first + 50) && !labels; row++) labels = isText(src.getCell(row, r.left));
  if (!labels && cols > 1 && rows > 1) labels = isDateFormat(src.getStyle?.(first, r.left)?.numFmt ?? "");
  if (cols === 1) labels = false;
  // a wide block with text down the first column and not along the top: series run across
  const seriesIn = cols > rows && cols > 2 && !names ? "rows" : "columns";
  if (seriesIn === "rows") {
    let ln = false;
    for (let row = r.top; row <= r.bottom && !ln; row++) ln = isText(src.getCell(row, r.left));
    let lb = false;
    for (let c = r.left + 1; c <= r.right && !lb; c++) lb = isText(src.getCell(r.top, c));
    return { seriesIn, names: ln, labels: lb };
  }
  return { seriesIn, names, labels };
}

// -----------------------------------------------------------------------------
// histogram

function finite(values: ArrayLike<number>): Float64Array {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) n++;
  const out = new Float64Array(n);
  n = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) out[n++] = values[i];
  return out;
}

/** Sturges: log2(n) + 1 bins. */
export function sturgesWidth(min: number, max: number, n: number): number {
  const k = Math.ceil(Math.log2(Math.max(n, 1)) + 1);
  return (max - min) / k || 1;
}

/** Freedman–Diaconis: 2 IQR / cube root of n. Falls back to Sturges when the IQR is 0. */
export function fdWidth(sorted: Float64Array): number {
  const n = sorted.length;
  if (n < 2) return 1;
  const q = (p: number) => {
    const h = (n - 1) * p;
    const lo = Math.floor(h);
    return sorted[lo] + (h - lo) * ((sorted[Math.min(lo + 1, n - 1)] ?? sorted[lo]) - sorted[lo]);
  };
  const iqr = q(0.75) - q(0.25);
  const w = (2 * iqr) / Math.cbrt(n);
  return w > 0 ? w : sturgesWidth(sorted[0], sorted[n - 1], n);
}

/** Round a width to 1, 2, 2.5 or 5 x a power of ten so bin edges read well. */
export function niceWidth(w: number): number {
  if (!(w > 0) || !Number.isFinite(w)) return 1;
  const p = 10 ** Math.floor(Math.log10(w));
  const f = w / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

export interface Histogram {
  /** bin i covers [edges[i], edges[i+1]); the last bin includes its upper edge */
  edges: number[];
  counts: number[];
  n: number;
}

const MAX_BINS = 500;

export function histogram(values: ArrayLike<number>, opts: { width?: number | null; rule?: "fd" | "sturges" } = {}): Histogram {
  const xs = finite(values).sort();
  const n = xs.length;
  if (!n) return { edges: [0, 1], counts: [0], n: 0 };
  const min = xs[0];
  const max = xs[n - 1];
  let width = opts.width && opts.width > 0 ? opts.width : niceWidth(opts.rule === "sturges" ? sturgesWidth(min, max, n) : fdWidth(xs));
  if ((max - min) / width > MAX_BINS) width = niceWidth((max - min) / MAX_BINS);
  const start = Math.floor(min / width) * width;
  // the maximum goes in the last bin even when it sits on that bin's upper edge
  const k = Math.max(1, Math.ceil((max - start) / width));
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) counts[Math.min(k - 1, Math.floor((xs[i] - start) / width))]++;
  const edges = Array.from({ length: counts.length + 1 }, (_, i) => +(start + i * width).toPrecision(12));
  return { edges, counts, n };
}

// -----------------------------------------------------------------------------
// waterfall

export interface Waterfall {
  /** where each bar starts */
  base: Float64Array;
  /** signed height of each bar (bar spans base .. base + delta) */
  delta: Float64Array;
  /** running total after each bar */
  end: Float64Array;
  /** 0 increase, 1 decrease, 2 total */
  role: Uint8Array;
}

/** Labels that make a bar a total in a waterfall. */
export const TOTAL_LABEL = /^\s*(sub-?total|total|closing|opening|balance|net|ending|end|start|starting)\b/i;

/**
 * Running totals for a waterfall. A total bar runs from zero to the running
 * total (or to its own value when it has one, which then resets the total).
 */
export function waterfall(values: ArrayLike<number>, totals: ArrayLike<boolean> = []): Waterfall {
  const n = values.length;
  const base = new Float64Array(n);
  const delta = new Float64Array(n);
  const end = new Float64Array(n);
  const role = new Uint8Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (totals[i]) {
      if (Number.isFinite(v)) run = v;
      base[i] = 0;
      delta[i] = run;
      role[i] = 2;
    } else {
      const d = Number.isFinite(v) ? v : 0;
      base[i] = run;
      delta[i] = d;
      run += d;
      role[i] = d < 0 ? 1 : 0;
    }
    end[i] = run;
  }
  return { base, delta, end, role };
}

// -----------------------------------------------------------------------------
// Pareto

export interface Pareto {
  labels: string[];
  values: number[];
  /** cumulative share of the total, 0..1 */
  cumulative: number[];
}

/** Sort largest first and add the cumulative share. Blanks and negatives are left out. */
export function pareto(labels: string[], values: ArrayLike<number>): Pareto {
  const idx: number[] = [];
  for (let i = 0; i < values.length; i++) if (values[i] > 0) idx.push(i);
  idx.sort((a, b) => values[b] - values[a] || a - b);
  let total = 0;
  for (const i of idx) total += values[i];
  let run = 0;
  return {
    labels: idx.map((i) => labels[i] ?? String(i + 1)),
    values: idx.map((i) => values[i]),
    cumulative: idx.map((i) => (run += values[i]) / total),
  };
}

// -----------------------------------------------------------------------------
// Benford

export interface Benford {
  /** share of numbers with leading digit 1..9 (index 0 is digit 1) */
  actual: number[];
  expected: number[];
  counts: number[];
  n: number;
  /** mean absolute deviation from the expected shares */
  mad: number;
  /** Nigrini's first-digit conformity bands */
  verdict: "close conformity" | "acceptable conformity" | "marginal conformity" | "nonconformity" | "too few numbers";
}

export function firstDigit(x: number): number {
  let a = Math.abs(x);
  if (!(a > 0) || !Number.isFinite(a)) return 0;
  const e = Math.floor(Math.log10(a));
  a = a / 10 ** e;
  // guard against log10 rounding (e.g. 1000 -> 0.9999)
  if (a >= 10) a /= 10;
  if (a < 1) a *= 10;
  return Math.floor(a + 1e-9);
}

export function benford(values: ArrayLike<number>): Benford {
  const counts = new Array<number>(9).fill(0);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const d = firstDigit(values[i]);
    if (d) {
      counts[d - 1]++;
      n++;
    }
  }
  const expected = counts.map((_, i) => Math.log10(1 + 1 / (i + 1)));
  const actual = counts.map((c) => (n ? c / n : 0));
  const mad = actual.reduce((s, a, i) => s + Math.abs(a - expected[i]), 0) / 9;
  const verdict = n < 100 ? "too few numbers" : mad <= 0.006 ? "close conformity" : mad <= 0.012 ? "acceptable conformity" : mad <= 0.015 ? "marginal conformity" : "nonconformity";
  return { actual, expected, counts, n, mad, verdict };
}

// -----------------------------------------------------------------------------
// ageing

export interface Ageing {
  labels: string[];
  /** total amount (or count) in each bucket */
  values: number[];
  counts: number[];
}

/** Today as a date serial, in local time. */
export function todaySerial(now = new Date()): number {
  return dateToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/**
 * Bucket dates by age in days at `asOf`: "Not due" (dated after asOf), then
 * 0–30, 31–60 ... and the last bucket open-ended. With amounts, buckets
 * hold the total amount; without, the number of items.
 */
export function ageing(dates: ArrayLike<number>, amounts: ArrayLike<number> | null, asOf: number, bounds: number[]): Ageing {
  const b = [...new Set(bounds.filter((x) => x > 0))].sort((x, y) => x - y);
  const labels = ["Not due", ...b.map((x, i) => `${i ? b[i - 1] + 1 : 0}–${x}`), `${b.length ? b[b.length - 1] + 1 : 0}+`];
  const values = new Array<number>(labels.length).fill(0);
  const counts = new Array<number>(labels.length).fill(0);
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    if (!Number.isFinite(d)) continue;
    const amt = amounts ? amounts[i] : 1;
    if (amounts && !Number.isFinite(amt)) continue;
    const age = Math.floor(asOf) - Math.floor(d);
    let k: number;
    if (age < 0) k = 0;
    else {
      k = b.findIndex((x) => age <= x);
      k = k < 0 ? labels.length - 1 : k + 1;
    }
    values[k] += amt;
    counts[k]++;
  }
  return { labels, values, counts };
}

// -----------------------------------------------------------------------------
// downsampling

/**
 * Largest-Triangle-Three-Buckets: pick `threshold` points that keep the
 * shape of the line. Always keeps the first and last point. Returns indices
 * into the original arrays; NaN points are skipped.
 */
export function lttb(xs: ArrayLike<number>, ys: ArrayLike<number>, threshold: number): Uint32Array {
  const ok: number[] = [];
  for (let i = 0; i < ys.length; i++) if (Number.isFinite(ys[i]) && Number.isFinite(xs[i])) ok.push(i);
  const n = ok.length;
  if (threshold >= n || threshold < 3) return Uint32Array.from(ok);
  const out = new Uint32Array(threshold);
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  out[0] = ok[0];
  for (let i = 0; i < threshold - 2; i++) {
    // average of the next bucket
    const n0 = Math.floor((i + 1) * every) + 1;
    const n1 = Math.min(Math.floor((i + 2) * every) + 1, n);
    let ax = 0;
    let ay = 0;
    for (let j = n0; j < n1; j++) {
      ax += xs[ok[j]];
      ay += ys[ok[j]];
    }
    ax /= n1 - n0 || 1;
    ay /= n1 - n0 || 1;
    // the point of this bucket making the biggest triangle with a and the average
    const r0 = Math.floor(i * every) + 1;
    const r1 = Math.floor((i + 1) * every) + 1;
    const px = xs[ok[a]];
    const py = ys[ok[a]];
    let best = -1;
    let pick = r0;
    for (let j = r0; j < r1; j++) {
      const area = Math.abs((px - ax) * (ys[ok[j]] - py) - (px - xs[ok[j]]) * (ay - py));
      if (area > best) {
        best = area;
        pick = j;
      }
    }
    out[i + 1] = ok[pick];
    a = pick;
  }
  out[threshold - 1] = ok[n - 1];
  return out;
}

/**
 * Min/max per pixel: split the points into `buckets` (by x when xs is
 * sorted, by position otherwise) and keep the first, lowest, highest and
 * last point of each. A line through those looks the same as one through
 * every point, at up to 4 points a pixel. O(n), so fine for 10M points.
 */
export function minMaxBuckets(xs: ArrayLike<number>, ys: ArrayLike<number>, buckets: number, sorted = true): Uint32Array {
  const n = ys.length;
  const out = new Uint32Array(Math.min(n, buckets * 4 + 4));
  let k = 0;
  let x0 = 0;
  let span = n;
  if (sorted && n) {
    let i0 = 0;
    while (i0 < n && !Number.isFinite(xs[i0])) i0++;
    let i1 = n - 1;
    while (i1 > 0 && !Number.isFinite(xs[i1])) i1--;
    x0 = xs[i0];
    span = xs[i1] - x0 || 1;
  }
  let cur = -1;
  let first = -1;
  let lo = -1;
  let hi = -1;
  let last = -1;
  const flush = () => {
    if (first < 0) return;
    const pts = [first, lo, hi, last].sort((a, b) => a - b);
    for (let j = 0; j < 4; j++) if (j === 0 || pts[j] !== pts[j - 1]) out[k++] = pts[j];
  };
  for (let i = 0; i < n; i++) {
    const y = ys[i];
    if (!Number.isFinite(y)) continue;
    const x = sorted ? xs[i] : i;
    if (!Number.isFinite(x)) continue;
    const b = Math.min(buckets - 1, Math.floor(((x - x0) / span) * buckets));
    if (b !== cur) {
      flush();
      cur = b;
      first = lo = hi = last = i;
      continue;
    }
    if (y < ys[lo]) lo = i;
    if (y > ys[hi]) hi = i;
    last = i;
  }
  flush();
  return out.slice(0, k);
}

/**
 * Pick which points of a line to draw for a plot `pixels` wide: all of them
 * when they fit, LTTB for moderate counts and min/max buckets beyond that.
 */
export function downsampleLine(xs: ArrayLike<number>, ys: ArrayLike<number>, pixels: number, sorted: boolean): Uint32Array | null {
  const n = ys.length;
  const px = Math.max(16, Math.floor(pixels));
  if (n <= px * 2) return null;
  if (n <= px * 50 && sorted) return lttb(xs, ys, px * 2);
  return minMaxBuckets(xs, ys, px, sorted);
}

/** True when xs never goes down (NaNs ignored). */
export function isSorted(xs: ArrayLike<number>): boolean {
  let prev = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (x !== x) continue;
    if (x < prev) return false;
    prev = x;
  }
  return true;
}

/**
 * Scatter thinning: keep one point per occupied device pixel. Points that
 * land on a pixel already drawn add nothing visible.
 */
export function thinScatter(xs: ArrayLike<number>, ys: ArrayLike<number>, toX: (x: number) => number, toY: (y: number) => number, w: number, h: number): Uint32Array {
  const W = Math.max(1, Math.ceil(w));
  const H = Math.max(1, Math.ceil(h));
  const seen = new Uint8Array(W * H);
  const keep: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    const px = Math.floor(toX(xs[i]));
    const py = Math.floor(toY(ys[i]));
    if (!(px >= 0 && px < W && py >= 0 && py < H)) continue;
    const at = py * W + px;
    if (seen[at]) continue;
    seen[at] = 1;
    keep.push(i);
  }
  return Uint32Array.from(keep);
}

// -----------------------------------------------------------------------------
// the chart, ready to draw

export type SeriesKind = "column" | "line" | "area" | "point";

export interface Series {
  name: string;
  values: Float64Array;
  kind: SeriesKind;
  /** 0 left axis, 1 right axis */
  axis: 0 | 1;
  /** palette slot */
  color: number;
  /** floating bars: the bar spans base..base+value (waterfall) */
  base?: Float64Array;
  /** per-point colour role: 0 increase, 1 decrease, 2 total (waterfall) */
  roles?: Uint8Array;
}

export interface ChartData {
  mode: "category" | "xy" | "pie";
  horizontal: boolean;
  /** category mode and pie: one label per point */
  categories: string[];
  /** xy mode: x of each point, shared by every series */
  xs: Float64Array | null;
  xSorted: boolean;
  series: Series[];
  stacked: boolean;
  /** share of each category band left empty between bars */
  gap: number;
  yFmt: string;
  y2Fmt: string;
  xFmt: string;
  xIsDate: boolean;
  limits: { yMin: number | null; yMax: number | null; xMin: number | null; xMax: number | null; y2Min: number | null; y2Max: number | null };
  /** say-so lines under the chart (cut-offs, Benford verdict) */
  notes: string[];
  /** extra legend entries (waterfall roles) */
  legend?: { name: string; role: "up" | "down" | "total" }[];
}

/** Bars beyond this make a column chart unreadable; we cut and say so. */
export const MAX_BARS = 2000;
/** The palette has eight colours; more series would mean repeating them. */
export const MAX_SERIES = 8;

/** Combo: which series are lines. Default: the last one. */
export function comboLines(spec: Pick<ChartSpec, "lines">, count: number): number[] {
  return spec.lines.length ? spec.lines.filter((i) => i < count) : count > 1 ? [count - 1] : [];
}

/**
 * Build the drawable chart from a spec. `resolve` reads a cell for limits
 * given as references (returns null when the cell isn't a number).
 */
export function buildChart(src: ChartSource, spec: ChartSpec, resolve: (l: Limit) => number | null = (l) => (typeof l === "number" ? l : null)): ChartData {
  const notes: string[] = [];
  const t = spec.type;
  const block = readBlock(src, spec.type === "ageing" ? { ...spec, labels: false } : spec);
  let series = block.series;
  if (series.length > MAX_SERIES && t !== "benford") {
    notes.push(`Showing the first ${MAX_SERIES} of ${series.length} series.`);
    series = series.slice(0, MAX_SERIES);
  }
  const yFmt = spec.numFmt || block.valueFmt;
  const xFmt = spec.xNumFmt || block.labelFmt;
  const data: ChartData = {
    mode: "category",
    horizontal: t === "bar",
    categories: [],
    xs: null,
    xSorted: true,
    series: [],
    stacked: spec.stacked && (t === "column" || t === "bar" || t === "area" || t === "line"),
    gap: 0.3,
    yFmt,
    y2Fmt: yFmt,
    xFmt,
    xIsDate: false,
    limits: { yMin: resolve(spec.yMin), yMax: resolve(spec.yMax), xMin: resolve(spec.xMin), xMax: resolve(spec.xMax), y2Min: null, y2Max: null },
    notes,
  };
  const n = series[0]?.length ?? 0;
  const cats = (count: number) => {
    if (count > MAX_BARS) notes.push(`Showing the first ${MAX_BARS.toLocaleString()} of ${count.toLocaleString()} points; a line or histogram suits this many.`);
    return Array.from({ length: Math.min(count, MAX_BARS) }, (_, i) => (spec.labels ? labelOf(block, i, xFmt) : String(i + 1)));
  };
  const cut = (a: Float64Array) => (a.length > MAX_BARS ? a.subarray(0, MAX_BARS) : a);
  const mk = (i: number, values: Float64Array, kind: SeriesKind, axis: 0 | 1 = 0): Series => ({ name: block.names[i] ?? `Series ${i + 1}`, values, kind, axis, color: i });

  switch (t) {
    case "column":
    case "bar":
      data.categories = cats(n);
      data.series = series.map((s, i) => mk(i, cut(s), "column"));
      break;
    case "combo": {
      data.categories = cats(n);
      const lines = comboLines(spec, series.length);
      data.series = series.map((s, i) => mk(i, cut(s), lines.includes(i) ? "line" : "column", spec.secondary.includes(i) ? 1 : 0));
      break;
    }
    case "line":
    case "area":
    case "scatter": {
      const kind: SeriesKind = t === "scatter" ? "point" : t;
      if (!spec.labels || block.labelsNumeric || t === "scatter") {
        data.mode = "xy";
        if (spec.labels && !block.labelsNumeric) notes.push("The x column has text, so points are spaced evenly.");
        data.xs = spec.labels && block.labelsNumeric ? block.labelNums : Float64Array.from({ length: n }, (_, i) => i + 1);
        data.xSorted = isSorted(data.xs!);
        data.xIsDate = spec.labels && isDateFormat(xFmt);
        if (!spec.labels) data.xFmt = "0";
        data.series = series.map((s, i) => mk(i, s, kind));
      } else {
        data.categories = cats(n);
        data.series = series.map((s, i) => mk(i, cut(s), kind));
      }
      break;
    }
    case "pie": {
      const s = series[0] ?? new Float64Array(0);
      const labels = Array.from({ length: s.length }, (_, i) => (spec.labels ? labelOf(block, i, xFmt) : String(i + 1)));
      const idx: number[] = [];
      let dropped = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i] > 0) idx.push(i);
        else if (s[i] < 0) dropped++;
      }
      if (dropped) notes.push(`${dropped} negative value${dropped > 1 ? "s" : ""} left out.`);
      if (series.length > 1) notes.push("A pie shows the first series only.");
      // more slices than colours: keep the biggest, fold the rest into Other
      let keep = idx;
      let other = 0;
      if (idx.length > MAX_SERIES) {
        const big = new Set([...idx].sort((a, b) => s[b] - s[a]).slice(0, MAX_SERIES - 1));
        keep = idx.filter((i) => big.has(i));
        for (const i of idx) if (!big.has(i)) other += s[i];
      }
      data.mode = "pie";
      data.categories = keep.map((i) => labels[i]);
      const vals = keep.map((i) => s[i]);
      if (other > 0) {
        data.categories.push("Other");
        vals.push(other);
      }
      data.series = [{ ...mk(0, Float64Array.from(vals), "column") }];
      break;
    }
    case "histogram": {
      const all = series[0] ?? new Float64Array(0);
      if (series.length > 1) notes.push(`Histogram of ${block.names[0]}.`);
      const h = histogram(all, { width: spec.binWidth, rule: spec.binRule });
      data.categories = h.counts.map((_, i) => `${formatValue(h.edges[i], yFmt).text}–${formatValue(h.edges[i + 1], yFmt).text}`);
      data.series = [{ ...mk(0, Float64Array.from(h.counts), "column"), name: "Count" }];
      data.gap = 0.04;
      data.yFmt = "#,##0";
      notes.push(`${h.n.toLocaleString()} values, bins ${formatValue(h.edges[1] - h.edges[0], "General").text} wide.`);
      break;
    }
    case "waterfall": {
      const s = cut(series[0] ?? new Float64Array(0));
      data.categories = cats(s.length);
      const totals = data.categories.map((c, i) => TOTAL_LABEL.test(c) || (i === data.categories.length - 1 && !Number.isFinite(s[i])));
      const w = waterfall(s, totals);
      data.series = [{ ...mk(0, w.delta, "column"), base: w.base, roles: w.role }];
      data.legend = [
        { name: "Increase", role: "up" },
        { name: "Decrease", role: "down" },
        { name: "Total", role: "total" },
      ];
      data.gap = 0.25;
      break;
    }
    case "pareto": {
      const s = series[0] ?? new Float64Array(0);
      const labels = Array.from({ length: s.length }, (_, i) => (spec.labels ? labelOf(block, i, xFmt) : String(i + 1)));
      const p = pareto(labels, s);
      const m = Math.min(p.labels.length, MAX_BARS);
      if (p.labels.length > MAX_BARS) notes.push(`Showing the largest ${MAX_BARS.toLocaleString()} of ${p.labels.length.toLocaleString()}.`);
      data.categories = p.labels.slice(0, m);
      data.series = [mk(0, Float64Array.from(p.values.slice(0, m)), "column"), { name: "Cumulative %", values: Float64Array.from(p.cumulative.slice(0, m)), kind: "line", axis: 1, color: 1 }];
      data.y2Fmt = "0%";
      data.limits.y2Min = 0;
      data.limits.y2Max = 1;
      data.gap = 0.15;
      break;
    }
    case "benford": {
      const all: number[] = [];
      for (const s of block.series) for (let i = 0; i < s.length; i++) all.push(s[i]);
      const b = benford(all);
      data.categories = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
      data.series = [
        { name: "Actual", values: Float64Array.from(b.actual), kind: "column", axis: 0, color: 0 },
        { name: "Benford", values: Float64Array.from(b.expected), kind: "line", axis: 0, color: 1 },
      ];
      data.yFmt = "0%";
      notes.push(`${b.n.toLocaleString()} numbers, mean absolute deviation ${(b.mad * 100).toFixed(2)}%: ${b.verdict}.`);
      break;
    }
    case "ageing": {
      const dates = block.series[0] ?? new Float64Array(0);
      const amounts = block.series[1] ?? null;
      const asOf = resolve(spec.asOf) ?? todaySerial();
      const a = ageing(dates, amounts, asOf, spec.buckets);
      data.categories = a.labels.map((l) => (l === "Not due" ? l : `${l} days`));
      data.series = [{ ...mk(amounts ? 1 : 0, Float64Array.from(a.values), "column"), name: amounts ? (block.names[1] ?? "Amount") : "Items", color: 0 }];
      if (!amounts) data.yFmt = "#,##0";
      else data.yFmt = spec.numFmt || (src.getStyle?.(spec.range.top + (spec.names ? 1 : 0), spec.range.left + 1)?.numFmt ?? "");
      notes.push(`Aged at ${formatValue(asOf, "d mmm yyyy").text}.`);
      break;
    }
  }
  return data;
}

/** The limit, read from its cell if it's a reference. */
export function makeResolver(read: (sheetId: string, row: number, col: number) => CellValue): (l: Limit) => number | null {
  return (l) => {
    if (l === null) return null;
    if (!isLink(l)) return l;
    const v = read(l.sheetId, l.row, l.col);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
}
