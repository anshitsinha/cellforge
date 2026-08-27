/**
 * The executor. Works a column at a time over typed arrays:
 *
 * - FROM gives a scope: each column is a base vector plus an optional row
 *   index (a selection vector; -1 = NULL from an outer join). Nothing is
 *   copied until a column is used.
 * - WHERE evaluates to a three-valued bool vector; the kept rows become the
 *   new selection.
 * - JOIN pulls equality conditions out of ON, gives both sides' keys ids in a
 *   shared space, buckets the right side by id (counting sort) and probes with
 *   the left. Other conditions filter the candidate pairs.
 * - GROUP BY numbers the key combinations (dictionary codes and an
 *   open-addressing hash map), then aggregates in one pass per aggregate.
 * - ORDER BY sorts row indices (radix sort for big inputs).
 */
import type { ColumnData } from "../columns";
import type { Expr, From, Query, QueryBody, Select } from "./ast";
import { aggregate, AGGREGATES, WINDOW_ONLY } from "./agg";
import { callScalar, SCALAR } from "./functions";
import { SqlError } from "./lexer";
import { parseSql } from "./parser";
import {
  broadcast,
  choose,
  cmpStr,
  concatVecs,
  constVec,
  DATE_FMT,
  dedupeStr,
  dictRanks,
  gather,
  groupRows,
  joinKeyIds,
  mapDict,
  maskOf,
  NULL_VEC,
  selectRows,
  sortKeyOf,
  sortRows,
  StrBuilder,
  toBool,
  toNum,
  toStr,
  unify,
  valueAt,
  vecIsDate,
  vlen,
  type Groups,
  type Scalar,
  type SortKey,
  type Vec,
} from "./vec";

/** A table the query can read: a sheet's columns by name. */
export interface SqlTable {
  name: string;
  columns: ColumnData[];
  /** number formats by column (dates keep their format through the query) */
  numFmts?: (string | undefined)[];
}

/** Where tables come from: a list, or a lookup by name (called only for tables the query uses). */
export type SqlTables = SqlTable[] | ((name: string) => SqlTable | null | undefined);

export interface SqlResult {
  columns: ColumnData[];
  /** a number format per column ("" for none); dates get a date format */
  numFmts: string[];
  rowCount: number;
}

export interface SqlOptions {
  /** stop with an error when a join would produce more rows than this (default 50M) */
  maxRows?: number;
}

/** Run a query. Throws SqlError (with the position in the text) on a problem. */
export function runSql(sql: string, tables: SqlTables, opts: SqlOptions = {}): SqlResult {
  const q = parseSql(sql);
  const env = new Env(sql, tables, opts.maxRows ?? 50_000_000);
  const rel = execQuery(q, env);
  const columns: ColumnData[] = [];
  const numFmts: string[] = [];
  rel.vecs.forEach((v, k) => {
    const { col, fmt } = toColumn(rel.names[k], v, rel.n, env);
    columns.push(col);
    numFmts.push(fmt);
  });
  return { columns, numFmts, rowCount: rel.n };
}

/** The tables a query reads (names as written, without CTE names), e.g. to load only those sheets. */
export function sqlTableNames(sql: string): string[] {
  const q = parseSql(sql);
  const out = new Set<string>();
  const ctes = new Set<string>();
  const walkQ = (q: Query) => {
    for (const c of q.with) ctes.add(c.name.toLowerCase());
    for (const c of q.with) walkQ(c.q);
    walkBody(q.body);
    for (const o of q.order) walkE(o.e);
  };
  const walkBody = (b: QueryBody) => {
    if (b.k === "paren") walkQ(b.q);
    else if (b.k === "setop") {
      walkBody(b.l);
      walkBody(b.r);
    } else {
      if (b.from) walkFrom(b.from);
      for (const it of b.items) walkE(it.e);
      if (b.where) walkE(b.where);
      if (b.having) walkE(b.having);
    }
  };
  const walkFrom = (f: From) => {
    if (f.k === "table") {
      if (!ctes.has(f.name.toLowerCase())) out.add(f.name);
    } else if (f.k === "sub") walkQ(f.q);
    else {
      walkFrom(f.l);
      walkFrom(f.r);
      if (f.on) walkE(f.on);
    }
  };
  const walkE = (e: unknown): void => {
    if (!e || typeof e !== "object") return;
    const o = e as Record<string, unknown>;
    if ((o.k === "sub" || o.k === "exists") && o.q) walkQ(o.q as Query);
    if (o.k === "in" && o.sub) walkQ(o.sub as Query);
    for (const [key, v] of Object.entries(o)) {
      if (key === "q" || key === "sub") continue;
      if (Array.isArray(v)) v.forEach(walkE);
      else if (v && typeof v === "object") walkE(v);
    }
  };
  walkQ(q);
  return [...out];
}

// ------------------------------------------------------------------ env --

interface Rel {
  names: string[];
  vecs: Vec[];
  n: number;
}

class Env {
  private tableCache = new Map<string, Rel>();
  private cteDefs: { name: string; q: Query; rel?: Rel; running?: boolean; parent: Env | null }[] = [];
  /** results of uncorrelated subqueries, by node */
  readonly subMemo: Map<Expr | Query, Vec | Rel>;
  /** arrays owned by the input tables (copied, not shared, in the result) */
  readonly inputs: WeakSet<object>;

  constructor(
    readonly sql: string,
    readonly tables: SqlTables,
    readonly maxRows: number,
    readonly parent: Env | null = null,
  ) {
    this.subMemo = parent ? parent.subMemo : new Map();
    this.inputs = parent ? parent.inputs : new WeakSet();
    if (parent) this.tableCache = parent.tableCache;
  }

  child(): Env {
    return new Env(this.sql, this.tables, this.maxRows, this);
  }

  err(msg: string, pos: number): SqlError {
    return new SqlError(msg, this.sql, pos);
  }

  addCte(name: string, q: Query, pos: number): void {
    if (this.cteDefs.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw this.err(`The WITH name ${name} is used twice`, pos);
    this.cteDefs.push({ name, q, parent: this.parent });
  }

  /** A CTE by name, searching outwards, else a table. */
  table(name: string, pos: number): Rel {
    const lower = name.toLowerCase();
    for (let e: Env | null = this; e; e = e.parent) {
      const def = e.cteDefs.find((c) => c.name.toLowerCase() === lower);
      if (def) {
        if (def.running) throw this.err(`${name} refers to itself; recursive WITH queries aren't supported`, pos);
        if (!def.rel) {
          def.running = true;
          try {
            def.rel = execQuery(def.q, e);
          } finally {
            def.running = false;
          }
        }
        return def.rel;
      }
    }
    const cached = this.tableCache.get(lower);
    if (cached) return cached;
    let t: SqlTable | null | undefined;
    if (Array.isArray(this.tables)) t = this.tables.find((x) => x.name.toLowerCase() === lower);
    else t = this.tables(name);
    if (!t) {
      const known = Array.isArray(this.tables) ? this.tables.map((x) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(x.name) ? x.name : `"${x.name}"`)) : [];
      throw this.err(`There's no table (sheet) called "${name}"${known.length ? `. Tables: ${known.slice(0, 12).join(", ")}${known.length > 12 ? ", ..." : ""}` : ""}`, pos);
    }
    const rows = t.columns.length ? colLength(t.columns[0]) : 0;
    const vecs = t.columns.map((c, k): Vec => {
      if (colLength(c) !== rows) throw this.err(`Column ${c.name} of ${t!.name} has a different number of rows`, pos);
      if (c.kind === "number") {
        this.inputs.add(c.values);
        const fmt = t!.numFmts?.[k];
        return { t: "num", v: c.values, ...(fmt ? { fmt } : {}) };
      }
      const dd = dedupeStr(c.codes, c.dict);
      this.inputs.add(dd.c);
      this.inputs.add(dd.d);
      return { t: "str", c: dd.c, d: dd.d };
    });
    const rel = { names: t.columns.map((c) => c.name), vecs, n: rows };
    this.tableCache.set(lower, rel);
    return rel;
  }
}

const colLength = (c: ColumnData) => (c.kind === "number" ? c.values.length : c.codes.length);

// ---------------------------------------------------------------- scope --

interface ScopeCol {
  /** table alias, lower case ("" for none) */
  table: string;
  name: string;
  base: Vec;
  /** rows of base; -1 = NULL; null = all rows in order */
  idx: Int32Array | null;
  cache?: Vec;
}

interface Scope {
  n: number;
  cols: ScopeCol[];
  /** aliases in the scope (lower case), to tell "no such table" from "no such column" */
  tables: Set<string>;
}

