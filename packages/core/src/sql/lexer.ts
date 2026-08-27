/**
 * SQL tokens. Identifiers are case-insensitive unless quoted; "double
 * quotes", [brackets] and `backticks` quote a name that has spaces or clashes
 * with a keyword ("Sales 2024", [Order]). Strings use 'single quotes' with ''
 * for a quote inside. Comments: -- to the end of the line and /* ... *\/.
 */

/** A problem with the query, at a position in its text. */
export class SqlError extends Error {
  /** offset in the query text (0-based) */
  readonly pos: number;
  /** 1-based line and column of pos */
  readonly line: number;
  readonly column: number;
  /** the message without the position */
  readonly reason: string;

  constructor(reason: string, sql: string, pos: number) {
    const p = Math.max(0, Math.min(pos, sql.length));
    let line = 1;
    let col = 1;
    for (let i = 0; i < p; i++) {
      if (sql[i] === "\n") {
        line++;
        col = 1;
      } else col++;
    }
    super(`${reason} (line ${line}, column ${col})`);
    this.name = "SqlError";
    this.pos = p;
    this.line = line;
    this.column = col;
    this.reason = reason;
  }
}

export type TokKind = "ident" | "qident" | "num" | "str" | "op" | "eof";

export interface Token {
  k: TokKind;
  /** the text: identifier / string contents, number text, operator */
  v: string;
  /** upper-cased v, for keyword checks (ident only) */
  up: string;
  pos: number;
  end: number;
}

const OPS2 = ["<>", "!=", "<=", ">=", "||", "=="];
const OPS1 = "+-*/%=<>(),.;";

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  const isIdStart = (c: string) => /[A-Za-z_À-￿]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_$À-￿]/.test(c);
  while (i < n) {
    const c = sql[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === " ") {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) throw new SqlError("This comment is never closed; add */", sql, i);
      i = close + 2;
      continue;
    }
    const start = i;
    if (c === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= n) throw new SqlError("This text is never closed; add a ' at the end", sql, start);
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += sql[i++];
      }
      out.push({ k: "str", v: s, up: "", pos: start, end: i });
      continue;
    }
    if (c === '"' || c === "[" || c === "`") {
      const close = c === "[" ? "]" : c;
      let s = "";
      i++;
      for (;;) {
        if (i >= n) throw new SqlError(`This name is never closed; add a ${close}`, sql, start);
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) {
            s += close;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += sql[i++];
      }
      if (!s) throw new SqlError("An empty name", sql, start);
      out.push({ k: "qident", v: s, up: s.toUpperCase(), pos: start, end: i });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      while (i < n && /[0-9]/.test(sql[i])) i++;
      if (sql[i] === "." && /[0-9]/.test(sql[i + 1] ?? "")) {
        i++;
        while (i < n && /[0-9]/.test(sql[i])) i++;
      } else if (sql[i] === "." && !/[A-Za-z_]/.test(sql[i + 1] ?? "")) i++;
      if ((sql[i] === "e" || sql[i] === "E") && /[0-9+-]/.test(sql[i + 1] ?? "")) {
        let j = i + 1;
        if (sql[j] === "+" || sql[j] === "-") j++;
        if (/[0-9]/.test(sql[j] ?? "")) {
          i = j;
          while (i < n && /[0-9]/.test(sql[i])) i++;
        }
      }
      if (i < n && isIdStart(sql[i])) throw new SqlError(`"${sql.slice(start, i + 1)}" isn't a number or a name; quote names that start with a digit, like "2024 Sales"`, sql, start);
      out.push({ k: "num", v: sql.slice(start, i), up: "", pos: start, end: i });
      continue;
    }
    if (isIdStart(c)) {
      while (i < n && isId(sql[i])) i++;
      const v = sql.slice(start, i);
      out.push({ k: "ident", v, up: v.toUpperCase(), pos: start, end: i });
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (OPS2.includes(two)) {
      out.push({ k: "op", v: two === "!=" ? "<>" : two === "==" ? "=" : two, up: "", pos: start, end: i + 2 });
      i += 2;
      continue;
    }
    if (OPS1.includes(c)) {
      out.push({ k: "op", v: c, up: "", pos: start, end: i + 1 });
      i++;
      continue;
    }
    throw new SqlError(`Unexpected character "${c}"`, sql, i);
  }
  out.push({ k: "eof", v: "", up: "", pos: n, end: n });
  return out;
}
