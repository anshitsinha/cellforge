/**
 * Column vectors the SQL executor works on, and the kernels over them.
 *
 * A Vec is one of:
 *   num  - Float64Array, NaN = NULL (dates are Excel serials, with a date format)
 *   str  - dictionary codes (0 = NULL, else dict[code - 1]), as in ColumnData
 *   bool - Uint8Array: 0 false, 1 true, 2 NULL (three-valued logic)
 *   null - an untyped NULL constant
 * A Vec of length 1 is a constant and broadcasts: kernels read element i as
 * a[i & mask] with mask 0 for constants and -1 for full vectors.
 */
import { radixSortIndices } from "../radix";
import { parseNumber } from "../columns";
import { isDateFormat, serialToParts } from "../numfmt";
import { isoToSerial } from "./parser";

export type Vec = { t: "num"; v: Float64Array; fmt?: string } | { t: "str"; c: Uint32Array; d: string[] } | { t: "bool"; v: Uint8Array } | { t: "null" };

export type Scalar = number | string | boolean | null;

export const NULL_VEC: Vec = { t: "null" };

export function vlen(a: Vec): number {
  return a.t === "num" || a.t === "bool" ? a.v.length : a.t === "str" ? a.c.length : 1;
}
export const maskOf = (a: Vec): number => (vlen(a) === 1 ? 0 : -1);
export const isConst = (a: Vec, n: number): boolean => vlen(a) === 1 && n !== 1;

export function constVec(v: Scalar, fmt?: string): Vec {
  if (v === null) return NULL_VEC;
  if (typeof v === "number") return Number.isNaN(v) ? NULL_VEC : { t: "num", v: Float64Array.of(v), ...(fmt ? { fmt } : {}) };
  if (typeof v === "boolean") return { t: "bool", v: Uint8Array.of(v ? 1 : 0) };
  return { t: "str", c: Uint32Array.of(1), d: [v] };
}

/** The value at row i (constants broadcast). */
export function valueAt(a: Vec, i: number): Scalar {
  switch (a.t) {
    case "null":
      return null;
    case "num": {
      const x = a.v[a.v.length === 1 ? 0 : i];
      return Number.isNaN(x) ? null : x;
    }
    case "bool": {
      const x = a.v[a.v.length === 1 ? 0 : i];
      return x === 2 ? null : x === 1;
    }
    case "str": {
      const c = a.c[a.c.length === 1 ? 0 : i];
      return c === 0 ? null : a.d[c - 1];
    }
  }
}

export const DATE_FMT = "yyyy-mm-dd";
const isDateFmt = (f: string | undefined): boolean => !!f && isDateFormat(f);
export const vecIsDate = (a: Vec): boolean => a.t === "num" && isDateFmt(a.fmt);

// --------------------------------------------------------------- strings --

