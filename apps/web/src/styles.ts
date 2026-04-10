import type { CellStyle } from "@cellforge/grid";

/**
 * Cell formatting, built to stay small at any size.
 *
 * Every distinct look is stored once in a StyleTable and referred to by a
 * number. Each column keeps a column-wide style plus sorted runs of row ids
 * that look different, so "make column B bold" is one entry whether the sheet
 * has ten rows or a hundred million, and "make B2:B900000 red" is one run.
 *
 * Runs are keyed by *row id*, not position, so formatting moves with its row
 * through sorts, inserts and deletes without any bookkeeping, and undoing a
 * delete brings the formatting back with the data.
 */

/** A change to a style: a value sets the property, null clears it. */
export type StylePatch = { [K in keyof CellStyle]?: CellStyle[K] | null };

const KEYS: (keyof CellStyle)[] = [
  "bold",
  "italic",
  "underline",
  "strike",
  "size",
  "font",
  "color",
  "fill",
  "align",
  "valign",
  "wrap",
  "numFmt",
  "borderTop",
  "borderRight",
  "borderBottom",
  "borderLeft",
];

function keyOf(style: CellStyle): string {
  const parts: string[] = [];
  for (const k of KEYS) {
    const v = style[k];
    if (v !== undefined && v !== false) parts.push(`${k}:${JSON.stringify(v)}`);
  }
  return parts.join(";");
}

/** Interned styles. Id 0 is the default look. Append-only, so safe to share. */
export class StyleTable {
  private records: CellStyle[] = [{}];
  private ids = new Map<string, number>([["", 0]]);
  private merged = new Map<string, number>();

  intern(style: CellStyle): number {
    const key = keyOf(style);
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.records.length;
      const clean: CellStyle = {};
      for (const k of KEYS) {
        const v = style[k];
        if (v !== undefined && v !== false) (clean as Record<string, unknown>)[k] = v;
      }
      this.records.push(Object.freeze(clean));
      this.ids.set(key, id);
    }
    return id;
  }

  get(id: number): CellStyle {
    return this.records[id];
  }

  get size(): number {
    return this.records.length;
  }

  /** Every record, by id (id 0 is the default look). */
  get all(): readonly CellStyle[] {
    return this.records;
  }

  /** A table with these records at exactly these ids. */
  static from(records: CellStyle[]): StyleTable {
    const t = new StyleTable();
    for (let i = 1; i < records.length; i++) {
      const id = t.intern(records[i]);
      // keys are canonical, so a saved table re-interns to the same ids;
      // a duplicate (shouldn't happen) still gets a slot to keep ids aligned
      if (id !== i) {
        t.records.push(Object.freeze({ ...records[i] }));
      }
    }
    return t;
  }

  /** The style `id` with `patch` applied, interned. Cached per (id, patch). */
  apply(id: number, patch: StylePatch, patchKey = JSON.stringify(patch)): number {
    const cacheKey = `${id}|${patchKey}`;
    const hit = this.merged.get(cacheKey);
    if (hit !== undefined) return hit;
    const next: Record<string, unknown> = { ...this.records[id] };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    const out = this.intern(next as CellStyle);
    this.merged.set(cacheKey, out);
    return out;
  }
}

/**
 * Sorted, non-overlapping runs [start, end] (inclusive) of row ids with a
 * style id each. Rows not in any run use the column's style (`gap`).
 */
export class RunList {
  constructor(
    public starts: number[] = [],
    public ends: number[] = [],
    public ids: number[] = [],
  ) {}

  clone(): RunList {
    return new RunList(this.starts.slice(), this.ends.slice(), this.ids.slice());
  }

  get length(): number {
    return this.starts.length;
  }

  /** Style id for row id `row`, or -1 when no run covers it. */
  find(row: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] > row) hi = mid - 1;
      else if (this.ends[mid] < row) lo = mid + 1;
      else return this.ids[mid];
    }
    return -1;
  }

  /**
   * Restyle every row id inside `intervals` (sorted, disjoint, inclusive):
   * each row's style id becomes fn(old), where rows without a run start from
   * `gap`. Runs equal to the gap style are dropped; neighbours merge. One
   * pass, so restyling a scattered million rows after a sort is linear.
   */
  applyMany(intervals: readonly [number, number][], fn: (id: number) => number, gap: number): void {
    const starts = this.starts.slice();
    const { ends, ids } = this;
    const n = starts.length;
    const os: number[] = [];
    const oe: number[] = [];
    const oi: number[] = [];
    const push = (s: number, e: number, id: number) => {
      if (id === gap || e < s) return;
      const last = os.length - 1;
      if (last >= 0 && oe[last] === s - 1 && oi[last] === id) oe[last] = e;
      else {
        os.push(s);
        oe.push(e);
        oi.push(id);
      }
    };
    let i = 0;
    for (const [lo, hi] of intervals) {
      while (i < n && ends[i] < lo) {
        push(starts[i], ends[i], ids[i]);
        i++;
      }
      if (i < n && starts[i] < lo) {
        push(starts[i], lo - 1, ids[i]);
        starts[i] = lo;
      }
      let p = lo;
      while (p <= hi) {
        if (i < n && starts[i] <= p) {
          const e = Math.min(ends[i], hi);
          push(p, e, fn(ids[i]));
          p = e + 1;
          if (ends[i] <= hi) i++;
          else starts[i] = hi + 1;
        } else {
          const e = i < n ? Math.min(hi, starts[i] - 1) : hi;
          push(p, e, fn(gap));
          p = e + 1;
        }
      }
    }
    for (; i < n; i++) push(starts[i], ends[i], ids[i]);
    this.starts = os;
    this.ends = oe;
    this.ids = oi;
  }

  /** Restyle every run (for a whole-column change); drops runs equal to `gap`. */
  mapAll(fn: (id: number) => number, gap: number): void {
    // the runs themselves as intervals: no gaps inside, so only runs change
    this.applyMany(
      this.starts.map((s, i) => [s, this.ends[i]]),
      fn,
      gap,
    );
  }
}

