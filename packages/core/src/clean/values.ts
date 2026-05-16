/**
 * Parsing the values messy exports produce: accounting negatives, locale
 * number formats, currency symbols and codes, CR/DR, and dates in any
 * common format. Decisions that depend on the whole column (is 03/04 the
 * 3rd of April or March 4th? is "1.234" a thousand or one-point-something?)
 * are made per column by `profileColumn`.
 */
import { dateToSerial } from "../numfmt";

export type NumberStyle = "dot" | "comma"; // decimal separator
export type DateOrder = "dmy" | "mdy" | "ymd";

const CURRENCY = /^(?:[$€£¥₹]|USD|EUR|GBP|JPY|INR|CHF|CAD|AUD|SEK|NOK|DKK|ZAR|NZD|SGD|HKD|CNY)\s*|\s*(?:[$€£¥₹]|USD|EUR|GBP|JPY|INR|CHF|CAD|AUD|SEK|NOK|DKK|ZAR|NZD|SGD|HKD|CNY)$/gi;
const SPACES = /[\s\u00a0\u2007\u202f']/g; // thousands can be spaces or apostrophes (Swiss)

/** A number written any common way, or null. `style` says which separator is the decimal one. */
export function parseNumberLoose(raw: string, style: NumberStyle = "dot"): number | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  // (1,234.50) and -1,234.50 and 1,234.50- and 1,234.50 CR (credit = negative)
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  const crdr = /\s*(CR|DR|Cr|Dr|cr|dr)\.?$/.exec(s);
  if (crdr) {
    if (crdr[1].toLowerCase() === "cr") negative = !negative;
    s = s.slice(0, crdr.index).trim();
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) s = s.slice(1).trim();
  s = s.replace(CURRENCY, "").trim();
  if (s.startsWith("-")) {
    // $-12.00
    negative = !negative;
    s = s.slice(1);
  }
  let percent = false;
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(SPACES, "");
  if (style === "comma") s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  let n = Number(s);
  if (percent) n /= 100;
  return negative ? -n : n;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function valid(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && y >= 1900 && y <= 9999 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const year = (y: string) => (y.length <= 2 ? (Number(y) < 50 ? 2000 : 1900) + Number(y) : Number(y));

/** The three numbers of a numeric date, before deciding the order. */
export function dateParts(raw: string): [number, number, number] | null {
  const m = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})(?:[ T].*)?$/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** A date written any common way, as an Excel serial (with the time, if any), or null. */
export function parseDateLoose(raw: string, order: DateOrder = "dmy"): number | null {
  const s = raw.trim();
  if (!s) return null;
  // time part: 10:30, 10:30:15, 10:30 PM, T10:30:00Z
  let time = 0;
  const tm = /(?:[ T])(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(am|pm)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  let body = s;
  if (tm) {
    let h = Number(tm[1]);
    if (tm[4]) h = (h % 12) + (tm[4].toLowerCase() === "pm" ? 12 : 0);
    time = (h * 3600 + Number(tm[2]) * 60 + Number(tm[3] ?? 0)) / 86_400;
    body = s.slice(0, tm.index).trim();
  }
  let y: number, m: number, d: number;
  let mm: RegExpExecArray | null;
  if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(body)) || (mm = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(body))) {
    [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  } else if ((mm = /^(\d{4})(\d{2})(\d{2})$/.exec(body))) {
    [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  } else if ((mm = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(body))) {
    const a = Number(mm[1]);
    const b = Number(mm[2]);
    y = year(mm[3]);
    [d, m] = order === "mdy" ? [b, a] : [a, b];
  } else if ((mm = /^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})\.?[\s\-/.,]+(\d{2}|\d{4})$/.exec(body))) {
    [d, m, y] = [Number(mm[1]), MONTHS[mm[2].toLowerCase()] ?? 0, year(mm[3])];
  } else if ((mm = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(body))) {
    [m, d, y] = [MONTHS[mm[1].toLowerCase()] ?? 0, Number(mm[2]), Number(mm[3])];
  } else return null;
  if (!valid(y, m, d)) return null;
  return dateToSerial(y, m, d) + time;
}

