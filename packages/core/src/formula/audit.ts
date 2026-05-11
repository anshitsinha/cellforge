/**
 * Formula auditing: what a formula reads, how it evaluates step by step,
 * and the checks auditors run by hand (deleted references, numbers typed
 * into formulas, a formula unlike its neighbours).
 */
import { CellError, type Node, type RangeRef } from "./ast";
import { firstOf, type Value } from "./arrays";
import { evaluate, shiftRange, type EvalContext } from "./evaluate";
import { formatFormula } from "./print";

export interface Reference {
  /** another sheet's name, or undefined for the formula's own sheet */
  sheet?: string;
  range: RangeRef;
}

/** Every cell or range a formula reads, at a given fill shift. */
export function references(node: Node, shift = 0): Reference[] {
  const out: Reference[] = [];
  const visit = (n: Node) => {
    switch (n.type) {
      case "ref": {
        const row = n.absRow ? n.row : n.row + shift;
        if (row >= 0) out.push({ ...(n.sheet ? { sheet: n.sheet } : {}), range: { top: row, bottom: row, left: n.col, right: n.col } });
        return;
      }
      case "range": {
        const r = shiftRange(n, shift);
        if (r) out.push({ ...(n.sheet ? { sheet: n.sheet } : {}), range: r });
        return;
      }
      case "unary":
        return visit(n.arg);
      case "binary":
        visit(n.left);
        return visit(n.right);
      case "call":
        return n.args.forEach(visit);
      case "array":
        return n.rows.forEach((r) => r.forEach(visit));
      default:
        return;
    }
  };
  visit(node);
  return out;
}

/** Formula text without the leading "=". */
const text = (n: Node, shift: number) => formatFormula(n, shift).replace(/^=/, "");

export interface Step {
  /** this part of the formula, as written */
  text: string;
  /** what it evaluates to, shown as a cell would ("#N/A", "TRUE", 12.5) */
  value: string;
  children: Step[];
}

const shown = (v: Value): string => {
  const x = firstOf(v);
  if (x === null) return "(empty)";
  if (x instanceof CellError) return x.code;
  if (typeof x === "boolean") return x ? "TRUE" : "FALSE";
  if (typeof x === "string") return JSON.stringify(x);
  const s = typeof v === "object" && v !== null && "rows" in v ? ` (${v.rows}×${v.cols} array)` : "";
  return String(x) + s;
};

/**
 * The formula broken into its parts, each with its value: the "Evaluate
 * Formula" dialog as a tree. Ranges and constants are leaves.
 */
export function steps(node: Node, ctx: EvalContext, shift = 0, depth = 0): Step {
  const value = shown(evaluate(node, ctx, shift));
  const children: Step[] = [];
  if (depth < 12) {
    if (node.type === "unary") children.push(steps(node.arg, ctx, shift, depth + 1));
    else if (node.type === "binary") children.push(steps(node.left, ctx, shift, depth + 1), steps(node.right, ctx, shift, depth + 1));
    else if (node.type === "call" && !node.name.startsWith("__") && node.name !== "LAMBDA") {
      for (const a of node.args) if (a.type !== "missing") children.push(steps(a, ctx, shift, depth + 1));
    }
  }
  return { text: text(node, shift), value, children };
}