function relScope(rel: Rel, alias: string): Scope {
  const table = alias.toLowerCase();
  return { n: rel.n, cols: rel.names.map((name, k) => ({ table, name, base: rel.vecs[k], idx: null })), tables: new Set([table]) };
}

function compose(old: Int32Array | null, sel: Int32Array): Int32Array {
  if (!old) return sel;
  const out = new Int32Array(sel.length);
  for (let i = 0; i < sel.length; i++) {
    const j = sel[i];
    out[i] = j < 0 ? -1 : old[j];
  }
  return out;
}

/** The scope's rows narrowed (or repeated, or NULL-extended with -1) by sel. */
function restrict(s: Scope, sel: Int32Array): Scope {
  const memo = new Map<Int32Array | null, Int32Array>();
  return {
    n: sel.length,
    tables: s.tables,
    cols: s.cols.map((c) => {
      let idx = memo.get(c.idx);
      if (!idx) memo.set(c.idx, (idx = compose(c.idx, sel)));
      return { table: c.table, name: c.name, base: c.base, idx };
    }),
  };
}

function materialize(c: ScopeCol): Vec {
  if (!c.idx) return c.base;
  if (!c.cache) c.cache = gather(c.base, c.idx);
  return c.cache;
}

// ------------------------------------------------------------------ ctx --

interface GroupCtx {
  g: Groups;
  /** values of the GROUP BY expressions per group, by expression key */
  keys: Map<string, Vec>;
  row: Ctx;
}

interface Ctx {
  env: Env;
  n: number;
  scope: Scope;
  group?: GroupCtx;
  memo: Map<Expr, Vec>;
  /** for messages: the clause being evaluated */
  clause: string;
}

const rowCtx = (env: Env, scope: Scope, clause: string): Ctx => ({ env, n: scope.n, scope, memo: new Map(), clause });

function findCols(scope: Scope, table: string | undefined, name: string): number[] {
  const t = table?.toLowerCase();
  const nm = name.toLowerCase();
  const out: number[] = [];
  scope.cols.forEach((c, k) => {
    if (c.name.toLowerCase() === nm && (t === undefined || c.table === t)) out.push(k);
  });
  return out;
}

function resolve(ctx: { env: Env; scope: Scope }, e: Extract<Expr, { k: "col" }>): number {
  const found = findCols(ctx.scope, e.table, e.name);
  if (found.length === 1) return found[0];
  const shown = e.table ? `${e.table}.${e.name}` : e.name;
  if (found.length > 1) {
    const tables = [...new Set(found.map((k) => ctx.scope.cols[k].table).filter(Boolean))];
    if (tables.length > 1) throw ctx.env.err(`Column "${e.name}" is in more than one table (${tables.join(", ")}); say which, e.g. ${tables[0]}.${e.name}`, e.pos);
    throw ctx.env.err(`There's more than one column called "${shown}"`, e.pos);
  }
  if (e.table && !ctx.scope.tables.has(e.table.toLowerCase())) {
    const names = [...ctx.scope.tables].filter(Boolean);
    throw ctx.env.err(`There's no table or alias "${e.table}" in this query${names.length ? ` (there is: ${names.join(", ")})` : ""}`, e.pos);
  }
  const avail = ctx.scope.cols.filter((c) => !e.table || c.table === e.table.toLowerCase()).map((c) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) ? c.name : `"${c.name}"`));
  const close = avail.filter((a) => a.replace(/"/g, "").toLowerCase().replace(/[^a-z0-9]/g, "") === e.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const hint = close.length ? ` Did you mean ${close[0]}?` : avail.length ? ` Columns: ${avail.slice(0, 15).join(", ")}${avail.length > 15 ? ", ..." : ""}` : "";
  const quote = /\s/.test(e.name) ? "" : /[^A-Za-z0-9_]/.test(e.name) ? ' (names with spaces or symbols go in "double quotes")' : "";
  throw ctx.env.err(`There's no column "${shown}".${hint}${quote}`, e.pos);
}

/** A string that's the same for the same expression (columns by position in the scope). */
function exprKey(e: Expr, ctx: { env: Env; scope: Scope }): string {
  return JSON.stringify(e, (key, value) => {
    if (key === "pos" || key === "end") return undefined;
    if (key === "q" || key === "sub") return value ? `@${(value as { pos: number }).pos}` : undefined;
    if (value && typeof value === "object" && (value as Expr).k === "col") return `#${resolve(ctx, value as Extract<Expr, { k: "col" }>)}`;
    return value;
  });
}

function hasAgg(e: Expr | undefined): boolean {
  if (!e) return false;
  let found = false;
  const walk = (x: unknown): void => {
    if (found || !x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (o.k === "sub" || o.k === "exists") return;
    if (o.k === "fn" && AGGREGATES.has(o.name as string) && !o.over) {
      found = true;
      return;
    }
    for (const [key, v] of Object.entries(o)) {
      if (key === "sub" || key === "q") continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(e);
  return found;
}

// ---------------------------------------------------------- evaluation --


function evalExpr(e: Expr, ctx: Ctx): Vec {
  // in a grouped query: GROUP BY expressions are looked up first
  if (ctx.group && ctx.group.keys.size && e.k !== "lit") {
    const hit = ctx.group.keys.get(exprKey(e, ctx.group.row));
    if (hit) return hit;
  }
  switch (e.k) {
    case "lit":
      return constVec(e.v, e.date ? DATE_FMT : undefined);
    case "col": {
      if (ctx.group) {
        const k = resolve(ctx.group.row, e);
        const name = ctx.group.row.scope.cols[k].name;
        throw ctx.env.err(`"${name}" isn't in GROUP BY: add it to GROUP BY, or summarise it (e.g. SUM(${e.name}), MAX(${e.name}))`, e.pos);
      }
      return materialize(ctx.scope.cols[resolve(ctx, e)]);
    }
    case "star":
      throw ctx.env.err("* can only be used as SELECT * or COUNT(*)", e.pos);
    case "unary": {
      const a = evalExpr(e.e, ctx);
      if (e.op === "NOT") return not3(toBool(a));
      const x = toNum(a);
      return { t: "num", v: x.v.map((y) => -y), ...(x.fmt && !vecIsDate(x) ? { fmt: x.fmt } : {}) };
    }
    case "bin":
      return evalBin(e, ctx);
    case "isnull": {
      const a = evalExpr(e.e, ctx);
      const r = isNullVec(a);
      return e.not ? not3(r) : r;
    }
    case "between": {
      const a = evalExpr(e.e, ctx);
      const lo = evalExpr(e.lo, ctx);
      const hi = evalExpr(e.hi, ctx);
      const r = and3(compare(">=", a, lo, ctx.n), compare("<=", a, hi, ctx.n), ctx.n);
      return e.not ? not3(r) : r;
    }
    case "in":
      return evalIn(e, ctx);
    case "like":
      return evalLike(e, ctx);
    case "case":
      return evalCase(e, ctx);
    case "cast": {
      const a = evalExpr(e.e, ctx);
      if (e.to === "str") return toStr(a);
      const x = toNum(a);
      if (e.to === "int") return { t: "num", v: x.v.map(Math.trunc) };
      if (e.to === "date") return { t: "num", v: x.v, fmt: DATE_FMT };
      return x;
    }
    case "fn":
      return evalFn(e, ctx);
    case "sub": {
      let v = ctx.env.subMemo.get(e) as Vec | undefined;
      if (!v) {
        const rel = execQuery(e.q, ctx.env.child());
        if (rel.vecs.length !== 1) throw ctx.env.err(`A subquery used as a value must return one column (this one returns ${rel.vecs.length})`, e.pos);
        if (rel.n > 1) throw ctx.env.err(`A subquery used as a value must return at most one row (this one returns ${rel.n})`, e.pos);
        v = rel.n === 0 ? NULL_VEC : gather(rel.vecs[0], Int32Array.of(0));
        ctx.env.subMemo.set(e, v);
      }
      return v;
    }
    case "exists": {
      let v = ctx.env.subMemo.get(e) as Vec | undefined;
      if (!v) {
        const rel = execQuery(e.q, ctx.env.child());
        v = constVec(rel.n > 0);
        ctx.env.subMemo.set(e, v);
      }
      return e.not ? not3(toBool(v)) : v;
    }
  }
}

function isNullVec(a: Vec): Extract<Vec, { t: "bool" }> {
  if (a.t === "null") return { t: "bool", v: Uint8Array.of(1) };
  const n = vlen(a);
  const v = new Uint8Array(n);
  if (a.t === "num") {
    const x = a.v;
    for (let i = 0; i < n; i++) v[i] = x[i] !== x[i] ? 1 : 0;
  } else if (a.t === "bool") {
    const x = a.v;
    for (let i = 0; i < n; i++) v[i] = x[i] === 2 ? 1 : 0;
  } else {
    const x = a.c;
    for (let i = 0; i < n; i++) v[i] = x[i] === 0 ? 1 : 0;
  }
  return { t: "bool", v };
}

// three-valued logic: 0 false, 1 true, 2 unknown
function not3(a: Extract<Vec, { t: "bool" }>): Extract<Vec, { t: "bool" }> {
  const n = a.v.length;
  const v = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = a.v[i];
    v[i] = x === 2 ? 2 : 1 - x;
  }
  return { t: "bool", v };
}
function and3(a: Vec, b: Vec, n: number): Extract<Vec, { t: "bool" }> {
  const x = toBool(a);
  const y = toBool(b);
  const len = vlen(x) === 1 && vlen(y) === 1 ? 1 : n;
  const mx = maskOf(x);
  const my = maskOf(y);
  const v = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const p = x.v[i & mx];
    const q = y.v[i & my];
    v[i] = p === 0 || q === 0 ? 0 : p === 1 && q === 1 ? 1 : 2;
  }
  return { t: "bool", v };
}
function or3(a: Vec, b: Vec, n: number): Extract<Vec, { t: "bool" }> {
  const x = toBool(a);
  const y = toBool(b);
  const len = vlen(x) === 1 && vlen(y) === 1 ? 1 : n;
  const mx = maskOf(x);
  const my = maskOf(y);
  const v = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const p = x.v[i & mx];
    const q = y.v[i & my];
    v[i] = p === 1 || q === 1 ? 1 : p === 0 && q === 0 ? 0 : 2;
  }
  return { t: "bool", v };
}

const outLen = (a: Vec, b: Vec, n: number) => (vlen(a) === 1 && vlen(b) === 1 ? 1 : n);

/** a OP b for = <> < <= > >=, NULL when either side is NULL. */
function compare(op: string, a: Vec, b: Vec, n: number): Extract<Vec, { t: "bool" }> {
  if (a.t === "null" || b.t === "null") return { t: "bool", v: Uint8Array.of(2) };
  const test = (c: number): number => (op === "=" ? +(c === 0) : op === "<>" ? +(c !== 0) : op === "<" ? +(c < 0) : op === "<=" ? +(c <= 0) : op === ">" ? +(c > 0) : +(c >= 0));
  if (a.t === "str" && b.t === "str") {
    const len = outLen(a, b, n);
    // a text column against a constant: once per distinct value
    if (vlen(b) === 1 && len !== 1) {
      const s = b.c[0] ? b.d[b.c[0] - 1] : null;
      if (s === null) return { t: "bool", v: Uint8Array.of(2) };
      return mapDict(a, (x) => !!test(op === "=" || op === "<>" ? (x === s ? 0 : 1) : cmpStr(x, s)), "bool") as Extract<Vec, { t: "bool" }>;
    }
    if (vlen(a) === 1 && len !== 1) {
      const flipped = op === "<" ? ">" : op === "<=" ? ">=" : op === ">" ? "<" : op === ">=" ? "<=" : op;
      return compare(flipped, b, a, n);
    }
    const [ua, ub] = unify([a, b]) as Extract<Vec, { t: "str" }>[];
    const ranks = op === "=" || op === "<>" ? null : dictRanks(ua.d.length ? ua.d : ub.d);
    const ma = maskOf(ua);
    const mb = maskOf(ub);
    const v = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const x = ua.c[i & ma];
      const y = ub.c[i & mb];
      if (x === 0 || y === 0) v[i] = 2;
      else if (!ranks) v[i] = test(x === y ? 0 : 1);
      else v[i] = test(ranks[x] - ranks[y]);
    }
    return { t: "bool", v };
  }
  // numbers (text read as numbers / ISO dates; true = 1)
  const x = toNum(a).v;
  const y = toNum(b).v;
  const len = outLen(a, b, n);
  const mx = x.length === 1 ? 0 : -1;
  const my = y.length === 1 ? 0 : -1;
  const v = new Uint8Array(len);
  switch (op) {
    case "=":
      for (let i = 0; i < len; i++) {
        const p = x[i & mx];
        const q = y[i & my];
        v[i] = p !== p || q !== q ? 2 : p === q ? 1 : 0;
      }
      break;
    case "<>":
      for (let i = 0; i < len; i++) {
        const p = x[i & mx];
        const q = y[i & my];
        v[i] = p !== p || q !== q ? 2 : p !== q ? 1 : 0;
      }
      break;
    case "<":
      for (let i = 0; i < len; i++) {
        const p = x[i & mx];
        const q = y[i & my];
        v[i] = p !== p || q !== q ? 2 : p < q ? 1 : 0;
      }
      break;
    case "<=":
      for (let i = 0; i < len; i++) {
        const p = x[i & mx];
        const q = y[i & my];
        v[i] = p !== p || q !== q ? 2 : p <= q ? 1 : 0;
      }
      break;
    case ">":
      for (let i = 0; i < len; i++) {
        const p = x[i & mx];
        const q = y[i & my];
        v[i] = p !== p || q !== q ? 2 : p > q ? 1 : 0;
      }
      break;
    default:
      for (let i = 0; i < len; i++) {
        const p = x[i & mx];
        const q = y[i & my];
        v[i] = p !== p || q !== q ? 2 : p >= q ? 1 : 0;
      }
  }
  return { t: "bool", v };
}

