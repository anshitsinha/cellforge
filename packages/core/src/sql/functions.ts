/**
 * Scalar functions (one value in, one value out per row). Each is a plain
 * JS function on values; the driver runs it once for constants, once per
 * distinct text for a text column, or once per row otherwise.
 */
import { dateToSerial, serialToParts } from "../numfmt";
import { constVec, DATE_FMT, mapDict, maskOf, StrBuilder, toNum, toStr, vlen, type Scalar, type Vec } from "./vec";

type ArgT = "num" | "str" | "any";

export interface ScalarFn {
  args: ArgT[];
  /** fewest arguments (default: all of args) */
  min?: number;
  /** type of any further arguments (variadic) */
  rest?: ArgT;
  ret: "num" | "str";
  f: (a: Scalar[]) => Scalar;
  /** the result is a date (shown with a date format) */
  date?: boolean;
  /** cache results per distinct input (date functions) */
  memo?: boolean;
  /** NULL in any argument gives NULL without calling f (default true) */
  strict?: boolean;
}

const num = (x: Scalar) => x as number;
const str = (x: Scalar) => x as string;

function round(x: number, d: number): number {
  const p = 10 ** d;
  const r = Math.round(Math.abs(x) * p * (1 + 2 * Number.EPSILON)) / p;
  return Math.sign(x) * r;
}
function trunc(x: number, d: number): number {
  const p = 10 ** d;
  return Math.trunc(x * p * (1 + 2 * Number.EPSILON)) / p;
}

function truncDate(unit: string, d: number): number | null {
  const p = serialToParts(d);
  switch (unit.toLowerCase()) {
    case "year":
      return dateToSerial(p.y, 1, 1);
    case "quarter":
      return dateToSerial(p.y, Math.floor((p.m - 1) / 3) * 3 + 1, 1);
    case "month":
      return dateToSerial(p.y, p.m, 1);
    case "week": // weeks start on Monday
      return Math.floor(d) - ((p.wd + 6) % 7);
    case "day":
      return Math.floor(d);
    default:
      throw new Error(`DATE_TRUNC doesn't know the unit '${unit}'; use 'year', 'quarter', 'month', 'week' or 'day'`);
  }
}

function datePart(part: string, d: number): number {
  const p = serialToParts(d);
  switch (part.toUpperCase()) {
    case "YEAR":
      return p.y;
    case "QUARTER":
      return Math.floor((p.m - 1) / 3) + 1;
    case "MONTH":
      return p.m;
    case "DAY":
      return p.d;
    case "DOW":
    case "DAYOFWEEK":
      return p.wd;
    case "HOUR":
      return p.h;
    case "MINUTE":
      return p.mi;
    case "SECOND":
      return p.s;
    case "WEEK": {
      // ISO week number
      const day = Math.floor(d);
      const thursday = day - ((p.wd + 6) % 7) + 3;
      const ty = serialToParts(thursday).y;
      return Math.floor((thursday - dateToSerial(ty, 1, 1)) / 7) + 1;
    }
    default:
      throw new Error(`Unknown date part '${part}'; use YEAR, QUARTER, MONTH, DAY, WEEK, DOW, HOUR, MINUTE or SECOND`);
  }
}

function likeIndex(s: string, sub: string): number {
  return s.indexOf(sub) + 1;
}

