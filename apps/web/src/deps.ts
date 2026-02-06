/**
 * Which formulas read which rectangles of a sheet. Each dependent (a formula
 * cell, or a whole filled block) registers the rectangles it reads; asking
 * "who reads this rectangle?" returns every dependent whose rectangles
 * overlap it. Entries are bucketed by column, since edits are usually narrow.
 */
export interface Rect {
  top: number;
  bottom: number; // inclusive; Infinity for whole columns
  left: number;
  right: number; // inclusive
}

interface Entry<D> {
  rect: Rect;
  dep: D;
}

export class DepIndex<D> {
  private byCol = new Map<number, Set<Entry<D>>>();
  private byDep = new Map<D, Entry<D>[]>();

  /** Register what `dep` reads, replacing anything it registered before. */
  set(dep: D, rects: Rect[]): void {
    this.delete(dep);
    if (!rects.length) return;
    const entries = rects.map((rect) => ({ rect, dep }));
    for (const e of entries) {
      for (let c = e.rect.left; c <= e.rect.right; c++) {
        let bucket = this.byCol.get(c);
        if (!bucket) this.byCol.set(c, (bucket = new Set()));
        bucket.add(e);
      }
    }
    this.byDep.set(dep, entries);
  }

  delete(dep: D): void {
    const entries = this.byDep.get(dep);
    if (!entries) return;
    for (const e of entries) {
      for (let c = e.rect.left; c <= e.rect.right; c++) {
        const bucket = this.byCol.get(c);
        bucket?.delete(e);
        if (bucket && bucket.size === 0) this.byCol.delete(c);
      }
    }
    this.byDep.delete(dep);
  }

  /** Every dependent reading any cell of `rect`. */
  readersOf(rect: Rect): Set<D> {
    const out = new Set<D>();
    for (let c = rect.left; c <= rect.right; c++) {
      const bucket = this.byCol.get(c);
      if (!bucket) continue;
      for (const e of bucket) {
        if (e.rect.top <= rect.bottom && rect.top <= e.rect.bottom) out.add(e.dep);
      }
    }
    return out;
  }

  clear(): void {
    this.byCol.clear();
    this.byDep.clear();
  }

  get size(): number {
    return this.byDep.size;
  }
}