function evalBin(e: Extract<Expr, { k: "bin" }>, ctx: Ctx): Vec {
  const a = evalExpr(e.l, ctx);
  const b = evalExpr(e.r, ctx);
  const n = ctx.n;
  switch (e.op) {
    case "AND":
      return and3(a, b, n);
    case "OR":
      return or3(a, b, n);
    case "=":
    case "<>":
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compare(e.op, a, b, n);
    case "||":
      return concat2(a, b, n);
  }
  // arithmetic
  if (a.t === "null" || b.t === "null") return NULL_VEC;
  const x = toNum(a);
  const y = toNum(b);
  const len = outLen(x, y, n);
  const xv = x.v;
  const yv = y.v;
  const mx = xv.length === 1 ? 0 : -1;
  const my = yv.length === 1 ? 0 : -1;
  const v = new Float64Array(len);
  switch (e.op) {
    case "+":
      for (let i = 0; i < len; i++) v[i] = xv[i & mx] + yv[i & my];
      break;
    case "-":
      for (let i = 0; i < len; i++) v[i] = xv[i & mx] - yv[i & my];
      break;
    case "*":
      for (let i = 0; i < len; i++) v[i] = xv[i & mx] * yv[i & my];
      break;
    case "/":
      for (let i = 0; i < len; i++) {
        const q = yv[i & my];
        v[i] = q === 0 ? NaN : xv[i & mx] / q;
      }
      break;
    case "%":
      for (let i = 0; i < len; i++) {
        const q = yv[i & my];
        v[i] = q === 0 ? NaN : xv[i & mx] % q;
      }
      break;
  }
  // formats: date ± days stays a date; date - date is a number of days
  const dx = vecIsDate(x);
  const dy = vecIsDate(y);
  let fmt: string | undefined;
  if (e.op === "+" || e.op === "-") {
    if (dx && !dy) fmt = x.fmt;
    else if (dy && !dx && e.op === "+") fmt = y.fmt;
    else if (!dx && !dy) fmt = x.fmt || y.fmt;
  } else if (!dx && !dy) fmt = e.op === "*" || e.op === "/" ? x.fmt || y.fmt : undefined;
  return { t: "num", v, ...(fmt ? { fmt } : {}) };
}

function concat2(a: Vec, b: Vec, n: number): Vec {
  if (a.t === "null" || b.t === "null") return NULL_VEC;
  const x = toStr(a);
  const y = toStr(b);
  const len = outLen(x, y, n);
  if (vlen(y) === 1 && len !== 1) {
    const s = y.c[0] ? y.d[y.c[0] - 1] : null;
    if (s === null) return NULL_VEC;
    return mapDict(x, (t) => t + s, "str");
  }
  if (vlen(x) === 1 && len !== 1) {
    const s = x.c[0] ? x.d[x.c[0] - 1] : null;
    if (s === null) return NULL_VEC;
    return mapDict(y, (t) => s + t, "str");
  }
  const b2 = new StrBuilder();
  const c = new Uint32Array(len);
  const mx = maskOf(x);
  const my = maskOf(y);
  for (let i = 0; i < len; i++) {
    const p = x.c[i & mx];
    const q = y.c[i & my];
    c[i] = p && q ? b2.code(x.d[p - 1] + y.d[q - 1]) : 0;
  }
  return { t: "str", c, d: b2.d };
}