export const SCALAR: Record<string, ScalarFn> = {
  LOWER: { args: ["str"], ret: "str", f: (a) => str(a[0]).toLowerCase() },
  UPPER: { args: ["str"], ret: "str", f: (a) => str(a[0]).toUpperCase() },
  TRIM: { args: ["str"], ret: "str", f: (a) => str(a[0]).trim() },
  LTRIM: { args: ["str"], ret: "str", f: (a) => str(a[0]).trimStart() },
  RTRIM: { args: ["str"], ret: "str", f: (a) => str(a[0]).trimEnd() },
  LENGTH: { args: ["str"], ret: "num", f: (a) => str(a[0]).length },
  SUBSTR: {
    args: ["str", "num", "num"],
    min: 2,
    ret: "str",
    f: (a) => {
      const s = str(a[0]);
      let start = Math.trunc(num(a[1]));
      let len = a.length > 2 ? Math.trunc(num(a[2])) : Infinity;
      if (len < 0) return "";
      // SQL: positions before 1 eat into the length
      if (start < 1) {
        len += start - 1;
        start = 1;
      }
      return len <= 0 ? "" : s.substr(start - 1, len === Infinity ? undefined : len);
    },
  },
  LEFT: { args: ["str", "num"], ret: "str", f: (a) => str(a[0]).slice(0, Math.max(0, Math.trunc(num(a[1])))) },
  RIGHT: { args: ["str", "num"], ret: "str", f: (a) => (num(a[1]) <= 0 ? "" : str(a[0]).slice(-Math.trunc(num(a[1])))) },
  REPLACE: { args: ["str", "str", "str"], ret: "str", f: (a) => (str(a[1]) === "" ? str(a[0]) : str(a[0]).split(str(a[1])).join(str(a[2]))) },
  POSITION: { args: ["str", "str"], ret: "num", f: (a) => likeIndex(str(a[1]), str(a[0])) },
  STRPOS: { args: ["str", "str"], ret: "num", f: (a) => likeIndex(str(a[0]), str(a[1])) },
  REVERSE: { args: ["str"], ret: "str", f: (a) => Array.from(str(a[0])).reverse().join("") },
  LPAD: { args: ["str", "num", "str"], min: 2, ret: "str", f: (a) => pad(str(a[0]), num(a[1]), a.length > 2 ? str(a[2]) : " ", true) },
  RPAD: { args: ["str", "num", "str"], min: 2, ret: "str", f: (a) => pad(str(a[0]), num(a[1]), a.length > 2 ? str(a[2]) : " ", false) },
  CONCAT: { args: [], rest: "str", ret: "str", strict: false, f: (a) => a.map((x) => (x === null ? "" : x)).join("") },

  ABS: { args: ["num"], ret: "num", f: (a) => Math.abs(num(a[0])) },
  ROUND: { args: ["num", "num"], min: 1, ret: "num", f: (a) => round(num(a[0]), a.length > 1 ? Math.trunc(num(a[1])) : 0) },
  TRUNC: { args: ["num", "num"], min: 1, ret: "num", f: (a) => trunc(num(a[0]), a.length > 1 ? Math.trunc(num(a[1])) : 0) },
  FLOOR: { args: ["num"], ret: "num", f: (a) => Math.floor(num(a[0])) },
  CEIL: { args: ["num"], ret: "num", f: (a) => Math.ceil(num(a[0])) },
  MOD: { args: ["num", "num"], ret: "num", f: (a) => (num(a[1]) === 0 ? null : num(a[0]) % num(a[1])) },
  POWER: { args: ["num", "num"], ret: "num", f: (a) => num(a[0]) ** num(a[1]) },
  SQRT: { args: ["num"], ret: "num", f: (a) => (num(a[0]) < 0 ? null : Math.sqrt(num(a[0]))) },
  SIGN: { args: ["num"], ret: "num", f: (a) => Math.sign(num(a[0])) },
  LN: { args: ["num"], ret: "num", f: (a) => (num(a[0]) <= 0 ? null : Math.log(num(a[0]))) },
  EXP: { args: ["num"], ret: "num", f: (a) => Math.exp(num(a[0])) },
  LOG10: { args: ["num"], ret: "num", f: (a) => (num(a[0]) <= 0 ? null : Math.log10(num(a[0]))) },

  YEAR: { memo: true, args: ["num"], ret: "num", f: (a) => serialToParts(num(a[0])).y },
  MONTH: { memo: true, args: ["num"], ret: "num", f: (a) => serialToParts(num(a[0])).m },
  DAY: { memo: true, args: ["num"], ret: "num", f: (a) => serialToParts(num(a[0])).d },
  QUARTER: { memo: true, args: ["num"], ret: "num", f: (a) => Math.floor((serialToParts(num(a[0])).m - 1) / 3) + 1 },
  EXTRACT: { memo: true, args: ["str", "num"], ret: "num", f: (a) => datePart(str(a[0]), num(a[1])) },
  DATE_PART: { memo: true, args: ["str", "num"], ret: "num", f: (a) => datePart(str(a[0]), num(a[1])) },
  DATE_TRUNC: { memo: true, args: ["str", "num"], ret: "num", date: true, f: (a) => truncDate(str(a[0]), num(a[1])) },
  EOMONTH: {
    memo: true,
    args: ["num", "num"],
    min: 1,
    ret: "num",
    date: true,
    f: (a) => {
      const p = serialToParts(num(a[0]));
      return dateToSerial(p.y, p.m + 1 + (a.length > 1 ? Math.trunc(num(a[1])) : 0), 0);
    },
  },
  DATE: { args: ["num", "num", "num"], ret: "num", date: true, f: (a) => dateToSerial(num(a[0]), num(a[1]), num(a[2])) },
  DATEDIFF: {
    args: ["str", "num", "num"],
    ret: "num",
    f: (a) => {
      const unit = str(a[0]).toLowerCase();
      const x = num(a[1]);
      const y = num(a[2]);
      if (unit === "day") return Math.floor(y) - Math.floor(x);
      const p = serialToParts(x);
      const q = serialToParts(y);
      if (unit === "month") return (q.y - p.y) * 12 + (q.m - p.m);
      if (unit === "year") return q.y - p.y;
      throw new Error(`DATEDIFF doesn't know the unit '${a[0]}'; use 'day', 'month' or 'year'`);
    },
  },
};
// other names for the same functions
const ALIASES: Record<string, string> = {
  LEN: "LENGTH",
  CHAR_LENGTH: "LENGTH",
  CHARACTER_LENGTH: "LENGTH",
  SUBSTRING: "SUBSTR",
  MID: "SUBSTR",
  INSTR: "STRPOS",
  CEILING: "CEIL",
  POW: "POWER",
  MAKE_DATE: "DATE",
};
for (const [k, v] of Object.entries(ALIASES)) SCALAR[k] = SCALAR[v];

