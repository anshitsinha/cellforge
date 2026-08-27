/**
 * Recursive-descent parser for the SQL dialect described in docs/guide/41-sql.md.
 * Errors say what was expected and point at the token where it went wrong.
 */
import type { BinOp, Expr, FrameBound, From, OrderItem, Query, QueryBody, Select, SelectItem, WindowSpec } from "./ast";
import { SqlError, tokenize, type Token } from "./lexer";
import { dateToSerial } from "../numfmt";

/** Words that can't be a bare alias or column name (quote them to use them as names). */
const RESERVED = new Set(
  "SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET UNION EXCEPT INTERSECT JOIN LEFT RIGHT FULL INNER OUTER CROSS ON USING AS AND OR NOT IN IS NULL LIKE ILIKE BETWEEN CASE WHEN THEN ELSE END WITH DISTINCT ALL ASC DESC NULLS OVER PARTITION TRUE FALSE EXISTS FETCH".split(" "),
);

const CAST_TYPES: Record<string, "num" | "str" | "date" | "int"> = {
  NUMBER: "num",
  NUMERIC: "num",
  DECIMAL: "num",
  DOUBLE: "num",
  FLOAT: "num",
  REAL: "num",
  MONEY: "num",
  INT: "int",
  INTEGER: "int",
  BIGINT: "int",
  SMALLINT: "int",
  TEXT: "str",
  VARCHAR: "str",
  CHAR: "str",
  STRING: "str",
  DATE: "date",
};

/** Parse one query (an optional trailing ; is allowed). */
export function parseSql(sql: string): Query {
  return new Parser(sql).parseAll();
}

