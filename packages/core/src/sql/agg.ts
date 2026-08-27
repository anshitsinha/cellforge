/**
 * Hash aggregation kernels: one pass over the rows with each row's group id,
 * accumulating into typed arrays indexed by group. NULLs are skipped (COUNT(*)
 * counts rows); a group with no values gives NULL (COUNT gives 0).
 */
import { dictRanks, gather, KeySpace, maskOf, NumMap, toNum, vecIsDate, type Vec } from "./vec";

export const AGGREGATES = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX", "MEDIAN", "STDDEV", "STDDEV_SAMP", "STDEV", "STDDEV_POP", "VARIANCE", "VAR_SAMP", "VAR", "VAR_POP", "STRING_AGG", "LISTAGG", "GROUP_CONCAT", "ANY_VALUE", "FIRST"]);
export const WINDOW_ONLY = new Set(["ROW_NUMBER", "RANK", "DENSE_RANK", "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "NTILE"]);

const numFmt = (a: Vec): string | undefined => (a.t === "num" ? a.fmt : undefined);
const withFmt = (v: Float64Array, fmt: string | undefined): Vec => ({ t: "num", v, ...(fmt ? { fmt } : {}) });

export interface AggCall {
  name: string;
  /** null for COUNT(*) */
  arg: Vec | null;
  distinct: boolean;
  /** STRING_AGG separator */
  sep?: string;
}

/**
 * Aggregate over n rows with group ids gid (-1 = row not in any group).
 * `first` is each group's first row (for ANY_VALUE).
 */
export function aggregate(call: AggCall, gid: Int32Array, ng: number, n: number, first: Int32Array): Vec {
  const name = call.name;
  if (call.arg === null) {
    const cnt = new Float64Array(ng);
    for (let i = 0; i < n; i++) {
      const g = gid[i];
      if (g >= 0) cnt[g]++;
    }
    return { t: "num", v: cnt };
  }
  let arg = call.arg;
  if (name === "ANY_VALUE" || name === "FIRST") return gather(arg, first);
  if (name === "COUNT") {
    if (call.distinct) return countDistinct(arg, gid, ng, n);
    const cnt = new Float64Array(ng);
    const isNull = nullTest(arg);
    for (let i = 0; i < n; i++) {
      const g = gid[i];
      if (g >= 0 && !isNull(i)) cnt[g]++;
    }
    return { t: "num", v: cnt };
  }
  if (name === "STRING_AGG" || name === "LISTAGG" || name === "GROUP_CONCAT") return stringAgg(arg, gid, ng, n, call.sep ?? ",", call.distinct);
  if ((name === "MIN" || name === "MAX") && arg.t === "str") return minMaxStr(arg, gid, ng, n, name === "MAX");
  if (arg.t === "bool" || arg.t === "null") arg = toNum(arg);
  if (arg.t !== "num") arg = toNum(arg);
  const fmt = numFmt(arg);
  if (call.distinct && (name === "SUM" || name === "AVG")) arg = distinctPerGroup(arg, gid, ng, n);
  const v = arg.v;
  const m = maskOf(arg);
  switch (name) {
    case "SUM":
    case "AVG": {
      const s = new Float64Array(ng);
      const c = new Float64Array(ng);
      const cnt = new Float64Array(ng);
      for (let i = 0; i < n; i++) {
        const g = gid[i];
        if (g < 0) continue;
        const x = v[i & m];
        if (x !== x) continue;
        // Neumaier summation: cents add up exactly over millions of rows
        const sg = s[g];
        const t = sg + x;
        c[g] += Math.abs(sg) >= Math.abs(x) ? sg - t + x : x - t + sg;
        s[g] = t;
        cnt[g]++;
      }
      for (let g = 0; g < ng; g++) s[g] = cnt[g] ? (name === "AVG" ? (s[g] + c[g]) / cnt[g] : s[g] + c[g]) : NaN;
      return withFmt(s, fmt);
    }
    case "MIN":
    case "MAX": {
      const out = new Float64Array(ng).fill(NaN);
      const max = name === "MAX";
      for (let i = 0; i < n; i++) {
        const g = gid[i];
        if (g < 0) continue;
        const x = v[i & m];
        if (x !== x) continue;
        const o = out[g];
        if (o !== o || (max ? x > o : x < o)) out[g] = x;
      }
      return withFmt(out, fmt);
    }
    case "MEDIAN":
      return withFmt(median(v, m, gid, ng, n), fmt);
    default: {
      // variance family: two passes (mean, then squared deviations)
      const pop = name === "STDDEV_POP" || name === "VAR_POP";
      const sd = name.startsWith("STD");
      const s = new Float64Array(ng);
      const cnt = new Float64Array(ng);
      for (let i = 0; i < n; i++) {
        const g = gid[i];
        if (g < 0) continue;
        const x = v[i & m];
        if (x !== x) continue;
        s[g] += x;
        cnt[g]++;
      }
      const mean = s.map((x, g) => x / cnt[g]);
      const ss = new Float64Array(ng);
      for (let i = 0; i < n; i++) {
        const g = gid[i];
        if (g < 0) continue;
        const x = v[i & m];
        if (x !== x) continue;
        const d = x - mean[g];
        ss[g] += d * d;
      }
      const out = new Float64Array(ng);
      for (let g = 0; g < ng; g++) {
        const k = pop ? cnt[g] : cnt[g] - 1;
        out[g] = k > 0 ? (sd ? Math.sqrt(ss[g] / k) : ss[g] / k) : NaN;
      }
      return withFmt(out, sd && !vecIsDate(arg) ? fmt : undefined);
    }
  }
}

function nullTest(a: Vec): (i: number) => boolean {
  const m = maskOf(a);
  switch (a.t) {
    case "null":
      return () => true;
    case "num":
      return (i) => a.v[i & m] !== a.v[i & m];
    case "bool":
      return (i) => a.v[i & m] === 2;
    case "str":
      return (i) => a.c[i & m] === 0;
  }
}

function median(v: Float64Array, m: number, gid: Int32Array, ng: number, n: number): Float64Array {
  const cnt = new Int32Array(ng + 1);
  for (let i = 0; i < n; i++) {
    const g = gid[i];
    if (g >= 0 && v[i & m] === v[i & m]) cnt[g + 1]++;
  }
  for (let g = 0; g < ng; g++) cnt[g + 1] += cnt[g];
  const pos = cnt.slice(0, ng);
  const vals = new Float64Array(cnt[ng]);
  for (let i = 0; i < n; i++) {
    const g = gid[i];
    const x = v[i & m];
    if (g >= 0 && x === x) vals[pos[g]++] = x;
  }
  const out = new Float64Array(ng);
  for (let g = 0; g < ng; g++) {
    const part = vals.subarray(cnt[g], cnt[g + 1]);
    if (!part.length) {
      out[g] = NaN;
      continue;
    }
    part.sort();
    const h = part.length >> 1;
    out[g] = part.length & 1 ? part[h] : (part[h - 1] + part[h]) / 2;
  }
  return out;
}

/** COUNT(DISTINCT x) per group. */
function countDistinct(arg: Vec, gid: Int32Array, ng: number, n: number): Vec {
  const ks = new KeySpace();
  const ids = ks.ids(arg, n);
  const card = ks.next + 1;
  const out = new Float64Array(ng);
  const firstSeen = new NumMap(1024);
  for (let i = 0; i < n; i++) {
    const g = gid[i];
    const id = ids[i];
    if (g < 0 || id < 0) continue;
    const before = firstSeen.size;
    firstSeen.getOrAdd(g * card + id, 0);
    if (firstSeen.size !== before) out[g]++;
  }
  return { t: "num", v: out };
}

/** The arg with repeats inside each group blanked out (for SUM / AVG DISTINCT). */
function distinctPerGroup(arg: Extract<Vec, { t: "num" }>, gid: Int32Array, ng: number, n: number): Extract<Vec, { t: "num" }> {
  const ks = new KeySpace();
  const ids = ks.ids(arg, n);
  const card = ks.next + 1;
  const seen = new NumMap(1024);
  const m = maskOf(arg);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = gid[i];
    const id = ids[i];
    if (g < 0 || id < 0) {
      v[i] = NaN;
      continue;
    }
    const before = seen.size;
    seen.getOrAdd(g * card + id, 0);
    v[i] = seen.size !== before ? arg.v[i & m] : NaN;
  }
  void ng;
  return { t: "num", v, ...(arg.fmt ? { fmt: arg.fmt } : {}) };
}

function minMaxStr(arg: Extract<Vec, { t: "str" }>, gid: Int32Array, ng: number, n: number, max: boolean): Vec {
  const ranks = dictRanks(arg.d);
  const best = new Uint32Array(ng); // code, 0 = none
  const m = maskOf(arg);
  for (let i = 0; i < n; i++) {
    const g = gid[i];
    if (g < 0) continue;
    const c = arg.c[i & m];
    if (c === 0) continue;
    const b = best[g];
    if (b === 0 || (max ? ranks[c] > ranks[b] : ranks[c] < ranks[b])) best[g] = c;
  }
  return { t: "str", c: best, d: arg.d };
}

function stringAgg(arg: Vec, gid: Int32Array, ng: number, n: number, sep: string, distinct: boolean): Vec {
  const parts: string[][] = Array.from({ length: ng }, () => []);
  const seen = distinct ? Array.from({ length: ng }, () => new Set<string>()) : null;
  const m = maskOf(arg);
  const text = (i: number): string | null => {
    switch (arg.t) {
      case "str": {
        const c = arg.c[i & m];
        return c ? arg.d[c - 1] : null;
      }
      case "num": {
        const x = arg.v[i & m];
        return x === x ? String(x) : null;
      }
      case "bool": {
        const x = arg.v[i & m];
        return x === 2 ? null : x ? "TRUE" : "FALSE";
      }
      default:
        return null;
    }
  };
  for (let i = 0; i < n; i++) {
    const g = gid[i];
    if (g < 0) continue;
    const s = text(i);
    if (s === null) continue;
    if (seen) {
      if (seen[g].has(s)) continue;
      seen[g].add(s);
    }
    parts[g].push(s);
  }
  const d: string[] = [];
  const at = new Map<string, number>();
  const c = new Uint32Array(ng);
  for (let g = 0; g < ng; g++) {
    if (!parts[g].length) continue;
    const s = parts[g].join(sep);
    let code = at.get(s);
    if (code === undefined) at.set(s, (code = d.push(s)));
    c[g] = code;
  }
  return { t: "str", c, d };
}
