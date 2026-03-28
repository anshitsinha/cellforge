import type { CellRange } from "./types";

/**
 * Merged cells: rectangles that show as one cell (the top-left one). Kept
 * as a plain list; sheets have a handful, not millions.
 */

export function intersects(a: CellRange, b: CellRange): boolean {
  return a.top <= b.bottom && b.top <= a.bottom && a.left <= b.right && b.left <= a.right;
}

/** The merge containing (row, col), if any. */
export function mergeAt(merges: readonly CellRange[], row: number, col: number): CellRange | null {
  for (const m of merges) if (row >= m.top && row <= m.bottom && col >= m.left && col <= m.right) return m;
  return null;
}

/** Grow a range until no merge sticks out of it (a selection never cuts one in half). */
export function expandToMerges(range: CellRange, merges: readonly CellRange[]): CellRange {
  const r = { ...range };
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of merges) {
      if (!intersects(r, m)) continue;
      if (m.top < r.top || m.bottom > r.bottom || m.left < r.left || m.right > r.right) {
        r.top = Math.min(r.top, m.top);
        r.bottom = Math.max(r.bottom, m.bottom);
        r.left = Math.min(r.left, m.left);
        r.right = Math.max(r.right, m.right);
        grew = true;
      }
    }
  }
  return r;
}

/**
 * Merges after rows (axis "row") or columns are spliced at `at`: `remove`
 * deleted, then `insert` inserted. Deleting part of a merge shrinks it,
 * inserting inside one grows it, and a merge reduced to one cell is gone.
 */
export function spliceMerges(merges: readonly CellRange[], axis: "row" | "col", at: number, remove: number, insert: number): CellRange[] {
  const lo = axis === "row" ? "top" : "left";
  const hi = axis === "row" ? "bottom" : "right";
  const out: CellRange[] = [];
  for (const m0 of merges) {
    const m = { ...m0 };
    if (remove > 0) {
      const end = at + remove - 1;
      if (m[lo] > end) {
        m[lo] -= remove;
        m[hi] -= remove;
      } else if (m[hi] >= at) {
        const a = m[lo] < at ? m[lo] : at;
        const b = m[hi] > end ? m[hi] - remove : at - 1;
        if (b < a) continue;
        m[lo] = a;
        m[hi] = b;
      }
    }
    if (insert > 0) {
      if (m[lo] >= at) {
        m[lo] += insert;
        m[hi] += insert;
      } else if (m[hi] >= at) m[hi] += insert;
    }
    if (m.top === m.bottom && m.left === m.right) continue;
    out.push(m);
  }
  return out;
}