function pad(s: string, len: number, fill: string, left: boolean): string {
  len = Math.trunc(len);
  if (s.length >= len) return s.slice(0, Math.max(0, len));
  if (!fill) return s;
  const extra = fill.repeat(Math.ceil((len - s.length) / fill.length)).slice(0, len - s.length);
  return left ? extra + s : s + extra;
}

/** Run a scalar function over argument vecs. */
export function callScalar(def: ScalarFn, raw: Vec[], n: number): Vec {
  const strict = def.strict !== false;
  const args = raw.map((v, k) => {
    const t = k < def.args.length ? def.args[k] : def.rest ?? "any";
    return t === "num" ? toNum(v) : t === "str" ? toStr(v) : v;
  });
  const out = (x: Scalar) => {
    if (def.ret === "num") return typeof x === "number" ? x : x === null ? NaN : Number(x);
    return x;
  };
  const fmt = def.date ? DATE_FMT : undefined;
  const vector = args.map((a) => vlen(a) !== 1 || n === 1);
  if (n === 0) return def.ret === "num" ? { t: "num", v: new Float64Array(0), ...(fmt ? { fmt } : {}) } : { t: "str", c: new Uint32Array(0), d: [] };
  // all constants: once
  if (!vector.some(Boolean)) {
    const vals = args.map((a) => valueOf(a, 0));
    if (strict && vals.some((v) => v === null)) return constVec(null);
    return constVec(def.ret === "num" ? (out(def.f(vals)) as number) : (def.f(vals) as Scalar), fmt);
  }
  // one text column, the rest constant: once per distinct text
  const vi = vector.indexOf(true);
  if (vector.lastIndexOf(true) === vi && args[vi].t === "str") {
    const vals = args.map((a) => valueOf(a, 0));
    if (strict && vals.some((v, k) => k !== vi && v === null)) return constVec(null);
    const r = mapDict(
      args[vi] as Extract<Vec, { t: "str" }>,
      (s) => {
        vals[vi] = s;
        return def.f(vals);
      },
      def.ret,
    );
    // NULL rows (code 0) stay NULL; for non-strict functions call f with null
    if (!strict) {
      vals[vi] = null;
      const atNull = def.f(vals);
      if (atNull !== null) return fillNullRows(r, args[vi] as Extract<Vec, { t: "str" }>, atNull);
    }
    return fmt && r.t === "num" ? { ...r, fmt } : r;
  }
  // one number column (dates), the rest constant: remember results per distinct value
  if (def.ret === "num" && vector.lastIndexOf(true) === vi && args[vi].t === "num" && def.memo) {
    const vals = args.map((a) => valueOf(a, 0));
    if (strict && vals.some((v, k) => k !== vi && v === null)) return constVec(null);
    const src = (args[vi] as Extract<Vec, { t: "num" }>).v;
    const v = new Float64Array(n);
    const memo = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const x = src[i];
      if (x !== x) {
        v[i] = NaN;
        continue;
      }
      let r = memo.get(x);
      if (r === undefined) {
        vals[vi] = x;
        r = out(def.f(vals)) as number;
        if (memo.size < 200_000) memo.set(x, r);
      }
      v[i] = r;
    }
    return { t: "num", v, ...(fmt ? { fmt } : {}) };
  }
  // row by row
  const getters = args.map((a) => getter(a));
  const vals: Scalar[] = new Array(args.length);
  if (def.ret === "num") {
    const v = new Float64Array(n);
    outer: for (let i = 0; i < n; i++) {
      for (let k = 0; k < getters.length; k++) {
        const x = getters[k](i);
        if (strict && x === null) {
          v[i] = NaN;
          continue outer;
        }
        vals[k] = x;
      }
      v[i] = out(def.f(vals)) as number;
    }
    return { t: "num", v, ...(fmt ? { fmt } : {}) };
  }
  const b = new StrBuilder();
  const c = new Uint32Array(n);
  outer: for (let i = 0; i < n; i++) {
    for (let k = 0; k < getters.length; k++) {
      const x = getters[k](i);
      if (strict && x === null) continue outer;
      vals[k] = x;
    }
    const r = def.f(vals);
    c[i] = b.code(r === null ? null : String(r));
  }
  return { t: "str", c, d: b.d };
}

