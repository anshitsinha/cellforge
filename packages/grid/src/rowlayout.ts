import type { RowVisibility } from "./rows";

/**
 * Vertical geometry of the rows on screen: every row is the default height
 * except a sparse set with their own. Positions are *display* positions
 * (hidden rows take no space), so a 100M-row sheet with a few tall rows
 * costs a few numbers, and top / indexAt are binary searches.
 */
export class RowLayout {
  /** display positions of rows with their own height, ascending */
  private disp: number[] = [];
  private heights: number[] = [];
  /** extra[i] = sum of (height - default) over disp[0..i-1] */
  private extra: number[] = [0];
  private rows = 0;

  constructor(readonly defaultHeight: number) {}

  /**
   * Rebuild from heights keyed by real row, the hidden rows, and the number
   * of display rows.
   */
  update(custom: ReadonlyMap<number, number>, hidden: RowVisibility, displayRows: number): void {
    const pairs: [number, number][] = [];
    for (const [row, h] of custom) {
      if (h === this.defaultHeight || hidden.isHidden(row)) continue;
      const d = hidden.toDisplay(row);
      if (d < displayRows) pairs.push([d, h]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    this.disp = pairs.map((p) => p[0]);
    this.heights = pairs.map((p) => p[1]);
    this.extra = [0];
    for (const [, h] of pairs) this.extra.push(this.extra[this.extra.length - 1] + h - this.defaultHeight);
    this.rows = displayRows;
  }

  get count(): number {
    return this.rows;
  }

  /** How many custom rows sit before display position d. */
  private before(d: number): number {
    let lo = 0;
    let hi = this.disp.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.disp[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  height(d: number): number {
    const i = this.before(d);
    return this.disp[i] === d ? this.heights[i] : this.defaultHeight;
  }

  /** Pixel offset of the top of display row d (d may be count, for the end). */
  top(d: number): number {
    return d * this.defaultHeight + this.extra[this.before(d)];
  }

  get total(): number {
    return this.top(this.rows);
  }

  /** The display row at pixel offset y (clamped to the rows that exist). */
  indexAt(y: number): number {
    if (this.rows === 0 || y <= 0) return 0;
    if (!this.disp.length) return Math.min(this.rows - 1, Math.floor(y / this.defaultHeight));
    let lo = 0;
    let hi = this.rows - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.top(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
