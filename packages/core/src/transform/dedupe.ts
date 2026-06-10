/**
 * Remove duplicates: which rows to keep when rows with the same key values
 * should appear only once. Nothing is deleted here; the caller gets the
 * indexes to keep and the indexes that would go.
 */
import type { Value } from "../table";

export interface RemoveDupOptions {
  /** "Acme" and "ACME" are the same key. */
  ignoreCase?: boolean;
  /** " Acme " and "Acme" are the same key (inner runs of spaces count as one too). */
  trim?: boolean;
  /** Which row of each group stays. Default "first". */
  keep?: "first" | "last";
}

export interface RemoveDupResult {
  /** Rows kept, in their original order. */
  kept: number[];
  /** Rows removed, in their original order. */
  removed: number[];
  /** For each removed row (same position as `removed`), the row kept in its place. */
  keptFor: number[];
  /** How many keys had more than one row. */
  groups: number;
}

/** A cell as part of a key. Numbers and the same number written as text match. */
function keyPart(v: Value | boolean | undefined, ignoreCase: boolean, trim: boolean): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? "n" + String(v) : "e" + String(v);
  let s = String(v);
  if (trim) s = s.trim().replace(/\s+/g, " ");
  if (ignoreCase) s = s.toLowerCase();
  if (s === "") return "";
  // "100" and 100 are the same value for this purpose, as in Excel
  const n = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s.trim()) ? Number(s.trim()) : NaN;
  return Number.isFinite(n) ? "n" + String(n) : "s" + s;
}

/**
 * Rows whose key columns all match are duplicates; one of each group stays.
 * Blank keys match other blank keys (Excel does the same). With no key
 * columns, the whole row is the key.
 */
export function removeDuplicates(rows: readonly (readonly (Value | boolean)[])[], keyCols: readonly number[], opts: RemoveDupOptions = {}): RemoveDupResult {
  const ignoreCase = opts.ignoreCase ?? false;
  const trim = opts.trim ?? false;
  const keepLast = opts.keep === "last";
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const cols = keyCols.length ? keyCols : Array.from({ length: width }, (_, i) => i);
  const keyOf = (r: readonly (Value | boolean)[]) => cols.map((c) => keyPart(r[c] as Value, ignoreCase, trim)).join("\u0000");

  const winner = new Map<string, number>();
  const size = new Map<string, number>();
  const keys: string[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const k = keyOf(rows[i]);
    keys[i] = k;
    size.set(k, (size.get(k) ?? 0) + 1);
    if (keepLast || !winner.has(k)) winner.set(k, i);
  }
  const kept: number[] = [];
  const removed: number[] = [];
  const keptFor: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const w = winner.get(keys[i])!;
    if (w === i) kept.push(i);
    else {
      removed.push(i);
      keptFor.push(w);
    }
  }
  let groups = 0;
  for (const n of size.values()) if (n > 1) groups++;
  return { kept, removed, keptFor, groups };
}