/** x IN (set): true, false, or NULL when x is NULL or not found but the list has a NULL. */
function inSet(x: Vec, list: Vec, k: number, n: number): Extract<Vec, { t: "bool" }> {
  if (x.t === "null") return { t: "bool", v: Uint8Array.of(2) };
  const listB = broadcast(list, k);
  const asStr = x.t === "str" && (listB.t === "str" || listB.t === "null");
  if (asStr) {
    const L = toStr(listB);
    const set = new Set<string>();
    let hasNull = false;
    for (let i = 0; i < k; i++) {
      const c = L.c[L.c.length === 1 ? 0 : i];
      if (c === 0) hasNull = true;
      else set.add(L.d[c - 1]);
    }
    const r = mapDict(x as Extract<Vec, { t: "str" }>, (s) => (set.has(s) ? true : hasNull ? null : false), "bool");
    return r as Extract<Vec, { t: "bool" }>;
  }
  const L = toNum(listB).v;
  const X = toNum(x);
  const set = new Set<number>();
  let hasNull = false;
  for (let i = 0; i < k; i++) {
    const v = L[L.length === 1 ? 0 : i];
    if (v !== v) hasNull = true;
    else set.add(v + 0);
  }
  const len = vlen(X) === 1 ? 1 : n;
  const m = maskOf(X);
  const v = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const p = X.v[i & m];
    v[i] = p !== p ? 2 : set.has(p + 0) ? 1 : hasNull ? 2 : 0;
  }
  return { t: "bool", v };
}

function evalIn(e: Extract<Expr, { k: "in" }>, ctx: Ctx): Vec {
  const x = evalExpr(e.e, ctx);
  let r: Extract<Vec, { t: "bool" }>;
  if (e.sub) {
    let rel = ctx.env.subMemo.get(e.sub) as Rel | undefined;
    if (!rel) {
      rel = execQuery(e.sub, ctx.env.child());
      ctx.env.subMemo.set(e.sub, rel);
    }
    if (rel.vecs.length !== 1) throw ctx.env.err(`The IN subquery must return one column (this one returns ${rel.vecs.length})`, e.sub.pos);
    r = inSet(x, rel.vecs[0], rel.n, ctx.n);
  } else {
    const items = e.list!.map((it) => evalExpr(it, ctx));
    if (items.every((v) => vlen(v) === 1)) {
      // a list of constants
      let list: Vec = items[0];
      let k = 1;
      for (let j = 1; j < items.length; j++) {
        list = concatVecs(list, k, items[j], 1);
        k++;
      }
      r = inSet(x, list, k, ctx.n);
    } else {
      r = compare("=", x, items[0], ctx.n);
      for (let j = 1; j < items.length; j++) r = or3(r, compare("=", x, items[j], ctx.n), ctx.n);
    }
  }
  return e.not ? not3(r) : r;
}

function likeRegex(p: string, ci: boolean, esc?: string): RegExp {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (esc && c === esc && i + 1 < p.length) {
      re += p[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, ci ? "i" : "");
}

function evalLike(e: Extract<Expr, { k: "like" }>, ctx: Ctx): Vec {
  const x = evalExpr(e.e, ctx);
  const p = evalExpr(e.pat, ctx);
  if (x.t === "null" || p.t === "null") return { t: "bool", v: Uint8Array.of(2) };
  const xs = toStr(x);
  const ps = toStr(p);
  let r: Extract<Vec, { t: "bool" }>;
  if (vlen(ps) === 1) {
    const pat = ps.c[0] ? ps.d[ps.c[0] - 1] : null;
    if (pat === null) return { t: "bool", v: Uint8Array.of(2) };
    const re = likeRegex(pat, e.ci, e.esc);
    r = mapDict(xs, (s) => re.test(s), "bool") as Extract<Vec, { t: "bool" }>;
  } else {
    const cache = new Map<string, RegExp>();
    const len = outLen(xs, ps, ctx.n);
    const v = new Uint8Array(len);
    const mx = maskOf(xs);
    for (let i = 0; i < len; i++) {
      const a = xs.c[i & mx];
      const b = ps.c[i];
      if (!a || !b) {
        v[i] = 2;
        continue;
      }
      const pat = ps.d[b - 1];
      let re = cache.get(pat);
      if (!re) cache.set(pat, (re = likeRegex(pat, e.ci, e.esc)));
      v[i] = re.test(xs.d[a - 1]) ? 1 : 0;
    }
    r = { t: "bool", v };
  }
  return e.not ? not3(r) : r;
}

function evalCase(e: Extract<Expr, { k: "case" }>, ctx: Ctx): Vec {
  const n = ctx.n;
  const base = e.base ? evalExpr(e.base, ctx) : null;
  const conds = e.whens.map((w) => {
    const c = evalExpr(w.when, ctx);
    return base ? compare("=", base, c, n) : toBool(c);
  });
  const vals = e.whens.map((w) => evalExpr(w.then, ctx));
  const els = e.else ? evalExpr(e.else, ctx) : NULL_VEC;
  const all = [...vals, els];
  const len = conds.every((c) => vlen(c) === 1) && all.every((v) => vlen(v) === 1) ? 1 : n;
  const pick = new Int32Array(len);
  const masks = conds.map(maskOf);
  for (let i = 0; i < len; i++) {
    let k = 0;
    for (; k < conds.length; k++) if (conds[k].v[i & masks[k]] === 1) break;
    pick[i] = k;
  }
  return choose(pick, all, len);
}

function evalFn(e: Extract<Expr, { k: "fn" }>, ctx: Ctx): Vec {
  const name = e.name;
  if (e.over) return evalWindow(e, ctx);
  if (WINDOW_ONLY.has(name)) throw ctx.env.err(`${name}() needs OVER (...), e.g. ${name}() OVER (ORDER BY date)`, e.pos);
  if (AGGREGATES.has(name)) {
    if (!ctx.group) {
      if (ctx.clause === "AGG") throw ctx.env.err(`An aggregate can't be inside another aggregate (${name} inside an aggregate); use a subquery`, e.pos);
      throw ctx.env.err(`${name}() can't be used in ${ctx.clause}${ctx.clause === "WHERE" ? "; use HAVING after GROUP BY to filter on totals" : ""}`, e.pos);
    }
    let v = ctx.memo.get(e);
    if (v) return v;
    const row = { ...ctx.group.row, clause: "AGG" };
    if (e.star && name !== "COUNT") throw ctx.env.err(`${name}(*) isn't allowed; only COUNT(*)`, e.pos);
    const want = name === "STRING_AGG" || name === "LISTAGG" || name === "GROUP_CONCAT" ? [1, 2] : [1, 1];
    if (!e.star && (e.args.length < want[0] || e.args.length > want[1])) throw ctx.env.err(`${name}() takes ${want[0] === want[1] ? want[0] : `${want[0]} or ${want[1]}`} argument${want[1] > 1 ? "s" : ""}`, e.pos);
    const arg = e.star ? null : evalExpr(e.args[0], row);
    let sep: string | undefined;
    if (e.args[1]) {
      const s = evalExpr(e.args[1], row);
      if (vlen(s) !== 1) throw ctx.env.err("The separator must be a constant, like ', '", e.args[1].pos);
      sep = String(valueAt(s, 0) ?? "");
    }
    const g = ctx.group.g;
    v = aggregate({ name, arg, distinct: e.distinct, sep }, g.gid, g.ng, ctx.group.row.n, g.first);
    ctx.memo.set(e, v);
    return v;
  }
  if (e.distinct) throw ctx.env.err(`DISTINCT only goes inside aggregates such as COUNT(DISTINCT x)`, e.pos);
  const args = e.args.map((a) => evalExpr(a, ctx));
  const n = ctx.n;
  const nargs = (min: number, max = min) => {
    if (args.length < min || args.length > max) throw ctx.env.err(`${name}() takes ${min === max ? min : max === Infinity ? `at least ${min}` : `${min} to ${max}`} argument${max === 1 ? "" : "s"}`, e.pos);
  };
  switch (name) {
    case "COALESCE":
    case "IFNULL":
    case "NVL": {
      nargs(1, name === "COALESCE" ? Infinity : 2);
      const u = unify(args);
      const len = u.every((v) => vlen(v) === 1) ? 1 : n;
      const nulls = u.map((v) => isNullVec(v));
      const pick = new Int32Array(len).fill(-1);
      for (let i = 0; i < len; i++) {
        for (let k = 0; k < u.length; k++) {
          if (nulls[k].v[i & maskOf(nulls[k])] === 0) {
            pick[i] = k;
            break;
          }
        }
      }
      return choose(pick, u, len);
    }
    case "NULLIF": {
      nargs(2);
      const eq = compare("=", args[0], args[1], n);
      const len = vlen(eq) === 1 && vlen(args[0]) === 1 ? 1 : n;
      const pick = new Int32Array(len);
      const m = maskOf(eq);
      for (let i = 0; i < len; i++) pick[i] = eq.v[i & m] === 1 ? -1 : 0;
      return choose(pick, [args[0]], len);
    }
    case "GREATEST":
    case "LEAST": {
      nargs(1, Infinity);
      let best = args[0];
      for (let k = 1; k < args.length; k++) {
        const c = compare(name === "GREATEST" ? ">" : "<", args[k], best, n);
        const bothNull = isNullVec(best);
        const len = vlen(c) === 1 && vlen(best) === 1 && vlen(args[k]) === 1 ? 1 : n;
        const pick = new Int32Array(len);
        for (let i = 0; i < len; i++) pick[i] = c.v[i & maskOf(c)] === 1 || bothNull.v[i & maskOf(bothNull)] === 1 ? 1 : 0;
        best = choose(pick, [best, args[k]], len);
      }
      return best;
    }
    case "__DISTINCT":
    case "__NOTDISTINCT": {
      // IS [NOT] DISTINCT FROM: NULLs compare equal, never unknown
      const eq = compare("=", args[0], args[1], n);
      const na = isNullVec(args[0]);
      const nb = isNullVec(args[1]);
      const len = vlen(eq) === 1 && vlen(na) === 1 && vlen(nb) === 1 ? 1 : n;
      const v = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const x = na.v[i & maskOf(na)];
        const y = nb.v[i & maskOf(nb)];
        const same = x && y ? 1 : x || y ? 0 : eq.v[i & maskOf(eq)] === 1 ? 1 : 0;
        v[i] = name === "__NOTDISTINCT" ? same : 1 - same;
      }
      return { t: "bool", v };
    }
    case "CURRENT_DATE":
    case "TODAY": {
      nargs(0);
      const d = new Date();
      const serial = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86_400_000);
      return constVec(serial, DATE_FMT);
    }
  }
  const def = SCALAR[name];
  if (!def) throw ctx.env.err(`There's no function ${name}()`, e.pos);
  const min = def.min ?? def.args.length;
  const max = def.rest ? Infinity : def.args.length;
  nargs(min, max);
  try {
    return callScalar(def, args, n);
  } catch (err) {
    if (err instanceof SqlError) throw err;
    throw ctx.env.err((err as Error).message, e.pos);
  }
}

