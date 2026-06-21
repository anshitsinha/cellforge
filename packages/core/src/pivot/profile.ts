/**
 * Column profiles: what's in a column at a glance. Counts, blanks, distinct
 * values, the most common values, number statistics, text lengths, date
 * range, a histogram and the shapes text values take ("AAA-9999").
 *
 * Built for big columns: one or two passes over the typed array. Distinct
 * numbers are counted exactly up to a cap and estimated with HyperLogLog
 * beyond it; the median is exact up to a few million values and taken from
 * an even sample beyond that. Text columns are profiled through their
 * dictionary, so the work per row is a single counter increment.
 */
import type { ColumnData } from "../columns";
import { parseNumber } from "../columns";
import { parseDateLoose, type DateOrder } from "../clean/values";
import { niceStep } from "../audit/strata";
import { HyperLogLog } from "./hll";
import { medianOf } from "./engine";

export type ProfileType = "number" | "date" | "text" | "empty";

export interface ProfileValue {
  value: string | number;
  count: number;
}

export interface ProfilePattern {
  pattern: string;
  count: number;
  example: string;
}

export interface DataProfile {
  name: string;
  type: ProfileType;
  /** rows in all */
  count: number;
  blanks: number;
  /** non-blank values */
  filled: number;
  distinct: number;
  /** false when `distinct` is a HyperLogLog estimate */
  distinctExact: boolean;
  /** most common values, most frequent first */
  top: ProfileValue[];
  /** false when the top values come from a sample */
  topExact: boolean;
  numbers?: {
    min: number;
    max: number;
    sum: number;
    mean: number;
    median: number;
    /** false when the median comes from a sample */
    medianExact: boolean;
    /** sample standard deviation, NaN below two values */
    stdev: number;
    zeros: number;
    negatives: number;
    /** whole numbers */
    wholes: number;
  };
  /** first and last date (as date serials) for date columns, numeric or text */
  dates?: { min: number; max: number };
  text?: {
    minLength: number;
    maxLength: number;
    meanLength: number;
    /** values that read as numbers / dates */
    numeric: number;
    dateLike: number;
  };
  /** numbers and dates: bin i covers [edges[i], edges[i+1]), the last includes its top edge */
  histogram?: { edges: number[]; counts: number[] };
  patterns?: ProfilePattern[];
}

export interface ProfileOptions {
  /** the numbers are date serials */
  date?: boolean;
  /** count distinct numbers exactly up to this many (default 100,000) */
  distinctCap?: number;
  /** how many top values / patterns (default 10) */
  top?: number;
  /** about this many histogram bins (default 20) */
  bins?: number;
  /** exact median up to this many numbers (default 4,000,000) */
  exactLimit?: number;
  dateOrder?: DateOrder;
}

const isLetter = (c: number, ch: string) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c > 127 && ch.toLowerCase() !== ch.toUpperCase());

/** The shape of a text: letters become A, digits 9, spaces stay, other characters are kept. */
export function textPattern(s: string, max = 24): string {
  let out = "";
  const len = Math.min(s.length, max);
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (c >= 48 && c <= 57) out += "9";
    else if (isLetter(c, ch)) out += "A";
    else if (ch === " " || ch === "\t") out += " ";
    else out += ch;
  }
  return s.length > max ? out + "…" : out;
}

/** Bin edges at round numbers, about `bins` of them, covering min..max. */
export function histogramBins(values: Float64Array, min: number, max: number, bins: number, whole = false): { edges: number[]; counts: number[] } {
  if (!(max >= min)) return { edges: [], counts: [] };
  let width = niceStep((max - min) / Math.max(1, bins));
  if (whole) width = Math.max(1, Math.round(width));
  if (max === min) width = 1;
  const start = Math.floor(min / width) * width;
  // a max sitting exactly on an upper edge goes in the last bin
  const k = Math.max(1, Math.ceil((max - start) / width));
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== v) continue;
    counts[Math.min(k - 1, Math.floor((v - start) / width))]++;
  }
  const edges = Array.from({ length: k + 1 }, (_, i) => +(start + i * width).toPrecision(12));
  return { edges, counts };
}

/** Keep the `k` largest by count. */
function topOf<T>(items: Iterable<[T, number]>, k: number): [T, number][] {
  const best: [T, number][] = [];
  for (const it of items) {
    if (best.length === k && it[1] <= best[k - 1][1]) continue;
    let at = best.length;
    while (at > 0 && best[at - 1][1] < it[1]) at--;
    best.splice(at, 0, it);
    if (best.length > k) best.pop();
  }
  return best;
}

/** Profile one column. */
export function profile(column: ColumnData, opts: ProfileOptions = {}): DataProfile {
  return column.kind === "number" ? profileNumbers(column.name, column.values, opts) : profileText(column.name, column.codes, column.dict, opts);
}