/** "2024-03-31" (optionally with a time) to an Excel serial date, or null. */
export function isoToSerial(s: string): number | null {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*$/.exec(s);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;
  return dateToSerial(y, mo, d, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

class Parser {
  private toks: Token[];
  private i = 0;

  constructor(private sql: string) {
    this.toks = tokenize(sql);
  }

  // ------------------------------------------------------------ helpers --

  private get t(): Token {
    return this.toks[this.i];
  }
  private peek(k = 1): Token {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)];
  }
  private err(msg: string, at: Token = this.t): never {
    throw new SqlError(msg, this.sql, at.pos);
  }
  private desc(t: Token): string {
    if (t.k === "eof") return "the end of the query";
    if (t.k === "str") return `'${t.v}'`;
    if (t.k === "qident") return `"${t.v}"`;
    return `"${t.v}"`;
  }
  private isKw(word: string, t: Token = this.t): boolean {
    return t.k === "ident" && t.up === word;
  }
  private acceptKw(...words: string[]): boolean {
    if (words.every((w, j) => this.isKw(w, this.peek(j)))) {
      this.i += words.length;
      return true;
    }
    return false;
  }
  private expectKw(word: string, hint = ""): Token {
    const t = this.t;
    if (!this.isKw(word)) this.err(`Expected ${word}${hint} but found ${this.desc(t)}`);
    this.i++;
    return t;
  }
  private isOp(v: string, t: Token = this.t): boolean {
    return t.k === "op" && t.v === v;
  }
  private acceptOp(v: string): boolean {
    if (this.isOp(v)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expectOp(v: string, hint = ""): Token {
    const t = this.t;
    if (!this.isOp(v)) this.err(`Expected "${v}"${hint} but found ${this.desc(t)}`);
    this.i++;
    return t;
  }
  private prevEnd(): number {
    return this.toks[this.i - 1]?.end ?? 0;
  }
  /** A name: a quoted identifier or a non-reserved word. */
  private name(what: string): Token {
    const t = this.t;
    if (t.k === "qident" || (t.k === "ident" && !RESERVED.has(t.up))) {
      this.i++;
      return t;
    }
    if (t.k === "ident") this.err(`${t.v} is a keyword; to use it as ${what}, put it in double quotes: "${t.v}"`);
    this.err(`Expected ${what} but found ${this.desc(t)}`);
  }
  private isName(t: Token = this.t): boolean {
    return t.k === "qident" || (t.k === "ident" && !RESERVED.has(t.up));
  }

  // ------------------------------------------------------------- query --

  parseAll(): Query {
    if (this.t.k === "eof") this.err("The query is empty; start with SELECT or WITH");
    const q = this.query();
    this.acceptOp(";");
    if (this.peek(0).k !== "eof") {
      if (this.isOp(")")) this.err('There\'s a ")" without a matching "("');
      this.err(`Unexpected ${this.desc(this.t)}; the query should end here (only one query can run at a time)`);
    }
    return q;
  }

  private query(): Query {
    const pos = this.t.pos;
    const ctes: Query["with"] = [];
    if (this.acceptKw("WITH")) {
      this.acceptKw("RECURSIVE");
      do {
        const nt = this.name("a name for the WITH query");
        this.expectKw("AS", ` after the WITH name ${nt.v}`);
        this.expectOp("(", " to start the WITH query");
        const q = this.query();
        this.expectOp(")", " to close the WITH query");
        ctes.push({ name: nt.v, q, pos: nt.pos });
      } while (this.acceptOp(","));
    }
    const body = this.setExpr();
    const order: OrderItem[] = [];
    if (this.acceptKw("ORDER")) {
      this.expectKw("BY", " after ORDER");
      order.push(...this.orderList());
    }
    let limit: Expr | undefined;
    let offset: Expr | undefined;
    for (;;) {
      if (!limit && this.acceptKw("LIMIT")) limit = this.expr();
      else if (!offset && this.acceptKw("OFFSET")) {
        offset = this.expr();
        this.acceptKw("ROWS") || this.acceptKw("ROW");
      } else if (!limit && this.acceptKw("FETCH")) {
        if (!this.acceptKw("FIRST")) this.expectKw("NEXT", " or FIRST after FETCH");
        limit = this.expr();
        if (!this.acceptKw("ROWS")) this.expectKw("ROW");
        this.expectKw("ONLY");
      } else break;
    }
    return { with: ctes, body, order, limit, offset, pos, end: this.prevEnd() };
  }

  private setExpr(): QueryBody {
    let left = this.selectOrParen();
    for (;;) {
      const t = this.t;
      const op = this.isKw("UNION") ? "union" : this.isKw("EXCEPT") ? "except" : this.isKw("INTERSECT") ? "intersect" : null;
      if (!op) break;
      this.i++;
      const all = this.acceptKw("ALL");
      if (!all) this.acceptKw("DISTINCT");
      const right = this.selectOrParen();
      left = { k: "setop", op, all, l: left, r: right, pos: t.pos, end: this.prevEnd() };
    }
    return left;
  }

  private selectOrParen(): QueryBody {
    if (this.isOp("(")) {
      const pos = this.t.pos;
      this.i++;
      const q = this.query();
      this.expectOp(")");
      return { k: "paren", q, pos, end: this.prevEnd() };
    }
    if (this.isKw("SELECT")) return this.select();
    if (this.isKw("FROM")) this.err("A query starts with SELECT; put SELECT ... before FROM");
    this.err(`Expected SELECT but found ${this.desc(this.t)}`);
  }

  private select(): Select {
    const pos = this.expectKw("SELECT").pos;
    let distinct = false;
    if (this.acceptKw("DISTINCT")) distinct = true;
    else this.acceptKw("ALL");
    const items: SelectItem[] = [];
    if (this.isKw("FROM") || this.t.k === "eof") this.err("Say what to select: a list of columns or *, e.g. SELECT * FROM t");
    do {
      if (this.isKw("FROM")) this.err("There's a comma before FROM with nothing after it");
      items.push(this.selectItem());
    } while (this.acceptOp(","));
    let from: From | undefined;
    if (this.acceptKw("FROM")) from = this.fromList();
    let where: Expr | undefined;
    if (this.acceptKw("WHERE")) where = this.expr();
    const groupBy: Expr[] = [];
    if (this.acceptKw("GROUP")) {
      this.expectKw("BY", " after GROUP");
      do groupBy.push(this.expr());
      while (this.acceptOp(","));
    }
    let having: Expr | undefined;
    if (this.acceptKw("HAVING")) having = this.expr();
    if (this.isKw("WHERE")) this.err("WHERE goes before GROUP BY and HAVING");
    if (this.isKw("GROUP") && having) this.err("GROUP BY goes before HAVING");
    if (this.isName() && from) this.err(`Unexpected ${this.desc(this.t)}; is there a comma or keyword missing?`);
    return { k: "select", distinct, items, from, where, groupBy, having, pos, end: this.prevEnd() };
  }

  private selectItem(): SelectItem {
    // * and t.*
    if (this.isOp("*")) {
      const t = this.t;
      this.i++;
      return { e: { k: "star", pos: t.pos, end: t.end } };
    }
    if (this.isName() && this.isOp(".", this.peek()) && this.isOp("*", this.peek(2))) {
      const t = this.t;
      this.i += 3;
      return { e: { k: "star", table: t.v, pos: t.pos, end: this.prevEnd() } };
    }
    const e = this.expr();
    let alias: string | undefined;
    if (this.acceptKw("AS")) alias = this.name("a column name after AS").v;
    else if (this.isName() || this.t.k === "str") {
      alias = this.t.v;
      this.i++;
    }
    return { e, alias };
  }

  private fromList(): From {
    let left = this.fromItem();
    while (this.acceptOp(",")) {
      const right = this.fromItem();
      left = { k: "join", type: "cross", l: left, r: right, pos: left.pos, end: right.end };
    }
    return left;
  }

  private fromItem(): From {
    let left = this.fromPrimary();
    for (;;) {
      let type: "inner" | "left" | "right" | "full" | "cross" | null = null;
      if (this.acceptKw("JOIN") || this.acceptKw("INNER", "JOIN")) type = "inner";
      else if (this.acceptKw("LEFT", "JOIN") || this.acceptKw("LEFT", "OUTER", "JOIN")) type = "left";
      else if (this.acceptKw("RIGHT", "JOIN") || this.acceptKw("RIGHT", "OUTER", "JOIN")) type = "right";
      else if (this.acceptKw("FULL", "JOIN") || this.acceptKw("FULL", "OUTER", "JOIN")) type = "full";
      else if (this.acceptKw("CROSS", "JOIN")) type = "cross";
      else if (this.isKw("LEFT") || this.isKw("RIGHT") || this.isKw("FULL") || this.isKw("INNER") || this.isKw("CROSS")) this.err(`Expected JOIN after ${this.t.v}`, this.peek());
      if (!type) break;
      const right = this.fromPrimary();
      let on: Expr | undefined;
      let using: string[] | undefined;
      if (type !== "cross") {
        if (this.acceptKw("ON")) on = this.expr();
        else if (this.acceptKw("USING")) {
          this.expectOp("(", " after USING");
          using = [];
          do using.push(this.name("a column name").v);
          while (this.acceptOp(","));
          this.expectOp(")");
        } else this.err(`Expected ON after the joined table, e.g. ON a.id = b.id, but found ${this.desc(this.t)}`);
      }
      left = { k: "join", type, l: left, r: right, on, using, pos: left.pos, end: this.prevEnd() };
    }
    return left;
  }

  private alias(): string | undefined {
    if (this.acceptKw("AS")) return this.name("a name after AS").v;
    if (this.isName()) return this.toks[this.i++].v;
    return undefined;
  }

  private fromPrimary(): From {
    const t = this.t;
    if (this.isOp("(")) {
      // a subquery or a parenthesised join
      const next = this.peek();
      if (this.isKw("SELECT", next) || this.isKw("WITH", next) || this.isOp("(", next)) {
        this.i++;
        const q = this.query();
        this.expectOp(")", " to close the subquery");
        const alias = this.alias();
        return { k: "sub", q, alias, pos: t.pos, end: this.prevEnd() };
      }
      this.i++;
      const inner = this.fromList();
      this.expectOp(")");
      return inner;
    }
    if (!this.isName()) {
      if (t.k === "eof") this.err("Expected a table (sheet) name after FROM");
      if (t.k === "str") this.err(`Table names go in double quotes, not single quotes: "${t.v}"`);
      this.name("a table (sheet) name");
    }
    this.i++;
    let name = t.v;
    // schema.table: keep the last part
    while (this.isOp(".") && this.isName(this.peek())) {
      this.i++;
      name = this.toks[this.i++].v;
    }
    const alias = this.alias();
    return { k: "table", name, alias, pos: t.pos, end: this.prevEnd() };
  }

  private orderList(): OrderItem[] {
    const out: OrderItem[] = [];
    do {
      const e = this.expr();
      let desc = false;
      if (this.acceptKw("DESC")) desc = true;
      else this.acceptKw("ASC");
      let nullsFirst: boolean | undefined;
      if (this.acceptKw("NULLS")) {
        if (this.acceptKw("FIRST")) nullsFirst = true;
        else if (this.acceptKw("LAST")) nullsFirst = false;
        else this.err("Expected FIRST or LAST after NULLS");
      }
      out.push({ e, desc, nullsFirst });
    } while (this.acceptOp(","));
    return out;
  }

  // -------------------------------------------------------- expressions --

  expr(): Expr {
    return this.or();
  }

  private bin(op: BinOp, l: Expr, r: Expr): Expr {
    return { k: "bin", op, l, r, pos: l.pos, end: r.end };
  }

  private or(): Expr {
    let l = this.and();
    while (this.acceptKw("OR")) l = this.bin("OR", l, this.and());
    return l;
  }
  private and(): Expr {
    let l = this.not();
    while (this.acceptKw("AND")) l = this.bin("AND", l, this.not());
    return l;
  }
  private not(): Expr {
    const t = this.t;
    if (this.acceptKw("NOT")) {
      const e = this.not();
      return { k: "unary", op: "NOT", e, pos: t.pos, end: e.end };
    }
    return this.predicate();
  }

  private predicate(): Expr {
    let l = this.concat();
    for (;;) {
      const t = this.t;
      if (t.k === "op" && ["=", "<>", "<", "<=", ">", ">="].includes(t.v)) {
        this.i++;
        if (this.isKw("ANY") || this.isKw("ALL") || this.isKw("SOME")) this.err(`${this.t.v} subqueries aren't supported; use IN (...) instead`);
        l = this.bin(t.v as BinOp, l, this.concat());
        continue;
      }
      if (this.acceptKw("IS")) {
        const not = this.acceptKw("NOT");
        if (this.acceptKw("NULL")) {
          l = { k: "isnull", e: l, not, pos: l.pos, end: this.prevEnd() };
          continue;
        }
        if (this.isKw("TRUE") || this.isKw("FALSE")) {
          const v = this.t.up === "TRUE";
          this.i++;
          const lit: Expr = { k: "lit", v, pos: t.pos, end: this.prevEnd() };
          // x IS TRUE: true only when x is true (never null)
          const eq = this.bin("=", l, lit);
          const known: Expr = { k: "fn", name: "COALESCE", args: [eq, { k: "lit", v: false, pos: t.pos, end: t.pos }], distinct: false, star: false, pos: l.pos, end: this.prevEnd() };
          l = not ? { k: "unary", op: "NOT", e: known, pos: l.pos, end: this.prevEnd() } : known;
          continue;
        }
        if (this.acceptKw("DISTINCT")) {
          this.expectKw("FROM", " after IS DISTINCT");
          const r = this.concat();
          l = { k: "fn", name: not ? "__NOTDISTINCT" : "__DISTINCT", args: [l, r], distinct: false, star: false, pos: l.pos, end: r.end };
          continue;
        }
        this.err(`Expected NULL after IS${not ? " NOT" : ""} but found ${this.desc(this.t)}`);
      }
      let not = false;
      if (this.isKw("NOT") && (this.isKw("BETWEEN", this.peek()) || this.isKw("IN", this.peek()) || this.isKw("LIKE", this.peek()) || this.isKw("ILIKE", this.peek()))) {
        this.i++;
        not = true;
      }
      if (this.acceptKw("BETWEEN")) {
        this.acceptKw("SYMMETRIC");
        const lo = this.concat();
        this.expectKw("AND", " in BETWEEN ... AND ...");
        const hi = this.concat();
        l = { k: "between", e: l, lo, hi, not, pos: l.pos, end: hi.end };
        continue;
      }
      if (this.acceptKw("IN")) {
        this.expectOp("(", " after IN");
        if (this.isKw("SELECT") || this.isKw("WITH")) {
          const q = this.query();
          this.expectOp(")", " to close the IN subquery");
          l = { k: "in", e: l, sub: q, not, pos: l.pos, end: this.prevEnd() };
          continue;
        }
        if (this.isOp(")")) this.err("IN needs at least one value, e.g. IN ('A', 'B')");
        const list: Expr[] = [];
        do list.push(this.expr());
        while (this.acceptOp(","));
        this.expectOp(")", " to close the IN list");
        l = { k: "in", e: l, list, not, pos: l.pos, end: this.prevEnd() };
        continue;
      }
      if (this.isKw("LIKE") || this.isKw("ILIKE")) {
        const ci = this.t.up === "ILIKE";
        this.i++;
        const pat = this.concat();
        let esc: string | undefined;
        if (this.acceptKw("ESCAPE")) {
          const et = this.t;
          if (et.k !== "str" || et.v.length !== 1) this.err("ESCAPE needs a single character in quotes, e.g. ESCAPE '\\'");
          esc = et.v;
          this.i++;
        }
        l = { k: "like", e: l, pat, not, ci, esc, pos: l.pos, end: this.prevEnd() };
        continue;
      }
      if (not) this.err("Expected BETWEEN, IN or LIKE after NOT");
      return l;
    }
  }

  private concat(): Expr {
    let l = this.add();
    while (this.isOp("||")) {
      this.i++;
      l = this.bin("||", l, this.add());
    }
    return l;
  }
  private add(): Expr {
    let l = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.toks[this.i++].v as BinOp;
      l = this.bin(op, l, this.mul());
    }
    return l;
  }
  private mul(): Expr {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.toks[this.i++].v as BinOp;
      l = this.bin(op, l, this.unary());
    }
    return l;
  }
  private unary(): Expr {
    const t = this.t;
    if (this.acceptOp("-")) {
      const e = this.unary();
      if (e.k === "lit" && typeof e.v === "number") return { ...e, v: -e.v, pos: t.pos };
      return { k: "unary", op: "-", e, pos: t.pos, end: e.end };
    }
    if (this.acceptOp("+")) return this.unary();
    return this.primary();
  }

  private primary(): Expr {
    const t = this.t;
    const at = { pos: t.pos };
    if (t.k === "num") {
      this.i++;
      return { k: "lit", v: Number(t.v), ...at, end: t.end };
    }
    if (t.k === "str") {
      this.i++;
      return { k: "lit", v: t.v, ...at, end: t.end };
    }
    if (this.isOp("(")) {
      this.i++;
      if (this.isKw("SELECT") || this.isKw("WITH")) {
        const q = this.query();
        this.expectOp(")", " to close the subquery");
        return { k: "sub", q, ...at, end: this.prevEnd() };
      }
      const e = this.expr();
      this.expectOp(")", " to close the bracket");
      return { ...e, pos: t.pos, end: this.prevEnd() };
    }
    if (t.k === "qident") return this.columnRef();
    if (t.k !== "ident") {
      if (t.k === "eof") this.err("The query ends too early; expected a value or column");
      this.err(`Expected a value or column but found ${this.desc(t)}`);
    }
    switch (t.up) {
      case "NULL":
        this.i++;
        return { k: "lit", v: null, ...at, end: t.end };
      case "TRUE":
      case "FALSE":
        this.i++;
        return { k: "lit", v: t.up === "TRUE", ...at, end: t.end };
      case "DATE":
      case "TIMESTAMP":
        if (this.peek().k === "str") {
          this.i++;
          const s = this.t;
          this.i++;
          const serial = isoToSerial(s.v);
          if (serial === null) this.err(`'${s.v}' isn't a date; write dates as DATE 'YYYY-MM-DD', e.g. DATE '2024-03-31'`, s);
          return { k: "lit", v: serial, date: true, ...at, end: s.end };
        }
        break;
      case "CASE":
        return this.caseExpr();
      case "CAST":
        if (this.isOp("(", this.peek())) {
          this.i += 2;
          const e = this.expr();
          this.expectKw("AS", " in CAST(value AS type)");
          const tt = this.t;
          if (tt.k !== "ident" || !(tt.up in CAST_TYPES)) this.err(`Expected a type (NUMBER, INTEGER, TEXT or DATE) but found ${this.desc(tt)}`);
          this.i++;
          // VARCHAR(20), DECIMAL(10,2)
          if (this.acceptOp("(")) {
            while (!this.isOp(")") && this.t.k !== "eof") this.i++;
            this.expectOp(")");
          }
          this.expectOp(")", " to close CAST");
          return { k: "cast", e, to: CAST_TYPES[tt.up], ...at, end: this.prevEnd() };
        }
        break;
      case "EXISTS":
        if (this.isOp("(", this.peek())) {
          this.i += 2;
          const q = this.query();
          this.expectOp(")");
          return { k: "exists", q, not: false, ...at, end: this.prevEnd() };
        }
        break;
      case "CURRENT_DATE":
        this.i++;
        return { k: "fn", name: "CURRENT_DATE", args: [], distinct: false, star: false, ...at, end: t.end };
    }
    if (this.isOp("(", this.peek()) && (this.isName() || ["LEFT", "RIGHT"].includes(t.up))) return this.call();
    if (RESERVED.has(t.up)) this.err(`Expected a value or column but found the keyword ${t.v}${["FROM", "WHERE", "GROUP", "ORDER"].includes(t.up) ? " (is something missing before it?)" : ""}`);
    return this.columnRef();
  }

  private columnRef(): Expr {
    const t = this.name("a column name");
    if (this.isOp(".") && (this.isName(this.peek()) || this.peek().k === "ident")) {
      this.i++;
      const c = this.t;
      if (c.k !== "ident" && c.k !== "qident") this.err("Expected a column name after the dot");
      this.i++;
      return { k: "col", table: t.v, name: c.v, pos: t.pos, end: c.end };
    }
    return { k: "col", name: t.v, pos: t.pos, end: t.end };
  }

  private caseExpr(): Expr {
    const start = this.expectKw("CASE");
    let base: Expr | undefined;
    if (!this.isKw("WHEN")) base = this.expr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.acceptKw("WHEN")) {
      const when = this.expr();
      this.expectKw("THEN", " after the WHEN condition");
      whens.push({ when, then: this.expr() });
    }
    if (!whens.length) this.err("CASE needs at least one WHEN ... THEN ...");
    let els: Expr | undefined;
    if (this.acceptKw("ELSE")) els = this.expr();
    this.expectKw("END", " to close the CASE");
    return { k: "case", base, whens, else: els, pos: start.pos, end: this.prevEnd() };
  }

  private call(): Expr {
    const nt = this.toks[this.i];
    const name = nt.up;
    this.i += 2; // name (
    let distinct = false;
    let star = false;
    const args: Expr[] = [];
    if (this.isOp("*")) {
      this.i++;
      star = true;
    } else if (!this.isOp(")")) {
      if (this.acceptKw("DISTINCT")) distinct = true;
      else this.acceptKw("ALL");
      if (name === "EXTRACT") {
        const part = this.t;
        if (part.k !== "ident" && part.k !== "str") this.err("Expected a date part such as YEAR or MONTH");
        this.i++;
        this.expectKw("FROM", " in EXTRACT(part FROM date)");
        args.push({ k: "lit", v: part.v.toUpperCase(), pos: part.pos, end: part.end }, this.expr());
      } else {
        // POSITION(a IN b): read a without IN
        args.push(name === "POSITION" ? this.concat() : this.expr());
        if ((name === "SUBSTRING" || name === "SUBSTR") && this.acceptKw("FROM")) {
          args.push(this.expr());
          if (this.acceptKw("FOR")) args.push(this.expr());
        } else if (name === "POSITION" && args.length === 1 && this.acceptKw("IN")) {
          args.push(this.expr());
        } else {
          while (this.acceptOp(",")) args.push(this.expr());
          if (name === "STRING_AGG" || name === "LISTAGG" || name === "GROUP_CONCAT") {
            if (this.isKw("ORDER")) this.err("ORDER BY inside STRING_AGG isn't supported; values are joined in row order");
          }
        }
      }
    }
    this.expectOp(")", ` to close ${nt.v}(`);
    let over: WindowSpec | undefined;
    if (this.isKw("FILTER")) this.err("FILTER (WHERE ...) isn't supported; use CASE WHEN inside the aggregate, e.g. SUM(CASE WHEN x > 0 THEN x END)");
    if (this.acceptKw("OVER")) over = this.window();
    return { k: "fn", name, args, distinct, star, over, pos: nt.pos, end: this.prevEnd() };
  }

  private window(): WindowSpec {
    if (!this.isOp("(")) this.err("Expected ( after OVER, e.g. OVER (PARTITION BY account ORDER BY date)");
    this.i++;
    const partition: Expr[] = [];
    let order: OrderItem[] = [];
    if (this.acceptKw("PARTITION")) {
      this.expectKw("BY", " after PARTITION");
      do partition.push(this.expr());
      while (this.acceptOp(","));
    }
    if (this.acceptKw("ORDER")) {
      this.expectKw("BY", " after ORDER");
      order = this.orderList();
    }
    let frame: WindowSpec["frame"];
    if (this.isKw("ROWS") || this.isKw("RANGE")) {
      const rows = this.t.up === "ROWS";
      this.i++;
      let start: FrameBound;
      let end: FrameBound;
      if (this.acceptKw("BETWEEN")) {
        start = this.bound(rows);
        this.expectKw("AND", " in BETWEEN ... AND ...");
        end = this.bound(rows);
      } else {
        start = this.bound(rows);
        end = { kind: "current", dir: 1, n: 0 };
      }
      const rank = (b: FrameBound) => (b.kind === "unbounded" ? b.dir * Infinity : b.kind === "current" ? 0 : b.dir * b.n);
      if (rank(start) > rank(end) || (start.kind === "unbounded" && start.dir === 1) || (end.kind === "unbounded" && end.dir === -1)) this.err("The window frame starts after it ends");
      frame = { rows, start, end };
    }
    this.expectOp(")", " to close OVER (...)");
    return { partition, order, frame };
  }

  private bound(rows: boolean): FrameBound {
    if (this.acceptKw("UNBOUNDED")) {
      if (this.acceptKw("PRECEDING")) return { kind: "unbounded", dir: -1, n: 0 };
      this.expectKw("FOLLOWING", " or PRECEDING after UNBOUNDED");
      return { kind: "unbounded", dir: 1, n: 0 };
    }
    if (this.acceptKw("CURRENT")) {
      this.expectKw("ROW", " after CURRENT");
      return { kind: "current", dir: 1, n: 0 };
    }
    const t = this.t;
    if (t.k !== "num") this.err("Expected UNBOUNDED, CURRENT ROW or a number of rows");
    if (!rows) this.err("RANGE with a number of rows isn't supported; use ROWS BETWEEN n PRECEDING AND ...");
    this.i++;
    const n = Number(t.v);
    if (!Number.isInteger(n) || n < 0) this.err("The number of rows must be a whole number", t);
    if (this.acceptKw("PRECEDING")) return { kind: "offset", dir: -1, n };
    this.expectKw("FOLLOWING", " or PRECEDING");
    return { kind: "offset", dir: 1, n };
  }
}