// --------------------------------------------------------------- window --

function evalWindow(e: Extract<Expr, { k: "fn" }>, ctx: Ctx): Vec {
  const cached = ctx.memo.get(e);
  if (cached) return cached;
  const name = e.name;
  const spec = e.over!;
  const n = ctx.n;
  if (!WINDOW_ONLY.has(name) && !AGGREGATES.has(name)) throw ctx.env.err(`${name}() can't be used with OVER`, e.pos);
  if (e.distinct) throw ctx.env.err(`DISTINCT inside a window function isn't supported`, e.pos);
  if (["MEDIAN", "STRING_AGG", "LISTAGG", "GROUP_CONCAT"].includes(name) || name.startsWith("STD") || name.startsWith("VAR")) throw ctx.env.err(`${name}() OVER (...) isn't supported; use it with GROUP BY`, e.pos);
  const parts = spec.partition.map((p) => evalExpr(p, ctx));
  const pg = groupRows(parts, n);
  const pid: Vec = { t: "num", v: Float64Array.from(pg.gid) };
  const order = spec.order.map((o) => ({ vec: evalExpr(o.e, ctx), desc: o.desc, nullsFirst: o.nullsFirst }));
  const perm = sortRows([{ vec: pid, desc: false }, ...order], n);
  // peers: rows equal on all ORDER BY keys
  const okeys = order.map((o) => sortKeyOf(o.vec, n));
  const samePeer = (a: number, b: number) => okeys.every((k) => k.nulls[a] === k.nulls[b] && (k.nulls[a] === 1 || k.keys[a] === k.keys[b]));
  const pgid = pg.gid;

  const arg = e.args[0] ? evalExpr(e.args[0], ctx) : null;
  const out = new Float64Array(n);
  const src = new Int32Array(n).fill(-1); // for functions that pick a row
  let picks = false;
  let defaultMask: Uint8Array | null = null;

  // walk partitions
  let s = 0;
  while (s < n) {
    let end = s + 1;
    while (end < n && pgid[perm[end]] === pgid[perm[s]]) end++;
    // peer group bounds per position
    const peerStart = new Int32Array(end - s);
    const peerEnd = new Int32Array(end - s);
    for (let k = s; k < end; k++) peerStart[k - s] = k > s && samePeer(perm[k], perm[k - 1]) ? peerStart[k - s - 1] : k;
    for (let k = end - 1; k >= s; k--) peerEnd[k - s] = k < end - 1 && samePeer(perm[k], perm[k + 1]) ? peerEnd[k - s + 1] : k + 1;
    switch (name) {
      case "ROW_NUMBER":
        for (let k = s; k < end; k++) out[perm[k]] = k - s + 1;
        break;
      case "RANK":
        for (let k = s; k < end; k++) out[perm[k]] = peerStart[k - s] - s + 1;
        break;
      case "DENSE_RANK": {
        let r = 0;
        for (let k = s; k < end; k++) {
          if (peerStart[k - s] === k) r++;
          out[perm[k]] = r;
        }
        break;
      }
      case "NTILE": {
        const b = arg ? Math.trunc(valueAt(toNum(arg), 0) as number) : NaN;
        if (!(b > 0)) throw ctx.env.err("NTILE needs a positive number of buckets", e.pos);
        const size = end - s;
        const small = Math.floor(size / b);
        const big = size % b;
        for (let k = s; k < end; k++) {
          const i = k - s;
          out[perm[k]] = i < big * (small + 1) ? Math.floor(i / (small + 1)) + 1 : big + Math.floor((i - big * (small + 1)) / Math.max(1, small)) + 1;
        }
        break;
      }
      case "LAG":
      case "LEAD": {
        if (!arg) throw ctx.env.err(`${name}() needs a column, e.g. ${name}(amount)`, e.pos);
        const offV = e.args[1] ? evalExpr(e.args[1], ctx) : constVec(1);
        if (vlen(offV) !== 1) throw ctx.env.err(`The ${name} offset must be a constant`, e.args[1]!.pos);
        const off = Math.trunc((valueAt(toNum(offV), 0) as number | null) ?? 1) * (name === "LAG" ? -1 : 1);
        picks = true;
        if (e.args[2] && !defaultMask) defaultMask = new Uint8Array(n);
        for (let k = s; k < end; k++) {
          const j = k + off;
          if (j >= s && j < end) src[perm[k]] = perm[j];
          else if (defaultMask) defaultMask[perm[k]] = 1;
        }
        break;
      }
      default: {
        // aggregate over a frame
        const frame = spec.frame;
        const hasOrder = spec.order.length > 0;
        const bounds = (k: number): [number, number] => {
          if (!frame) return hasOrder ? [s, peerEnd[k - s]] : [s, end];
          const at = (b: typeof frame.start, isEnd: boolean): number => {
            if (b.kind === "unbounded") return b.dir < 0 ? s : end;
            if (b.kind === "current") {
              if (frame.rows) return isEnd ? k + 1 : k;
              return isEnd ? peerEnd[k - s] : peerStart[k - s];
            }
            const p = k + b.dir * b.n;
            return isEnd ? p + 1 : p;
          };
          const fs = Math.max(s, Math.min(end, at(frame.start, false)));
          const fe = Math.max(s, Math.min(end, at(frame.end, true)));
          return [fs, Math.max(fs, fe)];
        };
        windowAgg(name, e.star ? null : arg, perm, s, end, bounds, out, src);
        if (name === "FIRST_VALUE" || name === "LAST_VALUE" || ((name === "MIN" || name === "MAX") && arg && arg.t === "str")) picks = true;
      }
    }
    s = end;
  }
  let v: Vec;
  if (picks) {
    v = gather(arg!, src);
    if (defaultMask) {
      const def = evalExpr(e.args[2]!, ctx);
      const pick = Int32Array.from(defaultMask);
      v = choose(pick, [v, def], n);
    }
  } else {
    const fmt = (name === "SUM" || name === "AVG" || name === "MIN" || name === "MAX") && arg && arg.t === "num" ? arg.fmt : undefined;
    v = { t: "num", v: out, ...(fmt ? { fmt } : {}) };
  }
  ctx.memo.set(e, v);
  return v;
}

