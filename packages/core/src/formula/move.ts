import type { Node } from "./ast";

/**
 * A copy of a formula moved by (rows, cols), as when it's copied or filled
 * to another cell: relative references move, $-anchored parts stay, and a
 * reference pushed off the sheet becomes #REF!.
 */
export function moveFormula(node: Node, rows: number, cols: number): Node {
  switch (node.type) {
    case "ref": {
      const row = node.absRow ? node.row : node.row + rows;
      const col = node.absCol ? node.col : node.col + cols;
      if (row < 0 || col < 0) return { type: "error", code: "#REF!" };
      return { ...node, row, col };
    }
    case "range": {
      const { top, bottom, left, right } = node.range;
      // whole-column (bottom = Infinity) ranges don't move vertically
      const whole = bottom === Infinity;
      const t = node.absTop || whole ? top : top + rows;
      const b = node.absBottom || whole ? bottom : bottom + rows;
      const l = node.absLeft ? left : left + cols;
      const r = node.absRight ? right : right + cols;
      if (t < 0 || l < 0 || r < 0) return { type: "error", code: "#REF!" };
      return { ...node, range: { top: Math.min(t, b), bottom: Math.max(t, b), left: Math.min(l, r), right: Math.max(l, r) } };
    }
    case "unary":
      return { ...node, arg: moveFormula(node.arg, rows, cols) };
    case "binary":
      return { ...node, left: moveFormula(node.left, rows, cols), right: moveFormula(node.right, rows, cols) };
    case "call":
      return { ...node, args: node.args.map((a) => moveFormula(a, rows, cols)) };
    default:
      return node;
  }
}
