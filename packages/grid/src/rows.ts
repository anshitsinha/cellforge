/**
 * Hidden rows, as sorted, merged intervals, so hiding a million rows (or a
 * filter hiding most of 100M) costs a few numbers, not a flag per row.
 *
 * Rows keep their real numbers (A6 is still A6 when row 5 is hidden); the
 * grid draws in *display* positions and converts at the edges.
 */
export class RowVisibility {
  private starts: number[] = [];
  private ends: number[] = []; // inclusive
  private hiddenBefore: number[] = []; // hidden rows in intervals before i
  private total = 0;

  /** Replace the hidden set. Intervals are [first, last] inclusive, any order. */
  set(intervals: readonly [number, number][]): void {
    const sorted = intervals.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
    this.starts = [];
    this.ends = [];
    for (const [a, b] of sorted) {
      const last = this.ends.length - 1;
      if (last >= 0 && a <= this.ends[last] + 1) this.ends[last] = Math.max(this.ends[last], b);
      else {
        this.starts.push(a);
        this.ends.push(b);
      }
    }
    this.hiddenBefore = [];
    let n = 0;
    for (let i = 0; i < this.starts.length; i++) {
      this.hiddenBefore.push(n);
      n += this.ends[i] - this.starts[i] + 1;
    }
    this.total = n;
  }

  get hiddenCount(): number {
    return this.total;
  }

  get intervals(): [number, number][] {
    return this.starts.map((s, i) => [s, this.ends[i]]);
  }

  /** Index of the last interval starting at or before `row`, or -1. */
  private find(row: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= row) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  isHidden(row: number): boolean {
    const i = this.find(row);
    return i >= 0 && row <= this.ends[i];
  }

  /** Hidden rows strictly before `row`. */
  private hiddenBeforeRow(row: number): number {
    const i = this.find(row - 1);
    if (i < 0) return 0;
    return this.hiddenBefore[i] + Math.min(this.ends[i], row - 1) - this.starts[i] + 1;
  }

  /** Display position of `row` (a hidden row maps to the next visible row's position). */
  toDisplay(row: number): number {
    return row - this.hiddenBeforeRow(row);
  }

  /** The real row shown at display position `d`. */
  toRow(d: number): number {
    // last interval whose start is at or before the answer: its display
    // start is starts[i] - hiddenBefore[i]
    let lo = 0;
    let hi = this.starts.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] - this.hiddenBefore[mid] <= d) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (ans < 0) return d;
    return d + this.hiddenBefore[ans] + (this.ends[ans] - this.starts[ans] + 1);
  }

  /** The nearest visible row from `row` going in `dir` (+1 down, -1 up); null past the edge. */
  nearest(row: number, dir: 1 | -1, rowCount: number): number | null {
    let r = row;
    while (r >= 0 && r < rowCount) {
      const i = this.find(r);
      if (i < 0 || r > this.ends[i]) return r;
      r = dir > 0 ? this.ends[i] + 1 : this.starts[i] - 1;
    }
    return null;
  }
}
