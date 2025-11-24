/**
 * Column widths + prefix sums so we can go from x-offset -> column index with a
 * binary search instead of walking every column.
 *
 * Rows don't get the same treatment on purpose: all rows share one height, so
 * row lookup is just `floor(y / rowHeight)`. Supporting variable row heights at
 * 100M rows would need a much fancier structure (fenwick tree or similar) and
 * isn't worth it yet.
 */
export class ColumnLayout {
  private widths: Float64Array;
  // offsets[i] = left edge of column i, offsets[count] = total width
  private offsets: Float64Array;

  constructor(
    readonly count: number,
    defaultWidth: number,
  ) {
    this.widths = new Float64Array(count).fill(defaultWidth);
    this.offsets = new Float64Array(count + 1);
    this.recompute(0);
  }

  width(col: number): number {
    return this.widths[col];
  }

  left(col: number): number {
    return this.offsets[col];
  }

  get totalWidth(): number {
    return this.offsets[this.count];
  }

  setWidth(col: number, width: number): void {
    this.widths[col] = width;
    this.recompute(col);
  }

  /** Index of the column containing x (clamped to the valid range). */
  indexAt(x: number): number {
    if (x <= 0) return 0;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private recompute(from: number): void {
    for (let i = from; i < this.count; i++) {
      this.offsets[i + 1] = this.offsets[i] + this.widths[i];
    }
  }
}

/** 0 -> A, 25 -> Z, 26 -> AA, ... */
export function columnLetter(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}
