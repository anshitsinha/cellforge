/**
 * Audit sampling: random, systematic (random start), stratified and
 * monetary-unit (MUS). Every method takes a seed and records it, so the
 * same seed on the same data picks the same items again.
 */
import { cellNumber, mulberry32, newSeed, type Cell } from "./values";

export type SampleMethod = "random" | "systematic" | "stratified" | "mus";

export interface SampleItem {
  /** Row index into the input. */
  row: number;
  /** Why it was picked: "random", "systematic", "stratum 2", "sure-take", "interval". */
  reason: string;
  /** MUS: the monetary unit (running total) that hit this item. */
  hit?: number;
}

export interface SampleResult {
  method: SampleMethod;
  seed: number;
  /** Picked items in row order. */
  items: SampleItem[];
  /** Population size the sample came from. */
  population: number;
  /** Systematic and MUS: the interval and the random start. */
  interval?: number;
  start?: number;
  /** Stratified: population and sample size per stratum. */
  strata?: { stratum: number; population: number; sample: number }[];
  /** MUS: book value sampled (positive amounts), how much of it is sure-take, and rows left out (zero, negative, not a number). */
  bookValue?: number;
  sureTakeValue?: number;
  excluded?: number;
}

/** `k` distinct picks from 0..n-1 (partial Fisher-Yates), sorted. */
function pick(n: number, k: number, rnd: () => number): number[] {
  k = Math.max(0, Math.min(n, Math.floor(k)));
  const swaps = new Map<number, number>();
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    const vj = swaps.get(j) ?? j;
    swaps.set(j, swaps.get(i) ?? i);
    out.push(vj);
  }
  return out.sort((a, b) => a - b);
}

/** A simple random sample of `size` of the rows 0..count-1. */
export function randomSample(count: number, size: number, seed = newSeed()): SampleResult {
  const rnd = mulberry32(seed);
  return { method: "random", seed, population: count, items: pick(count, size, rnd).map((row) => ({ row, reason: "random" })) };
}

/** Every (count / size)th row from a random start. */
export function systematicSample(count: number, size: number, seed = newSeed()): SampleResult {
  const rnd = mulberry32(seed);
  size = Math.max(0, Math.min(count, Math.floor(size)));
  if (!size) return { method: "systematic", seed, population: count, items: [], interval: 0, start: 0 };
  const interval = count / size;
  const start = rnd() * interval;
  const items: SampleItem[] = [];
  for (let k = 0; k < size; k++) {
    const row = Math.min(count - 1, Math.floor(start + k * interval));
    items.push({ row, reason: "systematic" });
  }
  return { method: "systematic", seed, population: count, items, interval, start: Math.floor(start) };
}

/** Split a total sample over strata in proportion to their size (largest remainder), at least one from each non-empty stratum where possible. */
export function allocate(sizes: number[], total: number): number[] {
  const pop = sizes.reduce((a, b) => a + b, 0);
  total = Math.max(0, Math.min(pop, Math.floor(total)));
  if (!pop || !total) return sizes.map(() => 0);
  const raw = sizes.map((s) => (s / pop) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((_, i) => i).sort((a, b) => raw[b] - Math.floor(raw[b]) - (raw[a] - Math.floor(raw[a])) || sizes[b] - sizes[a]);
  for (const i of order) {
    if (!left) break;
    if (out[i] < sizes[i]) {
      out[i]++;
      left--;
    }
  }
  // give empty-handed strata one item, taken from the biggest allocation
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i] && !out[i]) {
      let big = -1;
      for (let j = 0; j < out.length; j++) if (out[j] > 1 && (big < 0 || out[j] > out[big])) big = j;
      if (big < 0) break;
      out[big]--;
      out[i]++;
    }
  }
  return out;
}

/**
 * A random sample within each stratum. `rowStratum` gives each row's
 * stratum (-1 leaves it out). `size` is a total split in proportion, or
 * a number per stratum.
 */
export function stratifiedSample(rowStratum: ArrayLike<number>, size: number | number[], seed = newSeed()): SampleResult {
  const members: number[][] = [];
  for (let r = 0; r < rowStratum.length; r++) {
    const s = rowStratum[r];
    if (s < 0) continue;
    while (members.length <= s) members.push([]);
    members[s].push(r);
  }
  const sizes = members.map((m) => m.length);
  const want = Array.isArray(size) ? sizes.map((s, i) => Math.max(0, Math.min(s, Math.floor(size[i] ?? 0)))) : allocate(sizes, size);
  const rnd = mulberry32(seed);
  const items: SampleItem[] = [];
  members.forEach((m, s) => {
    for (const i of pick(m.length, want[s], rnd)) items.push({ row: m[i], reason: `stratum ${s + 1}` });
  });
  items.sort((a, b) => a.row - b.row);
  return {
    method: "stratified",
    seed,
    population: sizes.reduce((a, b) => a + b, 0),
    items,
    strata: sizes.map((p, s) => ({ stratum: s, population: p, sample: want[s] })),
  };
}

/**
 * Monetary-unit sampling: each currency unit has the same chance, so big
 * items are more likely to be picked. Items at or above the interval are
 * always picked (sure-take); the rest are walked through in row order with
 * a hit every `interval` units from a random start. Give the interval, or
 * a sample size (interval = book value / size).
 */
export function musSample(amounts: Cell[], opts: { interval?: number; size?: number; seed?: number }): SampleResult {
  const seed = opts.seed ?? newSeed();
  const vals = amounts.map((v) => cellNumber(v));
  let book = 0;
  let excluded = 0;
  for (const x of vals) {
    if (x !== null && x > 0) book += x;
    else excluded++;
  }
  const interval = opts.interval && opts.interval > 0 ? opts.interval : opts.size && opts.size > 0 ? book / opts.size : 0;
  const population = amounts.length - excluded;
  if (!(interval > 0) || !book) return { method: "mus", seed, population, items: [], interval, start: 0, bookValue: book, sureTakeValue: 0, excluded };
  const rnd = mulberry32(seed);
  const start = rnd() * interval;
  const items: SampleItem[] = [];
  let sure = 0;
  let cum = 0;
  let next = start;
  vals.forEach((x, row) => {
    if (x === null || x <= 0) return;
    if (x >= interval) {
      sure += x;
      items.push({ row, reason: "sure-take" });
      return;
    }
    const end = cum + x;
    if (next < end) {
      items.push({ row, reason: "interval", hit: next });
      while (next < end) next += interval;
    }
    cum = end;
  });
  return { method: "mus", seed, population, items, interval, start, bookValue: book, sureTakeValue: sure, excluded };
}
