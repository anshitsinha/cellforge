/**
 * Reference adjustment for structural changes (inserting or deleting rows),
 * following Excel's rules:
 *
 * - a reference to a row at or after an insertion moves down with it;
 * - a reference to a deleted row becomes #REF!;
 * - a range grows when rows are inserted inside it and shrinks when rows
 *   inside it are deleted; it becomes #REF! only if all its rows are deleted;
 * - whole-column ranges (A:A) never change.
 *
 * Formulas here are evaluated with a row shift (see evaluate()), so a
 * relative reference's target is `row + shift`. Adjustment works on targets:
 * given the shift the formula had before the change and the one it has after
 * (its own row may have moved too), it rewrites each reference so it points
 * at the same data as before.
 */
import type { Node } from "./ast";

export interface RowChange {
  /** first row affected (0-based view row) */
  at: number;
  count: number;
  insert: boolean;
}

/** Where row `r` is after the change; null if it was deleted. */
export function mapRow(c: RowChange, r: number): number | null {
  if (c.insert) return r >= c.at ? r + c.count : r;
  if (r < c.at) return r;
  if (r >= c.at + c.count) return r - c.count;
  return null;
}

// a range's edges survive deletions inside them: the top edge moves to the
// first surviving row, the bottom edge to the last one before the gap
function mapTop(c: RowChange, r: number): number {
  if (c.insert || r < c.at) return mapRow(c, r)!;
  return r >= c.at + c.count ? r - c.count : c.at;
}

function mapBottom(c: RowChange, r: number): number {
  if (c.insert || r < c.at) return mapRow(c, r)!;
  return r >= c.at + c.count ? r - c.count : c.at - 1;
}

const REF_ERROR: Node = { type: "error", code: "#REF!" };

/**
 * A copy of `node` with references adjusted for the change.
 *
 * @param oldShift the row shift the formula was evaluated with before
 * @param newShift the shift it will be evaluated with after (differs when the
 *        formula's own row moved)
 * @param applies  which references the change is about: those to the sheet
 *        that changed (unqualified ones on that sheet, or `Sheet!` ones elsewhere)
 */
export function adjustForRowChange(
  node: Node,
  c: RowChange,
  oldShift: number,
  newShift: number,
  applies: (sheet: string | undefined) => boolean,
): Node {
  switch (node.type) {
    case "ref": {
      if (!applies(node.sheet)) return node;
      const target = node.absRow ? node.row : node.row + oldShift;
      if (target < 0) return node;
      const moved = mapRow(c, target);
      if (moved === null) return REF_ERROR;
      return { ...node, row: node.absRow ? moved : moved - newShift };
    }
    case "range": {
      if (!applies(node.sheet) || node.range.bottom === Infinity) return node;
      const top = node.range.top + (node.absTop ? 0 : oldShift);
      const bottom = node.range.bottom + (node.absBottom ? 0 : oldShift);
      if (top < 0) return node;
      const t = mapTop(c, top);
      const b = mapBottom(c, bottom);
      if (b < t) return REF_ERROR;
      return {
        ...node,
        range: {
          ...node.range,
          top: node.absTop ? t : t - newShift,
          bottom: node.absBottom ? b : b - newShift,
        },
      };
    }
    case "unary":
      return { ...node, arg: adjustForRowChange(node.arg, c, oldShift, newShift, applies) };
    case "binary":
      return {
        ...node,
        left: adjustForRowChange(node.left, c, oldShift, newShift, applies),
        right: adjustForRowChange(node.right, c, oldShift, newShift, applies),
      };
    case "call":
      return { ...node, args: node.args.map((a) => adjustForRowChange(a, c, oldShift, newShift, applies)) };
    default:
      return node;
  }
}

/**
 * Rows of a filled block at which the adjustment can change: where the
 * formula's own row or one of its relative targets crosses an edge of the
 * change. Between consecutive breakpoints, one adjusted template is right for
 * every row, so a fill is split only at these rows.
 *
 * `rowShiftOf(v)` gives the shift row v is evaluated with (v - origin).
 */
export function breakpoints(node: Node, c: RowChange, origin: number, ownRowMoves: boolean, applies: (sheet: string | undefined) => boolean): number[] {
  const edges = c.insert ? [c.at] : [c.at, c.at + c.count];
  const out = new Set<number>();
  if (ownRowMoves) for (const e of edges) out.add(e);
  const visit = (n: Node) => {
    switch (n.type) {
      case "ref":
        if (applies(n.sheet) && !n.absRow) for (const e of edges) out.add(e - n.row + origin);
        return;
      case "range":
        if (!applies(n.sheet) || n.range.bottom === Infinity) return;
        for (const e of edges) {
          if (!n.absTop) out.add(e - n.range.top + origin);
          if (!n.absBottom) out.add(e - n.range.bottom + origin);
        }
        return;
      case "unary":
        visit(n.arg);
        return;
      case "binary":
        visit(n.left);
        visit(n.right);
        return;
      case "call":
        n.args.forEach(visit);
        return;
      default:
        return;
    }
  };
  visit(node);
  return [...out].sort((a, b) => a - b);
}

export interface ColChange {
  /** first column affected (0-based) */
  at: number;
  count: number;
  insert: boolean;
}

/** Where column `c` is after the change; null if it was deleted. */
export function mapCol(ch: ColChange, c: number): number | null {
  return mapRow(ch, c);
}

/**
 * A copy of `node` with column references adjusted for inserted or deleted
 * columns, by the same rules as rows. Whole-column ranges (A:C) adjust too,
 * since they name columns. Columns don't depend on which row a formula is
 * evaluated at, so one adjustment is right for every row of a filled block.
 */
export function adjustForColChange(node: Node, ch: ColChange, applies: (sheet: string | undefined) => boolean): Node {
  switch (node.type) {
    case "ref": {
      if (!applies(node.sheet)) return node;
      const moved = mapCol(ch, node.col);
      return moved === null ? REF_ERROR : { ...node, col: moved };
    }
    case "range": {
      if (!applies(node.sheet)) return node;
      const l = mapTop(ch, node.range.left);
      const r = mapBottom(ch, node.range.right);
      if (r < l) return REF_ERROR;
      return { ...node, range: { ...node.range, left: l, right: r } };
    }
    case "unary":
      return { ...node, arg: adjustForColChange(node.arg, ch, applies) };
    case "binary":
      return { ...node, left: adjustForColChange(node.left, ch, applies), right: adjustForColChange(node.right, ch, applies) };
    case "call":
      return { ...node, args: node.args.map((a) => adjustForColChange(a, ch, applies)) };
    default:
      return node;
  }
}
