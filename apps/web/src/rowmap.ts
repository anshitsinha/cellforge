/**
 * Which row id sits at each view row.
 *
 * Two shapes:
 * - runs: the view as a list of runs of consecutive ids ("ids 0-4999, then
 *   the 3 inserted ids 100000000-100000002, then ids 5000-99999999"). This is
 *   what inserting and deleting rows produce, and it stays a handful of
 *   numbers however big the sheet, so inserting a row into 100M rows is
 *   instant.
 * - array: one id per view row, after a sort, where there are no runs to
 *   speak of.
 */

/** Row ids as runs: [first id, count][]. */
export type IdRuns = [number, number][];

export function runsOf(ids: ArrayLike<number>): IdRuns {
  const out: IdRuns = [];
  for (let i = 0; i < ids.length; i++) {
    const last = out[out.length - 1];
    if (last && ids[i] === last[0] + last[1]) last[1]++;
    else out.push([ids[i], 1]);
  }
  return out;
}

export const runsLength = (runs: IdRuns) => runs.reduce((n, r) => n + r[1], 0);

export class RowMap {
  private constructor(
    private readonly arr: Uint32Array | null,
    /** view position where each run starts (ascending) */
    private readonly starts: number[],
    private readonly runs: IdRuns,
    readonly length: number,
  ) {}

  static fromArray(a: Uint32Array): RowMap {
    return new RowMap(a, [], [], a.length);
  }

  static fromRuns(runs: IdRuns): RowMap {
    const clean = runs.filter((r) => r[1] > 0);
    const merged: IdRuns = [];
    for (const [id, n] of clean) {
      const last = merged[merged.length - 1];
      if (last && last[0] + last[1] === id) last[1] += n;
      else merged.push([id, n]);
    }
    const starts: number[] = [];
    let pos = 0;
    for (const [, n] of merged) {
      starts.push(pos);
      pos += n;
    }
    return new RowMap(null, starts, merged, pos);
  }

  static identity(n: number): RowMap {
    return RowMap.fromRuns([[0, n]]);
  }

  /** True when this is one id per row (after a sort). */
  get isArray(): boolean {
    return this.arr !== null;
  }

  get runCount(): number {
    return this.runs.length;
  }

  /** The runs (runs shape only). */
  get idRuns(): IdRuns {
    return this.arr ? runsOf(this.arr) : this.runs.map((r) => [r[0], r[1]] as [number, number]);
  }

  private runAt(v: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  get(v: number): number {
    if (this.arr) return this.arr[v];
    const k = this.runAt(v);
    return this.runs[k][0] + (v - this.starts[k]);
  }

  forEach(fn: (id: number, v: number) => void): void {
    if (this.arr) {
      this.arr.forEach(fn);
      return;
    }
    let v = 0;
    for (const [id, n] of this.runs) for (let i = 0; i < n; i++) fn(id + i, v++);
  }

  /** One id per row (allocates for the runs shape). */
  toArray(): Uint32Array {
    if (this.arr) return this.arr;
    const out = new Uint32Array(this.length);
    let v = 0;
    for (const [id, n] of this.runs) for (let i = 0; i < n; i++) out[v++] = id + i;
    return out;
  }

  /** True when row v holds id v for every row, with exactly `baseRows` rows. */
  isIdentity(baseRows: number): boolean {
    if (this.length !== baseRows) return false;
    if (!this.arr) return this.runs.length === 0 || (this.runs.length === 1 && this.runs[0][0] === 0);
    for (let i = 0; i < this.arr.length; i++) if (this.arr[i] !== i) return false;
    return true;
  }

  /** Ids of view rows at..at+count-1, as runs. */
  slice(at: number, count: number): IdRuns {
    if (count <= 0) return [];
    if (this.arr) return runsOf(this.arr.subarray(at, at + count));
    const out: IdRuns = [];
    let k = this.runAt(at);
    let v = at;
    const end = at + count;
    while (v < end && k < this.runs.length) {
      const [id, n] = this.runs[k];
      const off = v - this.starts[k];
      const take = Math.min(n - off, end - v);
      out.push([id + off, take]);
      v += take;
      k++;
    }
    return out;
  }

  /** A new map with `remove` rows at `at` replaced by the `insert` ids; also the removed ids. */
  splice(at: number, remove: number, insert: IdRuns): { map: RowMap; removed: IdRuns } {
    const removed = this.slice(at, remove);
    if (this.arr) {
      const add = runsLength(insert);
      const next = new Uint32Array(this.length - remove + add);
      next.set(this.arr.subarray(0, at));
      let p = at;
      for (const [id, n] of insert) for (let i = 0; i < n; i++) next[p++] = id + i;
      next.set(this.arr.subarray(at + remove), p);
      return { map: RowMap.fromArray(next), removed };
    }
    const runs: IdRuns = [...this.slice(0, at), ...insert, ...this.slice(at + remove, this.length - at - remove)];
    return { map: RowMap.fromRuns(runs), removed };
  }

  /** id -> view row (-1 when not in the view). */
  inverse(idLimit: number): (id: number) => number {
    if (this.arr) {
      const inv = new Int32Array(idLimit).fill(-1);
      this.arr.forEach((id, v) => (inv[id] = v));
      return (id) => (id < inv.length ? inv[id] : -1);
    }
    // runs sorted by id, binary searched
    const byId = this.runs.map((r, k) => ({ id: r[0], n: r[1], start: this.starts[k] })).sort((a, b) => a.id - b.id);
    return (id) => {
      let lo = 0;
      let hi = byId.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = byId[mid];
        if (id < r.id) hi = mid - 1;
        else if (id >= r.id + r.n) lo = mid + 1;
        else return r.start + (id - r.id);
      }
      return -1;
    };
  }

  /** A sorted view expressed through this one: result[v] = this.get(viewOrder[v]). */
  compose(viewOrder: Uint32Array): Uint32Array {
    const out = new Uint32Array(viewOrder.length);
    if (this.arr) for (let i = 0; i < viewOrder.length; i++) out[i] = this.arr[viewOrder[i]];
    else for (let i = 0; i < viewOrder.length; i++) out[i] = this.get(viewOrder[i]);
    return out;
  }
}
