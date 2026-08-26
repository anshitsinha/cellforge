/**
 * Duplicate tests: rows whose key columns match exactly, or nearly (numbers
 * within a tolerance, dates within some days, text that reads the same or
 * is spelled almost the same). Several key columns must all match.
 *
 * Exact parts of the key are hashed into buckets first; near matches are
 * only looked for inside a bucket, by sorting (numbers, dates) or by
 * blocking on word prefixes (text), so 100k rows don't mean 5 billion
 * comparisons. Near matches chain: if A is near B and B near C, all three
 * are one group.
 */
import type { DateOrder } from "../clean/values";
import { cellDate, cellNumber, type Cell } from "./values";

export type DupMatch = "exact" | "number" | "date" | "text";

export interface DupKey {
  values: Cell[];
  /** exact (default): same value; number / date: within `tolerance`; text: same once case, spaces and punctuation are ignored, or as similar as `similarity`. */
  match?: DupMatch;
  /** number: largest difference allowed; date: days apart allowed. */
  tolerance?: number;
  /** text: Jaro-Winkler similarity needed, 0 to 1 (1, the default, means the same after normalising). */
  similarity?: number;
  dateOrder?: DateOrder;
}

export interface DupGroup {
  /** Row indexes into the key arrays, in order. */
  rows: number[];
  /** The first row's key values, for showing. */
  key: string;
}

export interface DupResult {
  groups: DupGroup[];
  /** Rows that are in some group. */
  flagged: number;
  /** Rows left out because a key value was blank (or not a number / date). */
  blanks: number;
  /** Pairs compared for near matches. */
  comparisons: number;
}

export interface DupOptions {
  /** Text blocks up to this size compare every pair; bigger ones compare sorted neighbours. */
  maxBlock?: number;
  /** Neighbours compared in a big block or a crowded tolerance window. */
  window?: number;
}

/** Lower case, accents and punctuation gone, single spaces. */
export function normaliseText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

let bufA = new Uint8Array(64);
let bufB = new Uint8Array(64);

/**
 * Jaro-Winkler similarity, 0 (nothing alike) to 1 (the same). With `atLeast`,
 * pairs whose lengths alone rule that out return 0 without comparing.
 */
export function jaroWinkler(a: string, b: string, atLeast = 0): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  if (atLeast > 0) {
    const short = Math.min(la, lb);
    const best = (short / la + short / lb + 1) / 3;
    if (best + 0.4 * (1 - best) < atLeast) return 0;
  }
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  if (bufA.length < la) bufA = new Uint8Array(la * 2);
  if (bufB.length < lb) bufB = new Uint8Array(lb * 2);
  const ma = bufA.fill(0, 0, la);
  const mb = bufB.fill(0, 0, lb);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (!mb[j] && a.charCodeAt(i) === b.charCodeAt(j)) {
        ma[i] = mb[j] = 1;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0;
  for (let i = 0, j = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[j]) j++;
    if (a.charCodeAt(i) !== b.charCodeAt(j)) t++;
    j++;
  }
  const m = matches;
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < la && prefix < lb && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