function fillNullRows(r: Vec, src: Extract<Vec, { t: "str" }>, value: Scalar): Vec {
  if (r.t === "str") {
    const d = r.d.slice();
    let code = d.indexOf(String(value)) + 1;
    if (!code) code = d.push(String(value));
    const c = Uint32Array.from(r.c, (x, i) => (src.c[i] === 0 ? code : x));
    return { t: "str", c, d };
  }
  if (r.t === "num") return { t: "num", v: Float64Array.from(r.v, (x, i) => (src.c[i] === 0 ? (value as number) : x)) };
  return r;
}

function valueOf(a: Vec, i: number): Scalar {
  return getter(a)(i);
}

/** Fast per-row reader for a vec. */
export function getter(a: Vec): (i: number) => Scalar {
  const m = maskOf(a);
  switch (a.t) {
    case "null":
      return () => null;
    case "num": {
      const v = a.v;
      return (i) => {
        const x = v[i & m];
        return x === x ? x : null;
      };
    }
    case "bool": {
      const v = a.v;
      return (i) => {
        const x = v[i & m];
        return x === 2 ? null : x === 1;
      };
    }
    case "str": {
      const c = a.c;
      const d = a.d;
      return (i) => {
        const x = c[i & m];
        return x === 0 ? null : d[x - 1];
      };
    }
  }
}
