/**
 * Turning a column into group codes for a pivot: every row gets the index of
 * its member (distinct value, or date bucket) in sorted order. Text columns
 * reuse their dictionary codes, so a 10M-row text field costs one pass over
 * a Uint32Array. Whole numbers in a modest range (dates, years, account
 * numbers) are coded through a direct table instead of a hash map.
 */
import type { ColumnData } from "../columns";
import { parseDateLoose, type DateOrder } from "../clean/values";
import { serialToParts } from "../numfmt";

/** A member of a field: a text, a number, or null for blank cells. */
export type PivotKey = string | number | null;

/** How a date field is bucketed. */
export type DateGroup = "year" | "quarter" | "month" | "day";

/** A field on the rows or columns of a pivot, optionally grouped by date. */
export interface PivotField {
  field: number;
  group?: DateGroup;
}

export interface FieldCoding {
  /** member index of each row */
  codes: Uint32Array;
  /** member keys in sorted order: numbers, then text, then blank (null) last */
  keys: PivotKey[];
  /** member labels, same order ("(blank)" for blank) */
  labels: string[];
}

export const BLANK_LABEL = "(blank)";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => (n < 10 ? "0" : "") + n;

/** The bucket key of a date serial: 2024, 20241 (2024 Q1), 202403, or the day serial. */
export function dateKey(serial: number, group: DateGroup): number {
  const day = Math.floor(serial);
  if (group === "day") return day;
  const p = serialToParts(day);
  if (group === "year") return p.y;
  if (group === "quarter") return p.y * 10 + Math.ceil(p.m / 3);
  return p.y * 100 + p.m;
}

/** "2024", "2024 Q1", "2024-03 Mar", "2024-03-15". */
export function dateKeyLabel(key: number, group: DateGroup): string {
  if (group === "year") return String(key);
  if (group === "quarter") return `${Math.floor(key / 10)} Q${key % 10}`;
  if (group === "month") {
    const m = key % 100;
    return `${Math.floor(key / 100)}-${pad2(m)} ${MONTHS[m - 1] ?? ""}`.trim();
  }
  const p = serialToParts(key);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** Numbers first (ascending), then text in natural order, blank last. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function compareKeys(a: PivotKey, b: PivotKey): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number") return typeof b === "number" ? a - b : -1;
  if (typeof b === "number") return 1;
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function labelOf(key: PivotKey, group: DateGroup | undefined): string {
  if (key === null) return BLANK_LABEL;
  if (typeof key === "string") return key;
  return group ? dateKeyLabel(key, group) : String(key);
}

/**
 * Members from per-row temporary ids: `raw[t]` is the value behind id t
 * (null for blank), `present[t]` says whether any row uses it. Returns the
 * sorted keys and the id -> member index table.
 */
function membersOf(raw: PivotKey[], present: Uint8Array, keyOf: (v: PivotKey) => PivotKey, group: DateGroup | undefined): { keys: PivotKey[]; labels: string[]; map: Uint32Array } {
  const byKey = new Map<PivotKey, number>();
  const tempKey: (PivotKey | undefined)[] = new Array(raw.length);
  for (let t = 0; t < raw.length; t++) {
    if (!present[t]) continue;
    const k = raw[t] === null ? null : keyOf(raw[t]);
    tempKey[t] = k;
    byKey.set(k, 0);
  }
  const keys = [...byKey.keys()].sort(compareKeys);
  keys.forEach((k, i) => byKey.set(k, i));
  const map = new Uint32Array(raw.length);
  for (let t = 0; t < raw.length; t++) if (present[t]) map[t] = byKey.get(tempKey[t]!)!;
  return { keys, labels: keys.map((k) => labelOf(k, group)), map };
}

// a direct table is used when whole numbers span at most this many values
const DIRECT_SPAN = 1 << 22;

/** Code one column for grouping. `dateOrder` is for reading text dates when grouping by date. */
export function codeField(column: ColumnData, group?: DateGroup, dateOrder: DateOrder = "dmy"): FieldCoding {
  if (column.kind === "string") return codeText(column, group, dateOrder);
  return codeNumbers(column.values, group);
}

function codeText(column: ColumnData & { kind: "string" }, group: DateGroup | undefined, order: DateOrder): FieldCoding {
  const src = column.codes;
  const n = src.length;
  const present = new Uint8Array(column.dict.length + 1);
  for (let i = 0; i < n; i++) present[src[i]] = 1;
  const raw: PivotKey[] = [null, ...column.dict];
  const keyOf = group
    ? (v: PivotKey): PivotKey => {
        const s = parseDateLoose(String(v), order);
        return s === null ? String(v) : dateKey(s, group);
      }
    : (v: PivotKey) => v;
  const m = membersOf(raw, present, keyOf, group);
  const codes = new Uint32Array(n);
  const map = m.map;
  for (let i = 0; i < n; i++) codes[i] = map[src[i]];
  return { codes, keys: m.keys, labels: m.labels };
}

function codeNumbers(values: Float64Array, group: DateGroup | undefined): FieldCoding {
  const n = values.length;
  let min = Infinity;
  let max = -Infinity;
  let whole = true;
  for (let i = 0; i < n; i++) {
    let v = values[i];
    if (v !== v) continue;
    if (group) v = Math.floor(v);
    else if (whole && v !== Math.floor(v)) whole = false;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const keyOf = group ? (v: PivotKey) => dateKey(v as number, group) : (v: PivotKey) => v;
  const codes = new Uint32Array(n);

  if (min > max || (whole && Number.isFinite(min) && max - min < DIRECT_SPAN)) {
    // temp id 0 = blank, 1 + (v - min) otherwise
    const span = min > max ? 0 : max - min + 1;
    const present = new Uint8Array(span + 1);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      const t = v !== v ? 0 : 1 + (group ? Math.floor(v) : v) - min;
      codes[i] = t;
      present[t] = 1;
    }
    const raw: PivotKey[] = new Array(span + 1);
    raw[0] = null;
    for (let t = 1; t <= span; t++) raw[t] = min + t - 1;
    const m = membersOf(raw, present, keyOf, group);
    const map = m.map;
    for (let i = 0; i < n; i++) codes[i] = map[codes[i]];
    return { codes, keys: m.keys, labels: m.labels };
  }

  // anything else: hash the distinct values
  const ids = new Map<number, number>();
  const raw: PivotKey[] = [null];
  for (let i = 0; i < n; i++) {
    let v = values[i];
    if (v !== v) {
      codes[i] = 0;
      continue;
    }
    if (group) v = Math.floor(v);
    let t = ids.get(v);
    if (t === undefined) {
      t = raw.length;
      raw.push(v);
      ids.set(v, t);
    }
    codes[i] = t;
  }
  const present = new Uint8Array(raw.length).fill(1);
  present[0] = 0;
  for (let i = 0; i < n; i++) if (codes[i] === 0) {
    present[0] = 1;
    break;
  }
  const m = membersOf(raw, present, keyOf, group);
  const map = m.map;
  for (let i = 0; i < n; i++) codes[i] = map[codes[i]];
  return { codes, keys: m.keys, labels: m.labels };
}

/** Members of a field with their row counts, e.g. for a slicer checklist. */
export function fieldMembers(column: ColumnData, group?: DateGroup, dateOrder: DateOrder = "dmy"): { key: PivotKey; label: string; count: number }[] {
  const c = codeField(column, group, dateOrder);
  const counts = new Float64Array(c.keys.length);
  for (let i = 0; i < c.codes.length; i++) counts[c.codes[i]]++;
  return c.keys.map((key, i) => ({ key, label: c.labels[i], count: counts[i] }));
}