/** One column's formatting. */
export interface ColumnStyles {
  /** style of every row without a run */
  base: number;
  runs: RunList;
}

/** The formatting of one sheet, by view column and row id. */
export class SheetStyles {
  constructor(
    readonly table: StyleTable = new StyleTable(),
    private cols = new Map<number, ColumnStyles>(),
  ) {}

  clone(): SheetStyles {
    const cols = new Map<number, ColumnStyles>();
    for (const [c, e] of this.cols) cols.set(c, { base: e.base, runs: e.runs.clone() });
    return new SheetStyles(this.table, cols);
  }

  get isEmpty(): boolean {
    return this.cols.size === 0;
  }

  /** Style for row id `row` in column `col`, or null for the default. */
  get(row: number, col: number): CellStyle | null {
    const e = this.cols.get(col);
    if (!e) return null;
    const id = e.runs.length ? e.runs.find(row) : -1;
    const use = id >= 0 ? id : e.base;
    return use === 0 ? null : this.table.get(use);
  }

  /** The column's entry, copied, for undo (undefined: column unformatted). */
  snapshot(col: number): ColumnStyles | undefined {
    const e = this.cols.get(col);
    return e && { base: e.base, runs: e.runs.clone() };
  }

  restore(col: number, entry: ColumnStyles | undefined): void {
    if (entry && (entry.base !== 0 || entry.runs.length)) this.cols.set(col, entry);
    else this.cols.delete(col);
  }

  /**
   * Apply `patch` to rows (id intervals, sorted and disjoint) of column
   * `col`; `whole` means every row, now and future, so it goes on the column.
   */
  apply(col: number, rows: readonly [number, number][] | "all", patch: StylePatch): void {
    const key = JSON.stringify(patch);
    const e = this.cols.get(col) ?? { base: 0, runs: new RunList() };
    const fn = (id: number) => this.table.apply(id, patch, key);
    if (rows === "all") {
      e.base = fn(e.base);
      e.runs.mapAll(fn, e.base);
    } else {
      e.runs.applyMany(rows, fn, e.base);
    }
    this.restore(col, e);
  }

  /** Columns from `from` on move by `delta` (insert or delete columns). */
  shift(from: number, delta: number): void {
    const next = new Map<number, ColumnStyles>();
    for (const [c, e] of this.cols) next.set(c >= from ? c + delta : c, e);
    this.cols = next;
  }

  /** Take out columns at..at+count-1 (for a delete); returns them for undo. */
  remove(at: number, count: number): [number, ColumnStyles][] {
    const out: [number, ColumnStyles][] = [];
    for (const [c, e] of this.cols) if (c >= at && c < at + count) out.push([c, e]);
    for (const [c] of out) this.cols.delete(c);
    return out;
  }

  putBack(entries: readonly [number, ColumnStyles][]): void {
    for (const [c, e] of entries) this.cols.set(c, e);
  }

  toState(): StylesState {
    return {
      records: this.table.all.slice(1).map((r) => ({ ...r })),
      cols: [...this.cols].map(([col, e]) => ({ col, base: e.base, starts: e.runs.starts, ends: e.runs.ends, ids: e.runs.ids })),
    };
  }

  static fromState(state: StylesState): SheetStyles {
    const table = StyleTable.from([{}, ...state.records]);
    const cols = new Map<number, ColumnStyles>();
    for (const c of state.cols) cols.set(c.col, { base: c.base, runs: new RunList(c.starts.slice(), c.ends.slice(), c.ids.slice()) });
    return new SheetStyles(table, cols);
  }
}

/** Formatting as plain data, for saving. */
export interface StylesState {
  records: CellStyle[];
  cols: { col: number; base: number; starts: number[]; ends: number[]; ids: number[] }[];
}

/** A patch that clears every property (for "clear formatting"). */
export const CLEAR_ALL: StylePatch = Object.fromEntries(KEYS.map((k) => [k, null]));