function profileNumbers(name: string, values: Float64Array, opts: ProfileOptions): DataProfile {
  const n = values.length;
  const cap = opts.distinctCap ?? 100_000;
  const K = opts.top ?? 10;
  const exactLimit = opts.exactLimit ?? 4_000_000;
  let filled = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let zeros = 0;
  let negatives = 0;
  let wholes = 0;
  let counts: Map<number, number> | null = new Map();
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v !== v) continue;
    filled++;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v === 0) zeros++;
    else if (v < 0) negatives++;
    if (v === Math.floor(v)) wholes++;
    if (counts) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
      if (counts.size > cap) counts = null;
    }
  }
  const base: DataProfile = { name, type: filled ? (opts.date ? "date" : "number") : "empty", count: n, blanks: n - filled, filled, distinct: 0, distinctExact: true, top: [], topExact: true };
  if (!filled) return base;

  const mean = sum / filled;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === v) sq += (v - mean) * (v - mean);
  }

  // sorted values (all, or an even sample) for the median and, past the cap, top values
  const sampled = filled > exactLimit;
  const step = sampled ? filled / exactLimit : 1;
  const sample = new Float64Array(sampled ? exactLimit : filled);
  {
    let seen = 0;
    let next = 0;
    let k = 0;
    for (let i = 0; i < n && k < sample.length; i++) {
      const v = values[i];
      if (v !== v) continue;
      if (seen >= next) {
        sample[k++] = v;
        next += step;
      }
      seen++;
    }
  }
  const median = medianOf(sample.slice(), sample.length);

  let distinct: number;
  let top: [number, number][];
  if (counts) {
    distinct = counts.size;
    top = topOf(counts, K);
  } else {
    const hll = new HyperLogLog();
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === v) hll.addNumber(v);
    }
    distinct = Math.max(cap + 1, hll.estimate());
    sample.sort();
    const runs: [number, number][] = [];
    for (let i = 0; i < sample.length; ) {
      let j = i + 1;
      while (j < sample.length && sample[j] === sample[i]) j++;
      // a value seen once in a sample says nothing about repeats
      if (j - i > 1 || !sampled) runs.push([sample[i], Math.round((j - i) * step)]);
      i = j;
    }
    top = topOf(runs, K);
  }
  // only values that repeat are worth listing for a mostly-unique column
  const shownTop = top.filter(([, c], i) => c > 1 || i < 3 || distinct <= K);
  return {
    ...base,
    distinct,
    distinctExact: !!counts,
    top: shownTop.map(([value, count]) => ({ value, count })),
    topExact: !!counts || !sampled,
    numbers: {
      min,
      max,
      sum,
      mean,
      median,
      medianExact: !sampled,
      stdev: filled > 1 ? Math.sqrt(sq / (filled - 1)) : NaN,
      zeros,
      negatives,
      wholes,
    },
    ...(opts.date ? { dates: { min, max } } : {}),
    histogram: histogramBins(values, opts.date ? Math.floor(min) : min, max, opts.bins ?? 20, !!opts.date || wholes === filled),
  };
}

// dictionaries bigger than this are profiled (patterns, lengths) from an even sample of entries
const DICT_SAMPLE = 200_000;

function profileText(name: string, codes: Uint32Array, dict: string[], opts: ProfileOptions): DataProfile {
  const n = codes.length;
  const K = opts.top ?? 10;
  const order = opts.dateOrder ?? "dmy";
  const counts = new Float64Array(dict.length + 1);
  for (let i = 0; i < n; i++) counts[codes[i]]++;
  const blanks = counts[0];
  const filled = n - blanks;
  const base: DataProfile = { name, type: filled ? "text" : "empty", count: n, blanks, filled, distinct: 0, distinctExact: true, top: [], topExact: true };
  if (!filled) return base;

  let distinct = 0;
  let minLength = Infinity;
  let maxLength = 0;
  let lengthSum = 0;
  for (let c = 1; c <= dict.length; c++) {
    const k = counts[c];
    if (!k) continue;
    distinct++;
    const len = dict[c - 1].length;
    if (len < minLength) minLength = len;
    if (len > maxLength) maxLength = len;
    lengthSum += len * k;
  }

  const top = topOf(
    (function* () {
      for (let c = 1; c <= dict.length; c++) if (counts[c]) yield [dict[c - 1], counts[c]] as [string, number];
    })(),
    K,
  );

  // patterns, numbers and dates in text: every used entry, or an even sample of them
  const step = Math.max(1, Math.floor(distinct / DICT_SAMPLE));
  const patterns = new Map<string, ProfilePattern>();
  let numeric = 0;
  let dateLike = 0;
  let checked = 0;
  let dMin = Infinity;
  let dMax = -Infinity;
  let used = 0;
  for (let c = 1; c <= dict.length; c++) {
    const k = counts[c];
    if (!k) continue;
    if (used++ % step) continue;
    const s = dict[c - 1];
    checked += k;
    const pat = textPattern(s);
    const p = patterns.get(pat);
    if (p) p.count += k;
    else patterns.set(pat, { pattern: pat, count: k, example: s });
    if (parseNumber(s) !== null) numeric += k;
    else {
      const d = parseDateLoose(s, order);
      if (d !== null) {
        dateLike += k;
        if (d < dMin) dMin = d;
        if (d > dMax) dMax = d;
      }
    }
  }
  const scale = filled / checked;
  const pats = topOf(
    (function* () {
      for (const p of patterns.values()) yield [p, p.count] as [ProfilePattern, number];
    })(),
    K,
  ).map(([p]) => ({ ...p, count: Math.round(p.count * scale) }));
  const isDates = dateLike * scale >= 0.9 * filled;
  const shownTop = top.filter(([, c], i) => c > 1 || i < 3 || distinct <= K);
  return {
    ...base,
    type: isDates ? "date" : "text",
    distinct,
    top: shownTop.map(([value, count]) => ({ value, count })),
    text: { minLength, maxLength, meanLength: lengthSum / filled, numeric: Math.round(numeric * scale), dateLike: Math.round(dateLike * scale) },
    ...(dateLike ? { dates: { min: dMin, max: dMax } } : {}),
    patterns: pats,
  };
}