/** The formula with references as offsets from its own cell, to compare shapes (Excel's R1C1). */
export function shape(node: Node, row: number, col: number, shift = 0): string {
  const r = (n: number, abs: boolean | undefined, here: number, letter: string) => (abs ? `${letter}${n + 1}` : `${letter}[${n - here}]`);
  const visit = (n: Node): string => {
    switch (n.type) {
      case "ref": {
        const rr = n.absRow ? n.row : n.row + shift;
        return `${n.sheet ? n.sheet + "!" : ""}${r(rr, n.absRow, row, "R")}${r(n.col, n.absCol, col, "C")}`;
      }
      case "range": {
        const g = shiftRange(n, shift);
        if (!g) return "#REF!";
        const b = g.bottom === Infinity ? "Rinf" : r(g.bottom, n.absBottom, row, "R");
        return `${n.sheet ? n.sheet + "!" : ""}${r(g.top, n.absTop, row, "R")}${r(g.left, n.absLeft, col, "C")}:${b}${r(g.right, n.absRight, col, "C")}`;
      }
      case "unary":
        return `${n.op}(${visit(n.arg)})`;
      case "binary":
        return `(${visit(n.left)}${n.op}${visit(n.right)})`;
      case "call":
        return `${n.name}(${n.args.map(visit).join(",")})`;
      case "array":
        return `{${n.rows.map((x) => x.map(visit).join(",")).join(";")}}`;
      case "string":
        return JSON.stringify(n.value);
      case "number":
        return String(n.value);
      case "boolean":
        return n.value ? "TRUE" : "FALSE";
      case "error":
        return n.code;
      case "name":
        return n.name;
      case "missing":
        return "";
    }
  };
  return visit(node);
}

export interface Finding {
  kind: "ref-error" | "hard-coded" | "inconsistent" | "empty-input";
  message: string;
}

/** Argument positions where a typed number is expected (column numbers, digits, match types...). */
const INDEX_ARGS: Record<string, number[]> = {
  ROUND: [1], ROUNDUP: [1], ROUNDDOWN: [1], TRUNC: [1], MROUND: [1], CEILING: [1], FLOOR: [1],
  VLOOKUP: [2, 3], HLOOKUP: [2, 3], INDEX: [1, 2], MATCH: [2], XMATCH: [2, 3], XLOOKUP: [4, 5],
  LEFT: [1], RIGHT: [1], MID: [1, 2], CHOOSE: [0], LARGE: [1], SMALL: [1], WEEKDAY: [1], TEXT: [],
  SEQUENCE: [0, 1, 2, 3], TAKE: [1, 2], DROP: [1, 2], SORT: [1, 2], EDATE: [1], EOMONTH: [1], DATE: [0, 1, 2], TIME: [0, 1, 2],
  RANK: [2], "RANK.EQ": [2], PERCENTILE: [1], "PERCENTILE.INC": [1], QUARTILE: [1], "QUARTILE.INC": [1], WORKDAY: [1], YEARFRAC: [2],
  PMT: [], SUBSTITUTE: [3], REPLACE: [1, 2], FIND: [2], SEARCH: [2], TEXTBEFORE: [2], TEXTAFTER: [2], REPT: [1], CHAR: [0],
};
/** Numbers that are rarely assumptions: 0, 1, -1, 2 (halving), 12 (months), 100 (percent), 1000, 365, 7, 24, 60. */
const HARMLESS = new Set([0, 1, -1, 2, 12, 100, 1000, 365, 366, 7, 24, 60]);

/** Numbers typed straight into a formula (assumptions that belong in a labelled cell). */
export function hardCodedNumbers(node: Node): number[] {
  const out: number[] = [];
  const visit = (n: Node, exempt: boolean) => {
    switch (n.type) {
      case "number":
        if (!exempt && !HARMLESS.has(n.value)) out.push(n.value);
        return;
      case "unary":
        if (n.op === "-" && n.arg.type === "number") {
          if (!exempt && !HARMLESS.has(-n.arg.value)) out.push(-n.arg.value);
          return;
        }
        return visit(n.arg, exempt);
      case "binary":
        visit(n.left, false);
        return visit(n.right, false);
      case "call": {
        const skip = INDEX_ARGS[n.name] ?? [];
        return n.args.forEach((a, i) => visit(a, skip.includes(i)));
      }
      case "array":
        return; // an array constant is data, not an assumption
      default:
        return;
    }
  };
  visit(node, false);
  return out;
}

/** Does the formula contain #REF! (a reference to something deleted)? */
export function hasRefError(node: Node): boolean {
  switch (node.type) {
    case "error":
      return node.code === "#REF!";
    case "unary":
      return hasRefError(node.arg);
    case "binary":
      return hasRefError(node.left) || hasRefError(node.right);
    case "call":
      return node.args.some(hasRefError);
    default:
      return false;
  }
}
