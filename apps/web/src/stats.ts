import type { CellRange, DataSource } from "@cellforge/grid";

export interface RangeStats {
  sum: number;
  numbers: number; // how many numeric cells (the average's denominator)
  count: number; // non-empty cells of any type
}

const CELLS_PER_SLICE = 500_000;

/**
 * Sum / count over a selection, computed in slices so selecting a whole
 * 100M-row column doesn't freeze the tab. Returns null if `isStale()` starts
 * returning true (the selection changed) before it finishes.
 *
 * This goes through getCell() for every cell, so it's the slow generic path.
 * Once the columnar store does aggregates natively this should call that
 * instead - summing a Float64Array directly is much faster.
 */
export async function computeStats(
  source: DataSource,
  range: CellRange,
  isStale: () => boolean,
  onProgress: (fraction: number) => void,
): Promise<RangeStats | null> {
  let sum = 0;
  let numbers = 0;
  let count = 0;
  let sinceYield = 0;
  const totalRows = range.bottom - range.top + 1;
  const width = range.right - range.left + 1;

  for (let r = range.top; r <= range.bottom; r++) {
    for (let c = range.left; c <= range.right; c++) {
      const v = source.getCell(r, c);
      if (v === null) continue;
      count++;
      if (typeof v === "number") {
        sum += v;
        numbers++;
      }
    }
    sinceYield += width;
    if (sinceYield >= CELLS_PER_SLICE) {
      sinceYield = 0;
      onProgress((r - range.top + 1) / totalRows);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (isStale()) return null;
    }
  }
  return { sum, numbers, count };
}
