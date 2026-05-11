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

/** Sheet prefix as Excel writes it: Sheet2!  or  'Bank Jan'!  */
export function sheetPrefix(name: string | undefined): string {
  if (name === undefined) return "";
  // quote anything that isn't a plain identifier, or that looks like a cell (AB12)
  const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name);
  return plain ? `${name}!` : `'${name.replace(/'/g, "''")}'!`;
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
    case "missing":
      return "";
    case "boolean":
      return node.value ? "TRUE" : "FALSE";
    case "error":
      return node.code;
    case "ref": {
      const row = node.absRow ? node.row : node.row + shift;
      if (row < 0) return "#REF!";
      return `${sheetPrefix(node.sheet)}${node.absCol ? "$" : ""}${letters(node.col)}${node.absRow ? "$" : ""}${row + 1}${node.spill ? "#" : ""}`;
    }
    case "range": {
      const r = shiftRange(node, shift);
      if (!r) return "#REF!";
      const pre = sheetPrefix(node.sheet);
      if (r.bottom === Infinity) return `${pre}${letters(r.left)}:${letters(r.right)}`;
      const a = `${node.absLeft ? "$" : ""}${letters(r.left)}${node.absTop ? "$" : ""}${r.top + 1}`;
      const b = `${node.absRight ? "$" : ""}${letters(r.right)}${node.absBottom ? "$" : ""}${r.bottom + 1}`;
      return `${pre}${a}:${b}`;
    }
    case "unary": {
      const inner = wrap(node.arg, shift, node.op === "%" ? POSTFIX : UNARY);
      return node.op === "%" ? `${inner}%` : `${node.op}${inner}`;
    }
    case "binary": {
      const p = PREC[node.op];
      // every operator is left associative (^ too, as in Excel)
      const rightAssoc = false;
      const left = wrap(node.left, shift, rightAssoc ? p + 1 : p);
      const right = wrap(node.right, shift, rightAssoc ? p : p + 1);
      return `${left}${node.op}${right}`;
    }
    case "call":
      if (node.name === "__TABLE") {
        const [t, spec] = node.args as { type: "string"; value: string }[];
        return `${t.value}[${spec.value}]`;
      }
      if (node.name === "__INVOKE") {
        const [fn, ...rest] = node.args;
        return `${print(fn, shift)}(${rest.map((a) => print(a, shift)).join(", ")})`;
      }
      return `${node.name}(${node.args.map((a) => print(a, shift)).join(", ")})`;
    case "array":
      return `{${node.rows.map((r) => r.map((a) => print(a, shift)).join(",")).join(";")}}`;
    case "name":
      return node.name;
  }
}

function wrap(node: Node, shift: number, minPrec: number): string {
  const s = print(node, shift);
  return precOf(node) < minPrec ? `(${s})` : s;
}