/** The text order: case-insensitive first, then exact, so "apple" sorts with "Apple". */
export function cmpStr(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Interns strings into a dictionary. */
export class StrBuilder {
  readonly d: string[] = [];
  private at = new Map<string, number>();
  code(s: string | null): number {
    if (s === null) return 0;
    let c = this.at.get(s);
    if (c === undefined) {
      c = this.d.push(s);
      this.at.set(s, c);
    }
    return c;
  }
}

/** Make a dict without duplicates (codes remapped), so equal codes mean equal text. */
export function dedupeStr(c: Uint32Array, d: string[]): { c: Uint32Array; d: string[] } {
  if (new Set(d).size === d.length) return { c, d };
  const b = new StrBuilder();
  const remap = new Uint32Array(d.length + 1);
  for (let k = 0; k < d.length; k++) remap[k + 1] = b.code(d[k]);
  const out = new Uint32Array(c.length);
  for (let i = 0; i < c.length; i++) out[i] = remap[c[i]];
  return { c: out, d: b.d };
}

/** Apply a text -> value function over a str vec's dictionary (cheap: once per distinct value). */
export function mapDict(a: Extract<Vec, { t: "str" }>, f: (s: string) => Scalar, ret: "num" | "str" | "bool"): Vec {
  const n = a.c.length;
  if (ret === "num") {
    const table = new Float64Array(a.d.length + 1);
    table[0] = NaN;
    for (let k = 0; k < a.d.length; k++) {
      const r = f(a.d[k]);
      table[k + 1] = typeof r === "number" ? r : r === null ? NaN : Number(r);
    }
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = table[a.c[i]];
    return { t: "num", v };
  }
  if (ret === "bool") {
    const table = new Uint8Array(a.d.length + 1);
    table[0] = 2;
    for (let k = 0; k < a.d.length; k++) {
      const r = f(a.d[k]);
      table[k + 1] = r === null ? 2 : r ? 1 : 0;
    }
    const v = new Uint8Array(n);
    for (let i = 0; i < n; i++) v[i] = table[a.c[i]];
    return { t: "bool", v };
  }
  const b = new StrBuilder();
  const remap = new Uint32Array(a.d.length + 1);
  for (let k = 0; k < a.d.length; k++) {
    const r = f(a.d[k]);
    remap[k + 1] = b.code(r === null ? null : String(r));
  }
  const c = new Uint32Array(n);
  for (let i = 0; i < n; i++) c[i] = remap[a.c[i]];
  return { t: "str", c, d: b.d };
}

// ----------------------------------------------------------- conversions --

/** Text to a number: a plain number, or an ISO date ("2024-03-31") as a serial. */
export function textToNum(s: string): number {
  const n = parseNumber(s);
  if (n !== null) return n;
  const d = isoToSerial(s);
  return d === null ? NaN : d;
}

export function numToText(x: number, fmt?: string): string {
  if (isDateFmt(fmt)) {
    const p = serialToParts(x);
    const pad = (k: number, w = 2) => String(k).padStart(w, "0");
    const date = `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
    return p.h || p.mi || p.s ? `${date} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}` : date;
  }
  if (Number.isInteger(x)) return String(x);
  // trim float noise: 0.1 + 0.2 shows as 0.3
  return String(Number(x.toPrecision(15)));
}

export function toNum(a: Vec): Extract<Vec, { t: "num" }> {
  switch (a.t) {
    case "num":
      return a;
    case "null":
      return { t: "num", v: Float64Array.of(NaN) };
    case "bool": {
      const v = new Float64Array(a.v.length);
      for (let i = 0; i < v.length; i++) v[i] = a.v[i] === 2 ? NaN : a.v[i];
      return { t: "num", v };
    }
    case "str": {
      let dateLike = false;
      const r = mapDict(
        a,
        (s) => {
          const n = parseNumber(s);
          if (n !== null) return n;
          const d = isoToSerial(s);
          if (d !== null) dateLike = true;
          return d;
        },
        "num",
      ) as Extract<Vec, { t: "num" }>;
      if (dateLike) r.fmt = DATE_FMT;
      return r;
    }
  }
}

export function toStr(a: Vec): Extract<Vec, { t: "str" }> {
  switch (a.t) {
    case "str":
      return a;
    case "null":
      return { t: "str", c: Uint32Array.of(0), d: [] };
    case "bool": {
      const c = new Uint32Array(a.v.length);
      for (let i = 0; i < c.length; i++) c[i] = a.v[i] === 2 ? 0 : a.v[i] === 1 ? 1 : 2;
      return { t: "str", c, d: ["TRUE", "FALSE"] };
    }
    case "num": {
      const b = new StrBuilder();
      const cache = new Map<number, number>();
      const c = new Uint32Array(a.v.length);
      for (let i = 0; i < c.length; i++) {
        const x = a.v[i];
        if (Number.isNaN(x)) continue;
        let code = cache.get(x);
        if (code === undefined) {
          code = b.code(numToText(x, a.fmt));
          cache.set(x, code);
        }
        c[i] = code;
      }
      return { t: "str", c, d: b.d };
    }
  }
}

export function toBool(a: Vec): Extract<Vec, { t: "bool" }> {
  switch (a.t) {
    case "bool":
      return a;
    case "null":
      return { t: "bool", v: Uint8Array.of(2) };
    case "num": {
      const v = new Uint8Array(a.v.length);
      for (let i = 0; i < v.length; i++) {
        const x = a.v[i];
        v[i] = Number.isNaN(x) ? 2 : x !== 0 ? 1 : 0;
      }
      return { t: "bool", v };
    }
    case "str":
      return mapDict(
        a,
        (s) => {
          const u = s.trim().toUpperCase();
          return u === "TRUE" || u === "YES" ? true : u === "FALSE" || u === "NO" ? false : null;
        },
        "bool",
      ) as Extract<Vec, { t: "bool" }>;
  }
}

/** Expand a constant to n rows (or return the vec as is). */
export function broadcast(a: Vec, n: number): Vec {
  if (vlen(a) === n && a.t !== "null") return a;
  switch (a.t) {
    case "null":
      return { t: "num", v: new Float64Array(n).fill(NaN) };
    case "num":
      return { t: "num", v: new Float64Array(n).fill(a.v[0]), ...(a.fmt ? { fmt: a.fmt } : {}) };
    case "bool":
      return { t: "bool", v: new Uint8Array(n).fill(a.v[0]) };
    case "str":
      return { t: "str", c: new Uint32Array(n).fill(a.c[0]), d: a.d };
  }
}

/** Rows idx of a (idx -1 gives NULL). Constants stay constants. */
export function gather(a: Vec, idx: ArrayLike<number>): Vec {
  if (a.t === "null" || (vlen(a) === 1 && !hasNeg(idx))) return a;
  if (vlen(a) === 1) a = broadcast(a, 1);
  const n = idx.length;
  const one = vlen(a) === 1;
  switch (a.t) {
    case "num": {
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const j = idx[i];
        v[i] = j < 0 ? NaN : a.v[one ? 0 : j];
      }
      return { t: "num", v, ...(a.fmt ? { fmt: a.fmt } : {}) };
    }
    case "bool": {
      const v = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const j = idx[i];
        v[i] = j < 0 ? 2 : a.v[one ? 0 : j];
      }
      return { t: "bool", v };
    }
    case "str": {
      const c = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        const j = idx[i];
        c[i] = j < 0 ? 0 : a.c[one ? 0 : j];
      }
      return { t: "str", c, d: a.d };
    }
  }
  return a;
}

function hasNeg(idx: ArrayLike<number>): boolean {
  for (let i = 0; i < idx.length; i++) if (idx[i] < 0) return true;
  return false;
}

/** Bring vecs to one type (str wins over num over bool) with str sharing one dict. */
export function unify(vecs: Vec[]): Vec[] {
  const typed = vecs.filter((v) => v.t !== "null");
  if (!typed.length) return vecs;
  const kind = typed.some((v) => v.t === "str") ? "str" : typed.some((v) => v.t === "num") ? "num" : "bool";
  if (kind === "num") {
    const fmt = (typed.find((v) => v.t === "num" && v.fmt) as { fmt?: string } | undefined)?.fmt;
    return vecs.map((v) => {
      const r = toNum(v);
      return fmt && !r.fmt ? { ...r, fmt } : r;
    });
  }
  if (kind === "bool") return vecs.map(toBool);
  const strs = vecs.map(toStr);
  const d0 = strs.find((s) => s.d.length)?.d;
  if (strs.every((s) => s.d === d0 || !s.d.length)) return strs;
  const b = new StrBuilder();
  return strs.map((s) => {
    const remap = new Uint32Array(s.d.length + 1);
    for (let k = 0; k < s.d.length; k++) remap[k + 1] = b.code(s.d[k]);
    const c = new Uint32Array(s.c.length);
    for (let i = 0; i < c.length; i++) c[i] = remap[s.c[i]];
    return { t: "str" as const, c, d: b.d };
  });
}

/** Per row, the value of vecs[pick[i]] (pick -1 = NULL). */
export function choose(pick: Int32Array, vecs: Vec[], n: number): Vec {
  const u = unify(vecs);
  const typed = u.find((v) => v.t !== "null");
  if (!typed) return NULL_VEC;
  if (typed.t === "num") {
    const out = new Float64Array(n);
    const arrs = u.map((v) => (v.t === "num" ? v.v : Float64Array.of(NaN)));
    const masks = arrs.map((a) => (a.length === 1 ? 0 : -1));
    for (let i = 0; i < n; i++) {
      const k = pick[i];
      out[i] = k < 0 ? NaN : arrs[k][i & masks[k]];
    }
    const fmt = u.map((v) => (v.t === "num" ? v.fmt : undefined)).find(Boolean);
    return { t: "num", v: out, ...(fmt ? { fmt } : {}) };
  }
  if (typed.t === "bool") {
    const out = new Uint8Array(n);
    const arrs = u.map((v) => (v.t === "bool" ? v.v : Uint8Array.of(2)));
    const masks = arrs.map((a) => (a.length === 1 ? 0 : -1));
    for (let i = 0; i < n; i++) {
      const k = pick[i];
      out[i] = k < 0 ? 2 : arrs[k][i & masks[k]];
    }
    return { t: "bool", v: out };
  }
  const out = new Uint32Array(n);
  const arrs = u.map((v) => (v.t === "str" ? v.c : Uint32Array.of(0)));
  const masks = arrs.map((a) => (a.length === 1 ? 0 : -1));
  for (let i = 0; i < n; i++) {
    const k = pick[i];
    out[i] = k < 0 ? 0 : arrs[k][i & masks[k]];
  }
  const dict = (u.find((v) => v.t === "str" && v.d.length) as { d: string[] } | undefined)?.d ?? [];
  return { t: "str", c: out, d: dict };
}

/** Rows stacked: a then b (same type after unify). */
export function concatVecs(a: Vec, na: number, b: Vec, nb: number): Vec {
  const [ua, ub] = unify([broadcast(a, na), broadcast(b, nb)]);
  const A = broadcast(ua, na);
  const B = broadcast(ub, nb);
  if (A.t === "num" && B.t === "num") {
    const v = new Float64Array(na + nb);
    v.set(A.v.subarray(0, na));
    v.set(B.v.subarray(0, nb), na);
    return { t: "num", v, ...(A.fmt || B.fmt ? { fmt: A.fmt || B.fmt } : {}) };
  }
  if (A.t === "bool" && B.t === "bool") {
    const v = new Uint8Array(na + nb);
    v.set(A.v.subarray(0, na));
    v.set(B.v.subarray(0, nb), na);
    return { t: "bool", v };
  }
  if (A.t === "str" && B.t === "str") {
    const c = new Uint32Array(na + nb);
    c.set(A.c.subarray(0, na));
    c.set(B.c.subarray(0, nb), na);
    return { t: "str", c, d: A.d.length ? A.d : B.d };
  }
  return { t: "num", v: new Float64Array(na + nb).fill(NaN) };
}

/** Keep the rows where sel is set. */
export function selectRows(b: Extract<Vec, { t: "bool" }>, n: number): Int32Array {
  const m = maskOf(b);
  let count = 0;
  for (let i = 0; i < n; i++) if (b.v[i & m] === 1) count++;
  const out = new Int32Array(count);
  let k = 0;
  for (let i = 0; i < n; i++) if (b.v[i & m] === 1) out[k++] = i;
  return out;
}

// ---------------------------------------------------------------- hashing --

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

function hashNum(x: number): number {
  let h: number;
  if ((x | 0) === x) h = Math.imul(x, 0x9e3779b1);
  else {
    f64[0] = x;
    h = Math.imul(u32[0] ^ Math.imul(u32[1], 0x85ebca6b), 0x9e3779b1);
  }
  return h ^ (h >>> 15);
}

/** Open-addressing hash map from a double (not NaN) to an int id. */
export class NumMap {
  private keys: Float64Array;
  private vals: Int32Array;
  private mask: number;
  size = 0;
  constructor(cap = 64) {
    let c = 16;
    while (c < cap * 2) c *= 2;
    this.keys = new Float64Array(c);
    this.vals = new Int32Array(c).fill(-1);
    this.mask = c - 1;
  }
  /** The id stored for x, or -1. */
  get(x: number): number {
    if (x === 0) x = 0; // -0
    let s = hashNum(x) & this.mask;
    for (;;) {
      const v = this.vals[s];
      if (v < 0) return -1;
      if (this.keys[s] === x) return v;
      s = (s + 1) & this.mask;
    }
  }
  /** The id stored for x; stores `id` if there was none. */
  getOrAdd(x: number, id: number): number {
    if (x === 0) x = 0;
    let s = hashNum(x) & this.mask;
    for (;;) {
      const v = this.vals[s];
      if (v < 0) break;
      if (this.keys[s] === x) return v;
      s = (s + 1) & this.mask;
    }
    this.keys[s] = x;
    this.vals[s] = id;
    if (++this.size * 2 > this.mask) this.grow();
    return id;
  }
  private grow(): void {
    const keys = this.keys;
    const vals = this.vals;
    const c = keys.length * 2;
    this.keys = new Float64Array(c);
    this.vals = new Int32Array(c).fill(-1);
    this.mask = c - 1;
    for (let s = 0; s < keys.length; s++) {
      if (vals[s] < 0) continue;
      let t = hashNum(keys[s]) & this.mask;
      while (this.vals[t] >= 0) t = (t + 1) & this.mask;
      this.keys[t] = keys[s];
      this.vals[t] = vals[s];
    }
  }
}

/** Shared id space for values, so equal values get equal ids across vecs. */
export class KeySpace {
  strs = new Map<string, number>();
  nums = new NumMap(1024);
  next = 0;

  /** Per-row ids (-1 for NULL). With `add` false, values not seen yet get -2. */
  ids(a: Vec, n: number, add = true): Int32Array {
    const out = new Int32Array(n);
    if (a.t === "null") return out.fill(-1);
    if (a.t === "str") {
      const table = new Int32Array(a.d.length + 1);
      table[0] = -1;
      for (let k = 0; k < a.d.length; k++) {
        const s = a.d[k];
        let id = this.strs.get(s);
        if (id === undefined) {
          if (add) {
            id = this.next++;
            this.strs.set(s, id);
          } else id = -2;
        }
        table[k + 1] = id;
      }
      const m = maskOf(a);
      const c = a.c;
      for (let i = 0; i < n; i++) out[i] = table[c[i & m]];
      return out;
    }
    const v = a.t === "num" ? a.v : toNum(a).v;
    const m = v.length === 1 ? 0 : -1;
    const map = this.nums;
    for (let i = 0; i < n; i++) {
      const x = v[i & m];
      if (x !== x) out[i] = -1;
      else if (add) {
        const id = map.getOrAdd(x, this.next);
        if (id === this.next) this.next++;
        out[i] = id;
      } else {
        const id = map.get(x);
        out[i] = id < 0 ? -2 : id;
      }
    }
    return out;
  }
}

export interface Groups {
  /** group of each row (-1 = no group) */
  gid: Int32Array;
  /** number of groups */
  ng: number;
  /** first row of each group */
  first: Int32Array;
}

/** Number the distinct combinations of the key vecs in order of first appearance. NULLs group together. */
export function groupRows(keys: Vec[], n: number): Groups {
  if (!keys.length) {
    return { gid: new Int32Array(n), ng: n ? 1 : 0, first: new Int32Array(n ? 1 : 0) };
  }
  let g: Groups | null = null;
  for (const key of keys) {
    let ids: Int32Array;
    let card: number;
    // fast path: one str column - its codes are already ids
    if (key.t === "str" && vlen(key) === n && new Set(key.d).size === key.d.length) {
      ids = key.c as unknown as Int32Array; // codes: 0 = NULL, read below as card
      card = key.d.length + 1;
      g = combine(g, ids, card, n, true);
    } else {
      const ks = new KeySpace();
      ids = ks.ids(key, n);
      card = ks.next + 1;
      for (let i = 0; i < n; i++) if (ids[i] < 0) ids[i] = card - 1;
      g = combine(g, ids, card, n, false);
    }
  }
  return g!;
}

/** Dense group ids from (previous group, new ids). */
function combine(prev: Groups | null, ids: ArrayLike<number>, card: number, n: number, _codes: boolean): Groups {
  const gid = new Int32Array(n);
  let first = new Int32Array(64);
  let ng = 0;
  if (!prev) {
    const remap = new Int32Array(card).fill(-1);
    for (let i = 0; i < n; i++) {
      const k = ids[i];
      let r = remap[k];
      if (r < 0) {
        r = remap[k] = ng++;
        if (r >= first.length) first = grow(first);
        first[r] = i;
      }
      gid[i] = r;
    }
    return { gid, ng, first: first.slice(0, ng) };
  }
  const pg = prev.gid;
  if (prev.ng * card < 2 ** 31 && prev.ng * card <= 4 * n + 1024) {
    // small key space: direct table
    const remap = new Int32Array(prev.ng * card).fill(-1);
    for (let i = 0; i < n; i++) {
      const k = pg[i] * card + ids[i];
      let r = remap[k];
      if (r < 0) {
        r = remap[k] = ng++;
        if (r >= first.length) first = grow(first);
        first[r] = i;
      }
      gid[i] = r;
    }
  } else if (prev.ng * card < 2 ** 52) {
    const map = new NumMap(1024);
    for (let i = 0; i < n; i++) {
      const r = map.getOrAdd(pg[i] * card + ids[i], ng);
      if (r === ng) {
        if (ng >= first.length) first = grow(first);
        first[ng++] = i;
      }
      gid[i] = r;
    }
  } else {
    const map = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const key = `${pg[i]},${ids[i]}`;
      let r = map.get(key);
      if (r === undefined) {
        r = ng++;
        map.set(key, r);
        if (r >= first.length) first = grow(first);
        first[r] = i;
      }
      gid[i] = r;
    }
  }
  return { gid, ng, first: first.slice(0, ng) };
}

function grow(a: Int32Array) {
  const b = new Int32Array(a.length * 2);
  b.set(a);
  return b;
}

/**
 * Join keys of two sides into one id space (-1 = NULL in some key, never
 * matches). Types are aligned first: text against numbers is read as numbers.
 */
export function joinKeyIds(left: Vec[], nl: number, right: Vec[], nr: number): { l: Int32Array; r: Int32Array; card: number } {
  let L: Int32Array | null = null;
  let R: Int32Array | null = null;
  let card = 0;
  for (let k = 0; k < left.length; k++) {
    let a = left[k];
    let b = right[k];
    if (a.t !== b.t && a.t !== "null" && b.t !== "null") {
      if (a.t === "str" && b.t === "str") {
        /* same */
      } else if (a.t === "str" || b.t === "str") {
        a = toNum(a);
        b = toNum(b);
      } else {
        a = toNum(a);
        b = toNum(b);
      }
    }
    const ks = new KeySpace();
    const li = ks.ids(a, nl);
    const ri = ks.ids(b, nr);
    const c = ks.next;
    if (!L || !R) {
      L = li;
      R = ri;
      card = c;
      continue;
    }
    // combine (prev, new) pairs into ids shared by both sides
    const map = new NumMap(1024);
    let next = 0;
    const pair = (p: Int32Array, q: Int32Array, n: number) => {
      const out = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        if (p[i] < 0 || q[i] < 0) {
          out[i] = -1;
          continue;
        }
        const id = map.getOrAdd(p[i] * c + q[i], next);
        if (id === next) next++;
        out[i] = id;
      }
      return out;
    };
    if (card * c >= 2 ** 52) {
      // fall back to string keys
      const smap = new Map<string, number>();
      const spair = (p: Int32Array, q: Int32Array, n: number) => {
        const out = new Int32Array(n);
        for (let i = 0; i < n; i++) {
          if (p[i] < 0 || q[i] < 0) {
            out[i] = -1;
            continue;
          }
          const key = `${p[i]},${q[i]}`;
          let id = smap.get(key);
          if (id === undefined) smap.set(key, (id = next++));
          out[i] = id;
        }
        return out;
      };
      L = spair(L, li, nl);
      R = spair(R, ri, nr);
    } else {
      L = pair(L, li, nl);
      R = pair(R, ri, nr);
    }
    card = next;
  }
  return { l: L!, r: R!, card };
}

// ------------------------------------------------------------------ sort --

export interface SortKey {
  vec: Vec;
  desc: boolean;
  nullsFirst?: boolean;
}

/** Ranks of a dict's entries in text order (equal text, equal rank). Index by code; 0 unused. */
export function dictRanks(d: string[]): Float64Array {
  const order = Array.from(d.keys()).sort((a, b) => cmpStr(d[a], d[b]));
  const ranks = new Float64Array(d.length + 1);
  let r = 0;
  for (let k = 0; k < order.length; k++) {
    if (k > 0 && d[order[k]] !== d[order[k - 1]]) r++;
    ranks[order[k] + 1] = r;
  }
  return ranks;
}

/** One float per row that sorts like the value, plus a null flag. */
export function sortKeyOf(a: Vec, n: number): { keys: Float64Array; nulls: Uint8Array } {
  const keys = new Float64Array(n);
  const nulls = new Uint8Array(n);
  const m = maskOf(a);
  switch (a.t) {
    case "null":
      nulls.fill(1);
      break;
    case "num":
      for (let i = 0; i < n; i++) {
        const x = a.v[i & m];
        if (x !== x) nulls[i] = 1;
        else keys[i] = x + 0;
      }
      break;
    case "bool":
      for (let i = 0; i < n; i++) {
        const x = a.v[i & m];
        if (x === 2) nulls[i] = 1;
        else keys[i] = x;
      }
      break;
    case "str": {
      const ranks = dictRanks(a.d);
      for (let i = 0; i < n; i++) {
        const c = a.c[i & m];
        if (c === 0) nulls[i] = 1;
        else keys[i] = ranks[c];
      }
    }
  }
  return { keys, nulls };
}

/** The `top` smallest rows by cmp (a total order), in order: a max-heap of size top. */
function topRows(rows: Int32Array, top: number, cmp: (a: number, b: number) => number): Int32Array {
  const heap: number[] = [];
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let big = i;
      if (l < heap.length && cmp(heap[l], heap[big]) > 0) big = l;
      if (r < heap.length && cmp(heap[r], heap[big]) > 0) big = r;
      if (big === i) return;
      [heap[i], heap[big]] = [heap[big], heap[i]];
      i = big;
    }
  };
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k];
    if (heap.length < top) {
      heap.push(row);
      for (let i = heap.length - 1; i > 0; ) {
        const p = (i - 1) >> 1;
        if (cmp(heap[i], heap[p]) <= 0) break;
        [heap[i], heap[p]] = [heap[p], heap[i]];
        i = p;
      }
    } else if (top > 0 && cmp(row, heap[0]) < 0) {
      heap[0] = row;
      down(0);
    }
  }
  return Int32Array.from(heap.sort(cmp));
}

/**
 * A stable sort of rows 0..n-1 (or of `rows`) by the keys. Large inputs use the
 * radix sort, one stable pass per key from the last key to the first.
 */
export function sortRows(keys: SortKey[], n: number, rows?: Int32Array, top?: number): Int32Array {
  const m = rows ? rows.length : n;
  const prepared = keys.map((k) => {
    const sk = sortKeyOf(k.vec, n);
    const nullsFirst = k.nullsFirst ?? k.desc;
    return { ...sk, desc: k.desc, nullsFirst };
  });
  let perm = rows ? Int32Array.from(rows) : Int32Array.from({ length: n }, (_, i) => i);
  if (!keys.length || m < 2) return top !== undefined && top < m ? perm.slice(0, top) : perm;
  const cmp = (a: number, b: number): number => {
    for (const k of prepared) {
      const na = k.nulls[a];
      const nb = k.nulls[b];
      if (na || nb) {
        if (na && nb) continue;
        return na ? (k.nullsFirst ? -1 : 1) : k.nullsFirst ? 1 : -1;
      }
      const x = k.keys[a];
      const y = k.keys[b];
      if (x !== y) return (x < y ? -1 : 1) * (k.desc ? -1 : 1);
    }
    return 0;
  };
  // only the first few wanted (ORDER BY ... LIMIT 10): keep the best in a heap
  if (top !== undefined && top * 16 < m) return topRows(perm, top, (a, b) => cmp(a, b) || a - b);
  if (m < 4096) {
    const p = Array.from(perm);
    p.sort(cmp);
    return Int32Array.from(p);
  }
  for (let j = prepared.length - 1; j >= 0; j--) {
    const k = prepared[j];
    const pk = new Float64Array(m);
    const kinds = new Uint8Array(m);
    for (let i = 0; i < m; i++) {
      const r = perm[i];
      if (k.nulls[r]) kinds[i] = k.nullsFirst ? 0 : 2;
      else {
        kinds[i] = 1;
        pk[i] = k.keys[r];
      }
    }
    const p = radixSortIndices(pk, kinds, k.desc);
    const next = new Int32Array(m);
    for (let i = 0; i < m; i++) next[i] = perm[p[i]];
    perm = next;
  }
  return perm;
}