export type ColumnType = "empty" | "number" | "date" | "text";

export interface ColumnProfile {
  type: ColumnType;
  /** how numbers are written in this column */
  numberStyle: NumberStyle;
  dateOrder: DateOrder;
  /** share of non-empty values that fit the type, 0..1 */
  confidence: number;
  /** values that didn't fit, with their row (index into the given list) */
  misfits: { row: number; value: string }[];
  hasTime: boolean;
  /** the format to show the column with, if it's a date or a percentage */
  numFmt?: string;
}

/**
 * Look at a column's values and decide what it is. Numbers vs dates vs text
 * goes by majority; day-first vs month-first by values that only fit one
 * way; decimal comma vs dot by how separators are used.
 */
export function profileColumn(values: string[]): ColumnProfile {
  const present = values.map((v, i) => [i, v.trim()] as const).filter(([, v]) => v !== "");
  const base: ColumnProfile = { type: "empty", numberStyle: "dot", dateOrder: "dmy", confidence: 1, misfits: [], hasTime: false };
  if (!present.length) return base;

  // decimal comma: "1.234,56" or "12,5" with no dot after a comma
  let commaVotes = 0;
  let dotVotes = 0;
  for (const [, v] of present.slice(0, 2000)) {
    if (/\d\.\d{3},\d/.test(v) || /^-?\d+,\d{1,2}$/.test(v.replace(/[^\d,.-]/g, ""))) commaVotes++;
    if (/\d,\d{3}\.\d/.test(v) || /^-?\d+\.\d+$/.test(v.replace(/[^\d,.-]/g, ""))) dotVotes++;
  }
  const numberStyle: NumberStyle = commaVotes > dotVotes ? "comma" : "dot";

  // day/month order: a first part over 12 means day-first, a second over 12 month-first
  let dmy = 0;
  let mdy = 0;
  let ymd = 0;
  for (const [, v] of present.slice(0, 5000)) {
    const p = dateParts(v);
    if (!p) continue;
    if (p[0] > 31) ymd++;
    else if (p[0] > 12) dmy++;
    else if (p[1] > 12) mdy++;
  }
  const dateOrder: DateOrder = ymd > dmy && ymd > mdy ? "ymd" : mdy > dmy ? "mdy" : "dmy";

  let nums = 0;
  let dates = 0;
  let hasTime = false;
  let percents = 0;
  for (const [, v] of present) {
    if (parseNumberLoose(v, numberStyle) !== null && !dateParts(v)) {
      nums++;
      if (v.endsWith("%")) percents++;
    } else if (parseDateLoose(v, dateOrder) !== null) {
      dates++;
      if (/\d:\d{2}/.test(v)) hasTime = true;
    }
  }
  const type: ColumnType = nums >= dates && nums / present.length >= 0.5 ? "number" : dates / present.length >= 0.5 ? "date" : "text";
  const fits = (v: string) =>
    type === "number" ? parseNumberLoose(v, numberStyle) !== null : type === "date" ? parseDateLoose(v, dateOrder) !== null : true;
  const misfits = present.filter(([, v]) => !fits(v)).map(([row, value]) => ({ row, value }));
  const numFmt = type === "date" ? (hasTime ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd") : type === "number" && percents > nums / 2 ? "0.0%" : undefined;
  return { type, numberStyle, dateOrder, confidence: 1 - misfits.length / present.length, misfits, hasTime, ...(numFmt ? { numFmt } : {}) };
}

/** A value parsed the way its column profile says (null when it doesn't fit). */
export function parseAs(value: string, p: ColumnProfile): number | null {
  if (p.type === "number") return parseNumberLoose(value, p.numberStyle);
  if (p.type === "date") return parseDateLoose(value, p.dateOrder);
  return null;
}
