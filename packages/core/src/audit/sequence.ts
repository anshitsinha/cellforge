/**
 * Sequence gaps: invoice, cheque or journal numbers that should run
 * without breaks. Works on plain numbers and on codes with a number in
 * them (INV-0001, CHQ 104562/A); codes with different text around the
 * number are separate series. Finds missing numbers (as ranges), numbers
 * used more than once, and numbers that come before a lower one in the
 * list (out of order).
 */
import type { Cell } from "./values";

export interface SequenceGap {
  from: number;
  to: number;
  count: number;
}

export interface SequenceSeries {
  /** Text before and after the number; "" for plain numbers. */
  prefix: string;
  suffix: string;
  /** Digits the number is padded to (INV-0001 is 4), 0 when not padded. */
  width: number;
  /** Rows in this series. */
  count: number;
  first: number;
  last: number;
  missing: SequenceGap[];
  missingCount: number;
  duplicates: { number: number; rows: number[] }[];
  /** Rows whose number is lower than the one before it in the series. */
  outOfOrder: { row: number; number: number; previous: number }[];
}

export interface SequenceResult {
  series: SequenceSeries[];
  /** Rows with no number to read (blank, or text without digits, or a fraction). */
  skipped: number[];
}

/** A number written the way the series writes them. */
export function sequenceCode(s: Pick<SequenceSeries, "prefix" | "suffix" | "width">, n: number): string {
  return s.prefix + String(n).padStart(s.width, "0") + s.suffix;
}

/** The text around the number and the number, or null. */
export function splitCode(v: Cell | undefined): { prefix: string; suffix: string; digits: string } | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? { prefix: "", suffix: "", digits: String(v) } : null;
  const m = /^(.*?)(\d+)(\D*)$/.exec(v.trim());
  if (!m) return null;
  // a decimal like 12.5 is not a document number
  if (/[.,]$/.test(m[1]) && /\d$/.test(m[1].slice(0, -1)) && !m[3]) return null;
  return { prefix: m[1], suffix: m[3], digits: m[2] };
}

export function sequenceGaps(values: Cell[]): SequenceResult {
  interface Acc {
    prefix: string;
    suffix: string;
    width: number;
    rows: number[];
    nums: number[];
  }
  const map = new Map<string, Acc>();
  const skipped: number[] = [];
  values.forEach((v, row) => {
    const c = splitCode(v);
    if (!c || c.digits.length > 15) {
      skipped.push(row);
      return;
    }
    const key = c.prefix + "\u0001" + c.suffix;
    let a = map.get(key);
    if (!a) map.set(key, (a = { prefix: c.prefix, suffix: c.suffix, width: 0, rows: [], nums: [] }));
    if (c.digits.length > 1 && c.digits[0] === "0") a.width = Math.max(a.width, c.digits.length);
    a.rows.push(row);
    a.nums.push(Number(c.digits));
  });

  const series: SequenceSeries[] = [];
  for (const a of map.values()) {
    const unique = [...new Set(a.nums)].sort((x, y) => x - y);
    const missing: SequenceGap[] = [];
    let missingCount = 0;
    for (let i = 1; i < unique.length; i++) {
      if (unique[i] - unique[i - 1] > 1) {
        const g = { from: unique[i - 1] + 1, to: unique[i] - 1, count: unique[i] - unique[i - 1] - 1 };
        missing.push(g);
        missingCount += g.count;
      }
    }
    const byNum = new Map<number, number[]>();
    a.nums.forEach((n, i) => {
      const rows = byNum.get(n);
      if (rows) rows.push(a.rows[i]);
      else byNum.set(n, [a.rows[i]]);
    });
    const duplicates = [...byNum].filter(([, rows]) => rows.length > 1).map(([number, rows]) => ({ number, rows }));
    duplicates.sort((x, y) => x.number - y.number);
    const outOfOrder: SequenceSeries["outOfOrder"] = [];
    for (let i = 1; i < a.nums.length; i++) {
      if (a.nums[i] < a.nums[i - 1]) outOfOrder.push({ row: a.rows[i], number: a.nums[i], previous: a.nums[i - 1] });
    }
    series.push({
      prefix: a.prefix,
      suffix: a.suffix,
      width: a.width,
      count: a.rows.length,
      first: unique[0],
      last: unique[unique.length - 1],
      missing,
      missingCount,
      duplicates,
      outOfOrder,
    });
  }
  series.sort((x, y) => y.count - x.count || (x.prefix < y.prefix ? -1 : 1));
  return { series, skipped };
}
