/**
 * Join keys: what a cell value turns into before two sides are compared.
 * By default a key is compared exactly (the number 123 is not the text
 * "123", "abc" is not "ABC"); each normalisation relaxes one thing.
 */
import { normRef } from "../recon/text";

/** A cell value as a key: blank (null, undefined, "") never matches anything. */
export type KeyValue = string | number | boolean | null | undefined;

/** Key columns, one array per column, all the same length. */
export type KeyColumns = ReadonlyArray<ArrayLike<KeyValue>>;

export interface KeyNormalise {
  /** trim and collapse runs of spaces (tabs, non-breaking spaces) */
  trim?: boolean;
  /** ignore upper / lower case */
  case?: boolean;
  /** numbers stored as text ("00123", "1,234.00") compare as the number */
  numbers?: boolean;
  /** ignore spaces and punctuation ("AB-12" = "AB 12" = "AB12") */
  punctuation?: boolean;
  /** drop leading zeros ("000123A" = "123A") */
  leadingZeros?: boolean;
  /** reference rules: case, spaces, punctuation, leading zeros and a known prefix (INV, REF, PO, ...) ignored */
  ref?: boolean;
}

export type NormaliseOption = keyof KeyNormalise;
export const NORMALISE_OPTIONS: readonly NormaliseOption[] = ["trim", "case", "numbers", "punctuation", "leadingZeros", "ref"];
export const NORMALISE_LABEL: Record<NormaliseOption, string> = {
  trim: "Trim spaces",
  case: "Ignore case",
  numbers: "Numbers stored as text = numbers",
  punctuation: "Ignore spaces and punctuation",
  leadingZeros: "Ignore leading zeros",
  ref: "Reference rules (INV-00123 = 123)",
};

/** Numbers as text, the way they key: whole numbers without ".0", others to 10 significant places so 0.1+0.2 = 0.3. */
export function numberKey(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

const PLAIN_NUMBER = /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$|^[+-]?\.\d+$/;

/** A text value read as a plain number ("00123", "1,234.50", "-7"), or null. Dates, codes and words aren't numbers. */
export function textNumber(s: string): number | null {
  const t = s.trim();
  if (!t || !PLAIN_NUMBER.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const NUM = "\u0002"; // marks a number, so 123 and "123" stay apart unless `numbers` is on
const SEP = "\u0001"; // between the columns of a multi-column key

/** One value as a key part, or null for blank. */
export function keyPart(v: KeyValue, o: KeyNormalise = {}): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return null;
    if (o.ref) return normRef(numberKey(v)) || null;
    return o.numbers ? numberKey(v) : NUM + numberKey(v);
  }
  let s = v;
  if (o.ref) return normRef(s) || null;
  if (o.trim) s = s.replace(/[\s ]+/g, " ").trim();
  if (!s) return null;
  if (o.numbers) {
    const n = textNumber(s);
    if (n !== null) return numberKey(n);
  }
  if (o.case) s = s.toUpperCase();
  if (o.punctuation) s = s.replace(/[^\p{L}\p{N}]+/gu, "");
  if (o.leadingZeros) s = s.replace(/^0+(?=.)/, "");
  return s ? s : null;
}

/** The key of row `r`, or null when any part is blank. */
export function rowKey(cols: KeyColumns, r: number, o: KeyNormalise = {}): string | null {
  if (cols.length === 1) return keyPart(cols[0][r], o);
  let out = "";
  for (let c = 0; c < cols.length; c++) {
    const p = keyPart(cols[c][r], o);
    if (p === null) return null;
    out += c ? SEP + p : p;
  }
  return out;
}

/** Number of rows in a set of key columns. */
export function rowCount(cols: KeyColumns): number {
  return cols.length ? cols[0].length : 0;
}

/** A key as people read it: the parts joined by " | ", numbers without their marker. */
export function showKey(key: string): string {
  return key.split(SEP).map((p) => (p.startsWith(NUM) ? p.slice(1) : p)).join(" | ");
}

/** A row's key values as text for fuzzy comparison, joined by spaces. */
export function rowText(cols: KeyColumns, r: number): string {
  let out = "";
  for (let c = 0; c < cols.length; c++) {
    const v = cols[c][r];
    if (v === null || v === undefined || v === "") continue;
    out += (out ? " " : "") + String(v);
  }
  return out;
}

/** Every row's key (null for blank). */
export function allKeys(cols: KeyColumns, o: KeyNormalise = {}): Array<string | null> {
  const n = rowCount(cols);
  const out = new Array<string | null>(n);
  for (let r = 0; r < n; r++) out[r] = rowKey(cols, r, o);
  return out;
}
