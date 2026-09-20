import type { CellRange } from "@cellforge/grid";
import type { EditableSource } from "./editable";

export interface RangeStats {
  sum: number;
  numbers: number; // how many numeric cells (the average's denominator)
  count: number; // non-empty cells of any type
}

const CELLS_PER_SLICE = 500_000;

/**
 * Sum / count over a selection.
 *
 * Columns that come straight from an imported file (untouched, so the typed
 * array is the truth) are summed directly from the Float64Array - a whole
 * 100M-row column takes a fraction of a second that way. Everything else goes
 * through getCell, in slices, so selecting a huge range doesn't freeze the
 * tab. Returns null if `isStale()` turns true before it finishes.
 */
export async function computeStats(
  source: EditableSource,
  range: CellRange,
  isStale: () => boolean,
  onProgress: (fraction: number) => void,
): Promise<RangeStats | null> {
  const stats: RangeStats = { sum: 0, numbers: 0, count: 0 };
  const slowCols: number[] = [];

  for (let c = range.left; c <= range.right; c++) {
    if (!addColumnFast(source, c, range.top, range.bottom, stats)) slowCols.push(c);
  }
  if (slowCols.length === 0) return stats;

  let sinceYield = 0;
  const totalRows = range.bottom - range.top + 1;
  for (let r = range.top; r <= range.bottom; r++) {
    for (const c of slowCols) {
      const v = source.getCell(r, c);
      if (v === null) continue;
      stats.count++;
      if (typeof v === "number") {
        stats.sum += v;
        stats.numbers++;
      }
    }
    sinceYield += slowCols.length;
    if (sinceYield >= CELLS_PER_SLICE) {
      sinceYield = 0;
      onProgress((r - range.top + 1) / totalRows);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (isStale()) return null;
    }
  }
  return stats;
}

/** Add one column's stats from its typed array. Returns false if it can't. */
function addColumnFast(
  source: EditableSource,
  col: number,
  top: number,
  bottom: number,
  stats: RangeStats,
): boolean {
  const column = source.baseColumn(col);
  if (!column) return false;
  // with a sort applied, rows top..bottom are scattered across the array -
  // only a whole-column selection can ignore the order
  const whole = top === 0 && bottom === source.rowCount - 1;
  if (source.rowOrder && !whole) return false;

  if (column.kind === "number") {
    const v = column.values;
    let sum = 0;
    let n = 0;
    for (let r = top; r <= bottom; r++) {
      const x = v[r];
      if (x === x) {
        // x === x is a NaN check that V8 optimises better than Number.isNaN
        sum += x;
        n++;
      }
    }
    stats.sum += sum;
    stats.numbers += n;
    stats.count += n;
  } else {
    let n = 0;
    for (let r = top; r <= bottom; r++) if (column.codes[r] !== 0) n++;
    stats.count += n;
  }
  return true;
}
