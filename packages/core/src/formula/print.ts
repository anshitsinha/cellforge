import type { Node } from "./ast";
import { shiftRange } from "./evaluate";

// Higher binds tighter. Mirrors the parser's precedence levels.
const PREC: Record<string, number> = {
  "=": 1,
  "<>": 1,
  "<": 1,
  ">": 1,
  "<=": 1,
  ">=": 1,
  "&": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "^": 5,
};
const UNARY = 6;
const POSTFIX = 7;
const ATOM = 8;

function letters(col: number): string {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

function precOf(node: Node): number {
  if (node.type === "binary") return PREC[node.op];
  if (node.type === "unary") return node.op === "%" ? POSTFIX : UNARY;
  return ATOM;
}

/**
 * Turn an AST back into formula text, optionally as it would read after being
 * filled `rowShift` rows down (relative refs move, $-anchored ones don't).
 * Adds only the parentheses the precedence rules actually need, so
 * "=(A1+B1)*2" round-trips but "=((A1))" comes back as "=A1".
 */
export function formatFormula(node: Node, rowShift = 0): string {
  return "=" + print(node, rowShift);
}

function print(node: Node, shift: number): string {
  switch (node.type) {
    case "number":
      return String(node.value);
    case "string":
      return `"${node.value.replace(/"/g, '""')}"`;
    case "boolean":
      return node.value ? "TRUE" : "FALSE";
    case "ref": {
      const row = node.absRow ? node.row : node.row + shift;
      if (row < 0) return "#REF!";
      return `${node.absCol ? "$" : ""}${letters(node.col)}${node.absRow ? "$" : ""}${row + 1}`;
    }
    case "range": {
      const r = shiftRange(node, shift);
      if (!r) return "#REF!";
      if (r.bottom === Infinity) return `${letters(r.left)}:${letters(r.right)}`;
      const a = `${node.absLeft ? "$" : ""}${letters(r.left)}${node.absTop ? "$" : ""}${r.top + 1}`;
      const b = `${node.absRight ? "$" : ""}${letters(r.right)}${node.absBottom ? "$" : ""}${r.bottom + 1}`;
      return `${a}:${b}`;
    }
    case "unary": {
      const inner = wrap(node.arg, shift, node.op === "%" ? POSTFIX : UNARY);
      return node.op === "%" ? `${inner}%` : `${node.op}${inner}`;
    }
    case "binary": {
      const p = PREC[node.op];
      // ^ is right associative, everything else is left associative
      const rightAssoc = node.op === "^";
      const left = wrap(node.left, shift, rightAssoc ? p + 1 : p);
      const right = wrap(node.right, shift, rightAssoc ? p : p + 1);
      return `${left}${node.op}${right}`;
    }
    case "call":
      return `${node.name}(${node.args.map((a) => print(a, shift)).join(", ")})`;
  }
}

function wrap(node: Node, shift: number, minPrec: number): string {
  const s = print(node, shift);
  return precOf(node) < minPrec ? `(${s})` : s;
}