function windowAgg(name: string, arg: Vec | null, perm: Int32Array, s: number, end: number, bounds: (k: number) => [number, number], out: Float64Array, src: Int32Array): void {
  const len = end - s;
  if (name === "FIRST_VALUE" || name === "LAST_VALUE") {
    for (let k = s; k < end; k++) {
      const [fs, fe] = bounds(k);
      src[perm[k]] = fe > fs ? perm[name === "FIRST_VALUE" ? fs : fe - 1] : -1;
    }
    return;
  }
  if (name === "COUNT" && !arg) {
    for (let k = s; k < end; k++) {
      const [fs, fe] = bounds(k);
      out[perm[k]] = fe - fs;
    }
    return;
  }
  if (!arg) throw new Error(`${name}() needs an argument`);
  // text MIN / MAX by rank
  let vals: Float64Array;
  const strArg = arg.t === "str";
  if (strArg && (name === "MIN" || name === "MAX")) {
    const ranks = dictRanks(arg.d);
    const m = maskOf(arg);
    vals = new Float64Array(len);
    for (let k = s; k < end; k++) {
      const c = arg.c[perm[k] & m];
      vals[k - s] = c ? ranks[c] : NaN;
    }
  } else if (name === "COUNT") {
    const m = maskOf(arg);
    vals = new Float64Array(len);
    for (let k = s; k < end; k++) {
      const r = perm[k];
      const isNull = arg.t === "null" || (arg.t === "num" ? arg.v[r & m] !== arg.v[r & m] : arg.t === "str" ? arg.c[r & m] === 0 : arg.v[r & m] === 2);
      vals[k - s] = isNull ? NaN : 1;
    }
  } else {
    const x = toNum(arg);
    const m = maskOf(x);
    vals = new Float64Array(len);
    for (let k = s; k < end; k++) vals[k - s] = x.v[perm[k] & m];
  }
  if (name === "SUM" || name === "AVG" || name === "COUNT") {
    // prefix sums from the partition start (running totals stay exact in cents)
    const ps = new Float64Array(len + 1);
    const pc = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) {
      const x = vals[i];
      ps[i + 1] = x === x ? ps[i] + x : ps[i];
      pc[i + 1] = x === x ? pc[i] + 1 : pc[i];
    }
    for (let k = s; k < end; k++) {
      const [fs, fe] = bounds(k);
      const c = pc[fe - s] - pc[fs - s];
      const sum = fs === s ? ps[fe - s] : ps[fe - s] - ps[fs - s];
      out[perm[k]] = name === "COUNT" ? c : c === 0 ? NaN : name === "SUM" ? sum : sum / c;
    }
    return;
  }
  if (name === "MIN" || name === "MAX") {
    const max = name === "MAX";
    const better = (x: number, best: number) => x === x && (best !== best || (max ? x > best : x < best));
    let runFe = s;
    let run = NaN;
    let runAt = -1;
    for (let k = s; k < end; k++) {
      const [fs, fe] = bounds(k);
      let best = NaN;
      let at = -1;
      if (fs === s && fe >= runFe) {
        // frames that start at the partition start grow: keep a running best
        for (let j = runFe; j < fe; j++) {
          if (better(vals[j - s], run)) {
            run = vals[j - s];
            runAt = j;
          }
        }
        runFe = fe;
        best = run;
        at = runAt;
      } else {
        for (let j = fs; j < fe; j++) {
          if (better(vals[j - s], best)) {
            best = vals[j - s];
            at = j;
          }
        }
      }
      if (strArg) src[perm[k]] = at >= 0 ? perm[at] : -1;
      else out[perm[k]] = best;
    }
    return;
  }
  if (name === "ANY_VALUE" || name === "FIRST") {
    for (let k = s; k < end; k++) {
      const [fs, fe] = bounds(k);
      out[perm[k]] = fe > fs ? vals[fs - s] : NaN;
    }
    return;
  }
  throw new Error(`${name}() OVER isn't supported`);
}

// ----------------------------------------------------------------- FROM --

function evalFrom(f: From, env: Env): Scope {
  switch (f.k) {
    case "table": {
      const rel = env.table(f.name, f.pos);
      return relScope(rel, f.alias ?? f.name);
    }
    case "sub": {
      const rel = execQuery(f.q, env.child());
      return relScope(rel, f.alias ?? "");
    }
    case "join":
      return evalJoin(f, env);
  }
}

