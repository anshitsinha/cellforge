/**
 * Compare two versions of a file row by row on a key: rows added, rows
 * removed, rows whose other columns changed (with the old and new value of
 * each), and how many stayed the same.
 */
import { rowKey, showKey, textNumber, type KeyNormalise, type KeyValue } from "./keys";

export type CompareRow = ArrayLike<KeyValue>;

export interface CompareOptions {
  /** how keys are compared */
  normalise?: KeyNormalise;
  /** numbers this close count as unchanged */
  tolerance?: number;
  /** text compared ignoring case */
  ignoreCase?: boolean;
  /** text compared ignoring spaces at the ends and doubled inside */
  trim?: boolean;
}

export interface CellChange {
  /** the compared column (an index into the rows) */
  col: number;
  old: KeyValue;
  new: KeyValue;
  /** new − old when both are numbers */
  diff: number | null;
}

export interface ChangedRow {
  old: number;
  new: number;
  key: string;
  cells: CellChange[];
}

export interface CompareResult {
  /** rows of the new version whose key isn't in the old */
  added: number[];
  /** rows of the old version whose key isn't in the new */
  removed: number[];
  changed: ChangedRow[];
  unchanged: number;
  /** keys on more than one row; the nth old row pairs with the nth new one */
  duplicates: Array<{ side: "old" | "new"; key: string; count: number }>;
  /** rows with a blank key, left out */
  blankOld: number;
  blankNew: number;
}

const isBlank = (v: KeyValue) => v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));

function asNumber(v: KeyValue): number | null {
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v === "string") return textNumber(v);
  return null;
}

/** Whether two cell values are the same under the options; numbers (and text that reads as one) compare as numbers. */
export function sameValue(a: KeyValue, b: KeyValue, o: CompareOptions = {}): boolean {
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null && (typeof a === "number" || typeof b === "number" || (typeof a === "string" && typeof b === "string" && a.trim() !== b.trim()))) {
    return Math.abs(na - nb) <= (o.tolerance ?? 0) + 1e-9 * Math.max(1, Math.abs(na), Math.abs(nb));
  }
  let sa = String(a);
  let sb = String(b);
  if (o.trim) {
    sa = sa.replace(/[\s ]+/g, " ").trim();
    sb = sb.replace(/[\s ]+/g, " ").trim();
  }
  if (o.ignoreCase) {
    sa = sa.toUpperCase();
    sb = sb.toUpperCase();
  }
  return sa === sb;
}

/**
 * Compare old and new rows on `keyCols`, checking `compareCols` (indices
 * into each row; the same layout on both sides). Rows keep their order:
 * added in new-file order, removed and changed in old-file order.
 */
export function compareByKey(oldRows: ReadonlyArray<CompareRow>, newRows: ReadonlyArray<CompareRow>, keyCols: readonly number[], compareCols: readonly number[], opts: CompareOptions = {}): CompareResult {
  const o = opts.normalise ?? {};
  const keysOf = (rows: ReadonlyArray<CompareRow>) => {
    const out = new Array<string | null>(rows.length);
    const tmp: KeyValue[][] = keyCols.map(() => [null]);
    for (let r = 0; r < rows.length; r++) {
      for (let i = 0; i < keyCols.length; i++) tmp[i][0] = rows[r][keyCols[i]];
      out[r] = rowKey(tmp, 0, o);
    }
    return out;
  };
  const ko = keysOf(oldRows);
  const kn = keysOf(newRows);

  // new rows by key, in order; the nth old row with a key takes the nth new one
  const byKey = new Map<string, number[]>();
  let blankNew = 0;
  kn.forEach((k, r) => {
    if (k === null) {
      blankNew++;
      return;
    }
    const l = byKey.get(k);
    if (l) l.push(r);
    else byKey.set(k, [r]);
  });
  const taken = new Map<string, number>();
  const usedNew = new Uint8Array(newRows.length);
  const removed: number[] = [];
  const changed: ChangedRow[] = [];
  let unchanged = 0;
  let blankOld = 0;
  const oldCount = new Map<string, number>();
  ko.forEach((k, r) => {
    if (k === null) {
      blankOld++;
      return;
    }
    oldCount.set(k, (oldCount.get(k) ?? 0) + 1);
    const list = byKey.get(k);
    const n = taken.get(k) ?? 0;
    if (!list || n >= list.length) {
      removed.push(r);
      return;
    }
    taken.set(k, n + 1);
    const nr = list[n];
    usedNew[nr] = 1;
    const cells: CellChange[] = [];
    for (const c of compareCols) {
      const a = oldRows[r][c];
      const b = newRows[nr][c];
      if (sameValue(a, b, opts)) continue;
      const na = asNumber(a);
      const nb = asNumber(b);
      cells.push({ col: c, old: a, new: b, diff: na !== null && nb !== null ? Math.round((nb - na) * 1e9) / 1e9 : null });
    }
    if (cells.length) changed.push({ old: r, new: nr, key: showKey(k), cells });
    else unchanged++;
  });
  const added: number[] = [];
  kn.forEach((k, r) => {
    if (k !== null && !usedNew[r]) added.push(r);
  });
  const duplicates: CompareResult["duplicates"] = [];
  for (const [k, n] of oldCount) if (n > 1) duplicates.push({ side: "old", key: showKey(k), count: n });
  for (const [k, l] of byKey) if (l.length > 1) duplicates.push({ side: "new", key: showKey(k), count: l.length });
  return { added, removed, changed, unchanged, duplicates, blankOld, blankNew };
}
