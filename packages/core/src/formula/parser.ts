import type { BinaryOp, Node } from "./ast";

/**
 * Tokenizer + recursive descent parser for spreadsheet formulas.
 *
 * Precedence, lowest to highest (same as Excel):
 *   comparison  = <> < > <= >=
 *   concat      &
 *   additive    + -
 *   multiplicative * /
 *   power       ^
 *   unary       - +
 *   postfix     %
 *   primary     literal, ref, range, call, (expr)
 */

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; row: number; col: number }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "eof" };

export class FormulaSyntaxError extends Error {}

const REF = /^\$?([A-Za-z]{1,3})\$?(\d+)/;
const NUMBER = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i;
const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*/;
const OPS = ["<>", "<=", ">=", "+", "-", "*", "/", "^", "&", "=", "<", ">", "(", ")", ",", ":", "%"];

export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '"') {
      // strings use "" to escape a quote, same as CSV
      let s = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new FormulaSyntaxError("Unterminated string");
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      tokens.push({ t: "str", v: s });
      continue;
    }

    let m = NUMBER.exec(rest);
    if (m) {
      tokens.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }

    // A ref must not be followed by more identifier chars, otherwise "LOG10("
    // would tokenize as ref LOG10 + "(".
    m = REF.exec(rest);
    if (m && !/[A-Za-z0-9_(]/.test(rest[m[0].length] ?? "")) {
      tokens.push({ t: "ref", col: columnIndex(m[1]), row: Number(m[2]) - 1 });
      i += m[0].length;
      continue;
    }

    m = IDENT.exec(rest);
    if (m) {
      tokens.push({ t: "ident", v: m[0].toUpperCase() });
      i += m[0].length;
      continue;
    }

    const op = OPS.find((o) => rest.startsWith(o));
    if (op) {
      tokens.push({ t: "op", v: op });
      i += op.length;
      continue;
    }

    throw new FormulaSyntaxError(`Unexpected character '${ch}'`);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

/** Parse a formula. Accepts it with or without the leading "=". */
export function parseFormula(src: string): Node {
  const tokens = tokenize(src.startsWith("=") ? src.slice(1) : src);
  let pos = 0;

  const peek = () => tokens[pos];
  const isOp = (v: string) => {
    const tok = peek();
    return tok.t === "op" && tok.v === v;
  };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new FormulaSyntaxError(`Expected '${v}'`);
    pos++;
  };

  function binaryLevel(ops: string[], next: () => Node): () => Node {
    return () => {
      let left = next();
      for (;;) {
        const tok = peek();
        if (tok.t !== "op" || !ops.includes(tok.v)) return left;
        pos++;
        left = { type: "binary", op: tok.v as BinaryOp, left, right: next() };
      }
    };
  }

  const comparison = binaryLevel(["=", "<>", "<", ">", "<=", ">="], () => concat());
  const concat = binaryLevel(["&"], () => additive());
  const additive = binaryLevel(["+", "-"], () => multiplicative());
  const multiplicative = binaryLevel(["*", "/"], () => power());

  function power(): Node {
    const base = unary();
    if (isOp("^")) {
      pos++;
      // right associative: 2^3^2 = 2^(3^2)
      return { type: "binary", op: "^", left: base, right: power() };
    }
    return base;
  }

  function unary(): Node {
    if (isOp("-") || isOp("+")) {
      const op = (peek() as { v: string }).v as "-" | "+";
      pos++;
      return { type: "unary", op, arg: unary() };
    }
    return postfix();
  }

  function postfix(): Node {
    let node = primary();
    while (isOp("%")) {
      pos++;
      node = { type: "unary", op: "%", arg: node };
    }
    return node;
  }

  function primary(): Node {
    const tok = peek();
    pos++;
    switch (tok.t) {
      case "num":
        return { type: "number", value: tok.v };
      case "str":
        return { type: "string", value: tok.v };
      case "ref": {
        if (isOp(":")) {
          pos++;
          const end = peek();
          if (end.t !== "ref") throw new FormulaSyntaxError("Expected a cell after ':'");
          pos++;
          return {
            type: "range",
            range: {
              top: Math.min(tok.row, end.row),
              bottom: Math.max(tok.row, end.row),
              left: Math.min(tok.col, end.col),
              right: Math.max(tok.col, end.col),
            },
          };
        }
        return { type: "ref", row: tok.row, col: tok.col };
      }
      case "ident": {
        if (isOp("(")) {
          pos++;
          const args: Node[] = [];
          if (!isOp(")")) {
            do {
              args.push(comparison());
            } while (isOp(",") && ++pos);
          }
          expectOp(")");
          return { type: "call", name: tok.v, args };
        }
        if (tok.v === "TRUE" || tok.v === "FALSE") return { type: "boolean", value: tok.v === "TRUE" };
        // whole-column range like A:A or B:D
        if (/^[A-Z]{1,3}$/.test(tok.v) && isOp(":")) {
          pos++;
          const end = peek();
          if (end.t !== "ident" || !/^[A-Z]{1,3}$/.test(end.v)) {
            throw new FormulaSyntaxError("Expected a column after ':'");
          }
          pos++;
          const a = columnIndex(tok.v);
          const b = columnIndex(end.v);
          return {
            type: "range",
            range: { top: 0, bottom: Infinity, left: Math.min(a, b), right: Math.max(a, b) },
          };
        }
        throw new FormulaSyntaxError(`Unknown name '${tok.v}'`);
      }
      case "op":
        if (tok.v === "(") {
          const inner = comparison();
          expectOp(")");
          return inner;
        }
        throw new FormulaSyntaxError(`Unexpected '${tok.v}'`);
      case "eof":
        throw new FormulaSyntaxError("Formula ended unexpectedly");
    }
  }

  const node = comparison();
  if (peek().t !== "eof") throw new FormulaSyntaxError("Unexpected input after formula");
  return node;
}
