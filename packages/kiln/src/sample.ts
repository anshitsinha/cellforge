/**
 * Token sampling: greedy, temperature, top-k, top-p, with an optional
 * allow-mask (from the grammar) and a seeded RNG for reproducible runs.
 */

export interface SampleOptions {
  /** <= 0 (default) means greedy */
  temperature?: number;
  /** keep only the k most likely tokens (0 = off) */
  topK?: number;
  /** keep the smallest set of tokens whose probability reaches p (1 = off) */
  topP?: number;
  /** penalise tokens already in `recent` (1 = off) */
  repeatPenalty?: number;
}

/** mulberry32: small, fast, seedable */
export function makeRng(seed = 0x2f6b1c3d): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick a token. `mask[i] === 0` forbids token i. Returns -1 when the mask
 * allows nothing.
 */
export function sample(
  logits: Float32Array,
  opts: SampleOptions = {},
  rng: () => number = Math.random,
  mask?: Uint8Array | null,
  recent?: readonly number[],
): number {
  let work = logits;
  if (recent && opts.repeatPenalty && opts.repeatPenalty !== 1) {
    work = new Float32Array(logits);
    for (const id of new Set(recent)) {
      const v = work[id]!;
      work[id] = v > 0 ? v / opts.repeatPenalty : v * opts.repeatPenalty;
    }
  }
  const allowed = (i: number) => !mask || mask[i] !== 0;
  const temp = opts.temperature ?? 0;
  if (temp <= 0) {
    let best = -1;
    let bv = -Infinity;
    for (let i = 0; i < work.length; i++) {
      if (allowed(i) && (work[i]! > bv || best < 0)) {
        best = i;
        bv = work[i]!;
      }
    }
    return best;
  }
  const cand: number[] = [];
  for (let i = 0; i < work.length; i++) if (allowed(i) && work[i]! > -Infinity) cand.push(i);
  if (cand.length === 0) {
    // everything allowed is -inf: fall back to the first allowed token
    for (let i = 0; i < work.length; i++) if (allowed(i)) return i;
    return -1;
  }
  cand.sort((a, b) => work[b]! - work[a]!);
  let n = cand.length;
  if (opts.topK && opts.topK > 0) n = Math.min(n, opts.topK);
  const max = work[cand[0]!]!;
  const probs = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    probs[i] = Math.exp((work[cand[i]!]! - max) / temp);
    sum += probs[i]!;
  }
  const topP = opts.topP ?? 1;
  if (topP < 1) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += probs[i]! / sum;
      if (acc >= topP) {
        n = i + 1;
        break;
      }
    }
    sum = 0;
    for (let i = 0; i < n; i++) sum += probs[i]!;
  }
  let r = rng() * sum;
  for (let i = 0; i < n; i++) {
    r -= probs[i]!;
    if (r <= 0) return cand[i]!;
  }
  return cand[n - 1]!;
}