class UnionFind {
  readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    const p = this.parent;
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

interface NearKey {
  kind: "number" | "text";
  nums: Float64Array;
  texts: string[];
  tol: number;
  sim: number;
  /** Letter counts per row (a-z, 0-9, space), for a cheap upper bound before Jaro-Winkler. */
  hist: Uint8Array;
}

const BINS = 37;
const bin = (c: number) => (c >= 97 && c <= 122 ? c - 97 : c >= 48 && c <= 57 ? c - 22 : 36);

/** Whether two rows' text can reach the similarity, and if so whether it does. */
function textSimilar(k: NearKey, a: number, b: number): boolean {
  const ta = k.texts[a];
  const tb = k.texts[b];
  if (ta === tb) return true;
  // matching characters can't exceed the shared letter counts
  let m = 0;
  const h = k.hist;
  for (let i = 0, oa = a * BINS, ob = b * BINS; i < BINS; i++) m += Math.min(h[oa + i], h[ob + i]);
  const best = (m / ta.length + m / tb.length + 1) / 3;
  if (ta.length < 256 && tb.length < 256 && best + 0.4 * (1 - best) < k.sim) return false;
  return jaroWinkler(ta, tb, k.sim) >= k.sim;
}

const blank = (v: Cell | undefined) => v === null || v === undefined || (typeof v === "string" && !v.trim());

export function findDuplicates(keys: DupKey[], opts: DupOptions = {}): DupResult {
  const maxBlock = opts.maxBlock ?? 40;
  const window = opts.window ?? 20;
  const n = keys.reduce((m, k) => Math.max(m, k.values.length), 0);
  const hashed: string[] = new Array(n).fill("");
  const ok = new Uint8Array(n).fill(1);
  const near: NearKey[] = [];

  for (const k of keys) {
    const match = k.match ?? "exact";
    const tol = Math.max(0, k.tolerance ?? 0);
    const sim = Math.min(1, Math.max(0, k.similarity ?? 1));
    const isNear = ((match === "number" || match === "date") && tol > 0) || (match === "text" && sim < 1);
    const nk: NearKey | null = isNear
      ? { kind: match === "text" ? "text" : "number", nums: new Float64Array(match === "text" ? 0 : n), texts: [], tol, sim, hist: new Uint8Array(match === "text" ? n * BINS : 0) }
      : null;
    if (nk) near.push(nk);
    for (let r = 0; r < n; r++) {
      if (!ok[r]) continue;
      const v = k.values[r];
      if (blank(v)) {
        ok[r] = 0;
        continue;
      }
      let part: string;
      if (match === "exact") part = typeof v === "number" ? "n" + v : "s" + String(v).trim();
      else if (match === "number" || match === "date") {
        const x = match === "number" ? cellNumber(v) : cellDate(v, k.dateOrder);
        if (x === null) {
          ok[r] = 0;
          continue;
        }
        const val = match === "date" ? Math.floor(x) : x;
        if (nk) {
          nk.nums[r] = val;
          continue;
        }
        part = "n" + val;
      } else {
        const t = normaliseText(String(v));
        if (!t) {
          ok[r] = 0;
          continue;
        }
        if (nk) {
          nk.texts[r] = t;
          const o = r * BINS;
          for (let i = 0; i < t.length; i++) {
            const j = o + bin(t.charCodeAt(i));
            if (nk.hist[j] < 255) nk.hist[j]++;
          }
          continue;
        }
        part = "t" + t;
      }
      hashed[r] += part + "\u0001";
    }
  }

  // buckets of rows whose exact parts agree
  const buckets = new Map<string, number[]>();
  let blanks = 0;
  for (let r = 0; r < n; r++) {
    if (!ok[r]) {
      blanks++;
      continue;
    }
    const b = buckets.get(hashed[r]);
    if (b) b.push(r);
    else buckets.set(hashed[r], [r]);
  }

  const uf = new UnionFind(n);
  let comparisons = 0;
  const pairMatches = (a: number, b: number, skip: NearKey | null): boolean => {
    for (const k of near) {
      if (k === skip) continue;
      if (k.kind === "number") {
        if (Math.abs(k.nums[a] - k.nums[b]) > k.tol + 1e-9) return false;
      } else if (!textSimilar(k, a, b)) return false;
    }
    return true;
  };
  const tryPair = (a: number, b: number, skip: NearKey | null) => {
    if (uf.find(a) === uf.find(b)) return;
    comparisons++;
    if (pairMatches(a, b, skip)) uf.union(a, b);
  };

  for (const rows of buckets.values()) {
    if (rows.length < 2) continue;
    if (!near.length) {
      for (const r of rows) uf.union(rows[0], r);
      continue;
    }
    const primary = near.find((k) => k.kind === "number") ?? near[0];
    if (primary.kind === "number") {
      const v = primary.nums;
      const sorted = [...rows].sort((a, b) => v[a] - v[b] || a - b);
      const only = near.length === 1;
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        for (let j = i + 1; j < sorted.length && v[sorted[j]] - v[a] <= primary.tol + 1e-9; j++) {
          // one near key: neighbours in sorted order are enough to chain the group
          if (only) {
            uf.union(a, sorted[j]);
            break;
          }
          if (j - i > window) break;
          tryPair(a, sorted[j], primary);
        }
      }
    } else {
      // text: block on the first three letters of each word
      const t = primary.texts;
      const blocks = new Map<string, { rows: number[]; at: number[] }>();
      for (const r of rows) {
        const s = t[r];
        const seen = new Set<string>();
        for (let at = 0; at < s.length; ) {
          let end = s.indexOf(" ", at);
          if (end < 0) end = s.length;
          if (end - at >= 2 || (at === 0 && end === s.length)) {
            const key = s.slice(at, at + 3);
            if (!seen.has(key)) {
              seen.add(key);
              const b = blocks.get(key);
              if (b) {
                b.rows.push(r);
                b.at.push(at);
              } else blocks.set(key, { rows: [r], at: [at] });
            }
          }
          at = end + 1;
        }
      }
      const check = (a: number, b: number) => {
        if (uf.find(a) === uf.find(b)) return;
        comparisons++;
        if (textSimilar(primary, a, b) && pairMatches(a, b, primary)) uf.union(a, b);
      };
      for (const block of blocks.values()) {
        const m = block.rows.length;
        if (m < 2) continue;
        if (m <= maxBlock) {
          for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) check(block.rows[i], block.rows[j]);
        } else {
          // sorted neighbourhood, sorting on the text from the word that made the block
          const keyOf = block.rows.map((r, i) => {
            const s = t[r];
            const at = block.at[i];
            return at ? s.slice(at) + " " + s.slice(0, at) : s;
          });
          const order = block.rows.map((_, i) => i).sort((x, y) => (keyOf[x] < keyOf[y] ? -1 : keyOf[x] > keyOf[y] ? 1 : x - y));
          for (let i = 0; i < m; i++) for (let j = i + 1; j <= i + window && j < m; j++) check(block.rows[order[i]], block.rows[order[j]]);
        }
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let r = 0; r < n; r++) {
    if (!ok[r]) continue;
    const root = uf.find(r);
    const g = byRoot.get(root);
    if (g) g.push(r);
    else byRoot.set(root, [r]);
  }
  const groups: DupGroup[] = [];
  let flagged = 0;
  for (const rows of byRoot.values()) {
    if (rows.length < 2) continue;
    flagged += rows.length;
    groups.push({ rows, key: keys.map((k) => String(k.values[rows[0]] ?? "").trim()).join(" | ") });
  }
  groups.sort((a, b) => a.rows[0] - b.rows[0]);
  return { groups, flagged, blanks, comparisons };
}