/** Which side of a join the columns of an expression come from: 1 left, 2 right, 3 both, 0 none. */
function sidesOf(e: Expr, L: Scope, R: Scope): number {
  let sides = 0;
  const walk = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (o.k === "sub" || o.k === "exists") {
      sides |= 4; // subqueries: evaluate as a filter
      return;
    }
    if (o.k === "col") {
      const c = o as unknown as Extract<Expr, { k: "col" }>;
      if (findCols(L, c.table, c.name).length) sides |= 1;
      if (findCols(R, c.table, c.name).length) sides |= 2;
      return;
    }
    if (o.k === "fn" && (o.over || AGGREGATES.has(o.name as string))) sides |= 4;
    for (const [key, v] of Object.entries(o)) {
      if (key === "sub" || key === "q") continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(e);
  return sides;
}

function conjuncts(e: Expr): Expr[] {
  return e.k === "bin" && e.op === "AND" ? [...conjuncts(e.l), ...conjuncts(e.r)] : [e];
}

/** Growable pair buffers. */
class Pairs {
  l = new Int32Array(1024);
  r = new Int32Array(1024);
  n = 0;
  constructor(private max: number, private onTooMany: () => never) {}
  push(a: number, b: number): void {
    if (this.n === this.l.length) {
      if (this.n >= this.max) this.onTooMany();
      const l = new Int32Array(this.n * 2);
      l.set(this.l);
      this.l = l;
      const r = new Int32Array(this.n * 2);
      r.set(this.r);
      this.r = r;
    }
    this.l[this.n] = a;
    this.r[this.n++] = b;
  }
  done(): { l: Int32Array; r: Int32Array } {
    return { l: this.l.slice(0, this.n), r: this.r.slice(0, this.n) };
  }
}

function joinScope(L: Scope, R: Scope, li: Int32Array, ri: Int32Array): Scope {
  const l = restrict(L, li);
  const r = restrict(R, ri);
  return { n: li.length, cols: [...l.cols, ...r.cols], tables: new Set([...L.tables, ...R.tables]) };
}

function evalJoin(f: Extract<From, { k: "join" }>, env: Env): Scope {
  const L = evalFrom(f.l, env);
  const R = evalFrom(f.r, env);
  for (const t of R.tables) if (t && L.tables.has(t)) throw env.err(`The name ${t} is used for two tables; give one an alias, e.g. JOIN ${t} AS ${t}2`, f.r.pos);
  const keepL = f.type === "left" || f.type === "full";
  const keepR = f.type === "right" || f.type === "full";
  const tooMany = (): never => {
    throw env.err(`This join makes more than ${env.maxRows.toLocaleString()} rows; check the ON condition (are the keys unique?)`, f.pos);
  };
  // split ON into equalities between the sides and the rest
  const lk: Expr[] = [];
  const rk: Expr[] = [];
  const rest: Expr[] = [];
  if (f.using) {
    for (const name of f.using) {
      const col: Expr = { k: "col", name, pos: f.pos, end: f.pos };
      lk.push(col);
      rk.push(col);
    }
  }
  if (f.on) {
    for (const c of conjuncts(f.on)) {
      if (c.k === "bin" && c.op === "=") {
        const a = sidesOf(c.l, L, R);
        const b = sidesOf(c.r, L, R);
        if (a === 1 && b === 2) {
          lk.push(c.l);
          rk.push(c.r);
          continue;
        }
        if (a === 2 && b === 1) {
          lk.push(c.r);
          rk.push(c.l);
          continue;
        }
      }
      if (hasAgg(c)) throw env.err("Aggregates can't be used in ON", c.pos);
      rest.push(c);
    }
  }
  const pairs = new Pairs(env.maxRows, tooMany);
  if (lk.length) {
    const lv = lk.map((e) => evalExpr(e, rowCtx(env, L, "ON")));
    const rv = rk.map((e) => evalExpr(e, rowCtx(env, R, "ON")));
    const { l, r, card } = joinKeyIds(lv, L.n, rv, R.n);
    // bucket the right side by key id
    const start = new Int32Array(card + 1);
    for (let j = 0; j < R.n; j++) if (r[j] >= 0) start[r[j] + 1]++;
    for (let k = 0; k < card; k++) start[k + 1] += start[k];
    const fill = start.slice(0, card);
    const rows = new Int32Array(start[card]);
    for (let j = 0; j < R.n; j++) if (r[j] >= 0) rows[fill[r[j]]++] = j;
    for (let i = 0; i < L.n; i++) {
      const id = l[i];
      if (id < 0) continue;
      for (let p = start[id]; p < start[id + 1]; p++) pairs.push(i, rows[p]);
    }
  } else {
    if (L.n * R.n > env.maxRows * 20) throw env.err(`Joining ${L.n.toLocaleString()} by ${R.n.toLocaleString()} rows without an equality (a.key = b.key) is too slow; add one to ON`, f.pos);
    // nested loops, a block of left rows at a time, filtering as we go
    const block = Math.max(1, Math.floor(1_000_000 / Math.max(1, R.n)));
    for (let i0 = 0; i0 < L.n; i0 += block) {
      const i1 = Math.min(L.n, i0 + block);
      const li = new Int32Array((i1 - i0) * R.n);
      const ri = new Int32Array((i1 - i0) * R.n);
      let k = 0;
      for (let i = i0; i < i1; i++) {
        for (let j = 0; j < R.n; j++) {
          li[k] = i;
          ri[k++] = j;
        }
      }
      if (rest.length) {
        const keep = filterPairs(env, L, R, li, ri, rest);
        for (let p = 0; p < keep.length; p++) pairs.push(li[keep[p]], ri[keep[p]]);
      } else for (let p = 0; p < k; p++) pairs.push(li[p], ri[p]);
    }
    rest.length = 0;
  }
  let { l: pl, r: pr } = pairs.done();
  if (rest.length && pl.length) {
    const keep = filterPairs(env, L, R, pl, pr, rest);
    pl = gatherInt(pl, keep);
    pr = gatherInt(pr, keep);
  }
  if (!keepL && !keepR) return joinScope(L, R, pl, pr);
  // outer: left rows in order, each with its matches or a NULL row; then unmatched right rows
  const out = new Pairs(env.maxRows, tooMany);
  const matchedR = keepR ? new Uint8Array(R.n) : null;
  let p = 0;
  for (let i = 0; i < L.n; i++) {
    const p0 = p;
    while (p < pl.length && pl[p] === i) {
      out.push(i, pr[p]);
      if (matchedR) matchedR[pr[p]] = 1;
      p++;
    }
    if (p === p0 && keepL) out.push(i, -1);
  }
  if (matchedR) for (let j = 0; j < R.n; j++) if (!matchedR[j]) out.push(-1, j);
  const o = out.done();
  return joinScope(L, R, o.l, o.r);
}

function filterPairs(env: Env, L: Scope, R: Scope, li: Int32Array, ri: Int32Array, rest: Expr[]): Int32Array {
  const ctx = rowCtx(env, joinScope(L, R, li, ri), "ON");
  let b: Vec = toBool(evalExpr(rest[0], ctx));
  for (let k = 1; k < rest.length; k++) b = and3(b, evalExpr(rest[k], ctx), ctx.n);
  return selectRows(toBool(b), ctx.n);
}

function gatherInt(a: Int32Array, idx: Int32Array): Int32Array {
  const out = new Int32Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = a[idx[i]];
  return out;
}

// --------------------------------------------------------------- SELECT --

interface Item {
  e?: Expr;
  /** a column straight from the scope (SELECT *) */
  col?: number;
  name: string;
}

function execQuery(q: Query, parentEnv: Env): Rel {
  const env = q.with.length ? parentEnv.child() : parentEnv;
  for (const c of q.with) env.addCte(c.name, c.q, c.pos);
  if (q.body.k === "select") return execSelect(q.body, env, q);
  let rel = execBody(q.body, env);
  if (q.order.length) {
    const scope = relScope(rel, "");
    const ctx = rowCtx(env, scope, "ORDER BY");
    const keys: SortKey[] = q.order.map((o) => {
      const ord = ordinal(o.e, rel.vecs.length, env);
      return { vec: ord >= 0 ? rel.vecs[ord] : evalExpr(o.e, ctx), desc: o.desc, nullsFirst: o.nullsFirst };
    });
    const perm = sortRows(keys, rel.n, undefined, topOf(q, env));
    rel = { names: rel.names, vecs: rel.vecs.map((v) => gather(broadcast(v, rel.n), perm)), n: rel.n };
  }
  return limitRel(rel, q, env);
}

function ordinal(e: Expr, count: number, env: Env): number {
  if (e.k !== "lit" || typeof e.v !== "number") return -1;
  if (!Number.isInteger(e.v) || e.v < 1 || e.v > count) throw env.err(`ORDER BY ${e.v}: there are ${count} columns, so use 1 to ${count}`, e.pos);
  return e.v - 1;
}

function constInt(e: Expr | undefined, env: Env, what: string): number | null {
  if (!e) return null;
  const v = evalExpr(e, rowCtx(env, { n: 1, cols: [], tables: new Set() }, what));
  const x = valueAt(toNum(v), 0) as number | null;
  if (x === null || !Number.isInteger(x) || x < 0) throw env.err(`${what} needs a whole number of rows, 0 or more`, e.pos);
  return x;
}

/** With LIMIT, the rows a sort has to put in order (OFFSET + LIMIT). */
function topOf(q: Query, env: Env): number | undefined {
  const limit = constInt(q.limit, env, "LIMIT");
  return limit === null ? undefined : (constInt(q.offset, env, "OFFSET") ?? 0) + limit;
}

function limitRel(rel: Rel, q: Query, env: Env): Rel {
  const limit = constInt(q.limit, env, "LIMIT");
  const offset = constInt(q.offset, env, "OFFSET") ?? 0;
  if (limit === null && !offset) return rel;
  const from = Math.min(rel.n, offset);
  const to = limit === null ? rel.n : Math.min(rel.n, from + limit);
  const idx = Int32Array.from({ length: to - from }, (_, i) => from + i);
  return { names: rel.names, vecs: rel.vecs.map((v) => gather(broadcast(v, rel.n), idx)), n: idx.length };
}

function execBody(b: QueryBody, env: Env): Rel {
  if (b.k === "select") return execSelect(b, env, null);
  if (b.k === "paren") return execQuery(b.q, env.child());
  const l = execBody(b.l, env);
  const r = execBody(b.r, env);
  if (l.vecs.length !== r.vecs.length) throw env.err(`Both sides of ${b.op.toUpperCase()} must have the same number of columns (${l.vecs.length} and ${r.vecs.length})`, b.pos);
  const n = l.n + r.n;
  const vecs = l.vecs.map((v, k) => concatVecs(v, l.n, r.vecs[k], r.n));
  if (b.op === "union") {
    const rel = { names: l.names, vecs, n };
    if (b.all) return rel;
    const g = groupRows(vecs, n);
    return { names: l.names, vecs: vecs.map((v) => gather(v, g.first)), n: g.ng };
  }
  // EXCEPT / INTERSECT: number the rows of both sides together
  const g = groupRows(vecs, n);
  const inRight = new Uint8Array(g.ng);
  for (let i = l.n; i < n; i++) inRight[g.gid[i]] = 1;
  const keep: number[] = [];
  if (b.all) {
    // multiset: count right occurrences per group
    const rightCount = new Int32Array(g.ng);
    for (let i = l.n; i < n; i++) rightCount[g.gid[i]]++;
    for (let i = 0; i < l.n; i++) {
      const gg = g.gid[i];
      if (b.op === "except") {
        if (rightCount[gg] > 0) rightCount[gg]--;
        else keep.push(i);
      } else if (rightCount[gg] > 0) {
        rightCount[gg]--;
        keep.push(i);
      }
    }
  } else {
    const done = new Uint8Array(g.ng);
    for (let i = 0; i < l.n; i++) {
      const gg = g.gid[i];
      if (done[gg]) continue;
      done[gg] = 1;
      if ((b.op === "except") !== !!inRight[gg]) keep.push(i);
    }
  }
  const idx = Int32Array.from(keep);
  return { names: l.names, vecs: vecs.map((v) => gather(v, idx)), n: idx.length };
}

function execSelect(sel: Select, env: Env, q: Query | null): Rel {
  let scope: Scope = sel.from ? evalFrom(sel.from, env) : { n: 1, cols: [], tables: new Set() };
  if (sel.where) {
    if (hasAgg(sel.where)) {
      const at = findAgg(sel.where);
      throw env.err(`${at?.name ?? "Aggregate"}() can't be used in WHERE; use HAVING after GROUP BY to filter on totals`, at?.pos ?? sel.where.pos);
    }
    const ctx = rowCtx(env, scope, "WHERE");
    const b = toBool(evalExpr(sel.where, ctx));
    scope = restrict(scope, selectRows(b, scope.n));
  }
  const ctx = rowCtx(env, scope, "SELECT");

  // the select list, with * expanded
  const items: Item[] = [];
  for (const it of sel.items) {
    if (it.e.k === "star") {
      const t = it.e.table?.toLowerCase();
      if (t !== undefined && !scope.tables.has(t)) throw env.err(`There's no table or alias "${it.e.table}" in this query`, it.e.pos);
      if (!sel.from) throw env.err("SELECT * needs FROM", it.e.pos);
      scope.cols.forEach((c, k) => {
        if (t === undefined || c.table === t) items.push({ col: k, name: c.name });
      });
      continue;
    }
    const name = it.alias ?? (it.e.k === "col" ? scope.cols[resolveSafe(ctx, it.e)]?.name ?? it.e.name : env.sql.slice(it.e.pos, it.e.end).replace(/\s+/g, " "));
    items.push({ e: it.e, name });
  }
  const order = q?.order ?? [];

  // GROUP BY items may name a select alias or position
  const groupBy = sel.groupBy.map((g) => {
    if (g.k === "lit" && typeof g.v === "number") {
      const k = ordinal(g, items.length, env);
      const it = items[k];
      return it.e ?? ({ k: "col", table: scope.cols[it.col!].table || undefined, name: scope.cols[it.col!].name, pos: g.pos, end: g.end } as Expr);
    }
    if (g.k === "col" && !g.table && !findCols(scope, undefined, g.name).length) {
      const alias = sel.items.find((it) => it.alias && it.alias.toLowerCase() === g.name.toLowerCase());
      if (alias) return alias.e;
    }
    return g;
  });

  const grouped = groupBy.length > 0 || sel.items.some((it) => hasAgg(it.e)) || hasAgg(sel.having) || order.some((o) => hasAgg(o.e));
  let out: Ctx = ctx;
  if (grouped) {
    for (const g of groupBy) if (hasAgg(g)) throw env.err("GROUP BY can't contain an aggregate such as SUM()", g.pos);
    const gctx = { ...ctx, clause: "GROUP BY" };
    const keyVecs = groupBy.map((g) => evalExpr(g, gctx));
    let g = groupRows(keyVecs, scope.n);
    if (!groupBy.length) g = { gid: new Int32Array(scope.n), ng: 1, first: new Int32Array(1) };
    const keyMap = (gr: Groups) => {
      const m = new Map<string, Vec>();
      groupBy.forEach((e, k) => m.set(exprKey(e, ctx), gather(keyVecs[k], gr.first)));
      return m;
    };
    out = { env, n: g.ng, scope, memo: new Map(), clause: "SELECT", group: { g, keys: keyMap(g), row: ctx } };
    if (sel.having) {
      const b = toBool(evalExpr(sel.having, { ...out, clause: "HAVING" }));
      const keep = selectRows(b, g.ng);
      if (keep.length < g.ng) {
        const remap = new Int32Array(g.ng).fill(-1);
        keep.forEach((gg, k) => (remap[gg] = k));
        const gid = g.gid.map((x) => (x < 0 ? -1 : remap[x]));
        const first = gatherInt(g.first, keep);
        g = { gid, ng: keep.length, first };
        out = { env, n: g.ng, scope, memo: new Map(), clause: "SELECT", group: { g, keys: keyMap(g), row: ctx } };
      }
    }
  } else if (sel.having) throw env.err("HAVING needs GROUP BY (or an aggregate such as SUM())", sel.having.pos);

  const vecs = items.map((it) => {
    if (it.col !== undefined) {
      if (out.group) {
        const hit = out.group.keys.get(`"#${it.col}"`);
        if (!hit) throw env.err(`"${scope.cols[it.col].name}" isn't in GROUP BY; list the columns instead of *`, sel.pos);
        return hit;
      }
      return materialize(scope.cols[it.col]);
    }
    return evalExpr(it.e!, out);
  });
  const names = items.map((it) => it.name);
  const N = out.n;

  // ORDER BY: a position, an output name, or an expression
  const keys: SortKey[] = order.map((o) => {
    const ord = ordinal(o.e, items.length, env);
    if (ord >= 0) return { vec: vecs[ord], desc: o.desc, nullsFirst: o.nullsFirst };
    if (o.e.k === "col" && !o.e.table) {
      const nm = o.e.name.toLowerCase();
      const hits = names.map((x, k) => (x.toLowerCase() === nm ? k : -1)).filter((k) => k >= 0);
      if (hits.length === 1) return { vec: vecs[hits[0]], desc: o.desc, nullsFirst: o.nullsFirst };
    }
    return { vec: evalExpr(o.e, { ...out, clause: "ORDER BY" }), desc: o.desc, nullsFirst: o.nullsFirst };
  });

  let rows: Int32Array | undefined;
  if (sel.distinct) rows = groupRows(vecs, N).first;
  if (keys.length) rows = sortRows(keys, N, rows, q ? topOf(q, env) : undefined);
  let rel: Rel;
  if (rows) rel = { names, vecs: vecs.map((v) => gather(broadcast(v, N), rows!)), n: rows.length };
  else rel = { names, vecs: vecs.map((v) => broadcast(v, N)), n: N };
  return q ? limitRel(rel, q, env) : rel;
}

function resolveSafe(ctx: Ctx, e: Extract<Expr, { k: "col" }>): number {
  try {
    return resolve(ctx, e);
  } catch {
    return -1;
  }
}

function findAgg(e: Expr): Extract<Expr, { k: "fn" }> | null {
  let found: Extract<Expr, { k: "fn" }> | null = null;
  const walk = (x: unknown): void => {
    if (found || !x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (o.k === "sub" || o.k === "exists") return;
    if (o.k === "fn" && AGGREGATES.has(o.name as string) && !o.over) {
      found = o as unknown as Extract<Expr, { k: "fn" }>;
      return;
    }
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(e);
  return found;
}

// --------------------------------------------------------------- output --

function toColumn(name: string, v: Vec, n: number, env: Env): { col: ColumnData; fmt: string } {
  const b = broadcast(v, n);
  switch (b.t) {
    case "num":
      return { col: { kind: "number", name, values: env.inputs.has(b.v) ? b.v.slice() : b.v }, fmt: b.fmt ?? "" };
    case "bool": {
      const s = toStr(b);
      return { col: { kind: "string", name, codes: s.c, dict: s.d.slice() }, fmt: "" };
    }
    case "str": {
      // drop dictionary entries the result doesn't use
      if (b.d.length > 64 && b.d.length > n) {
        const sb = new StrBuilder();
        const remap = new Uint32Array(b.d.length + 1);
        const codes = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
          const c = b.c[i];
          if (!c) continue;
          if (!remap[c]) remap[c] = sb.code(b.d[c - 1]);
          codes[i] = remap[c];
        }
        return { col: { kind: "string", name, codes, dict: sb.d }, fmt: "" };
      }
      return { col: { kind: "string", name, codes: env.inputs.has(b.c) ? b.c.slice() : b.c, dict: b.d.slice() }, fmt: "" };
    }
    default:
      return { col: { kind: "number", name, values: new Float64Array(n).fill(NaN) }, fmt: "" };
  }
}

/** Every value of a result, row by row (for tests and small previews). */
export function resultRows(r: SqlResult): Scalar[][] {
  const out: Scalar[][] = [];
  for (let i = 0; i < r.rowCount; i++) {
    out.push(
      r.columns.map((c) => {
        if (c.kind === "number") {
          const x = c.values[i];
          return x !== x ? null : x;
        }
        const code = c.codes[i];
        return code ? c.dict[code - 1] : null;
      }),
    );
  }
  return out;
}

