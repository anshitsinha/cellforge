/**
 * Extract by pattern: pull an email, phone number, URL, number, amount,
 * date, invoice-like code, the reference after a keyword, or whatever a
 * custom regular expression captures, out of free text such as bank
 * narratives and memo lines.
 */
import { dateParts, parseDateLoose, parseNumberLoose, type DateOrder } from "../clean/values";
import type { Value } from "../table";

export type PatternKind = "email" | "phone" | "url" | "number" | "amount" | "date" | "code" | "after" | "regex";

export type PatternSpec =
  | { kind: "email" | "phone" | "url" | "number" | "amount" | "date" | "code" }
  /** The reference that follows a keyword, such as "Ref:" or "Invoice No". */
  | { kind: "after"; keyword: string }
  /** A regular expression; its first capture group if it has one, else the whole match. */
  | { kind: "regex"; regex: string; ignoreCase?: boolean };

export interface ExtractOptions {
  /** Every match joined with "; " instead of only the first. Numbers, amounts and dates then come back as text. */
  all?: boolean;
  /** For dates such as 03/04/2024. Default: guessed from the matches. */
  dateOrder?: DateOrder;
}

export interface ExtractResult {
  /** What was found in each value: numbers for number, amount and date (as a serial), text otherwise, null when nothing. */
  values: (string | number | null)[];
  /** Whether each value had a match. */
  matched: boolean[];
  /** How many values had a match. */
  count: number;
  /** "number", "date" or "text": what the new column holds. */
  type: "number" | "date" | "text";
}

/** Plain-language names for the presets. */
export const PATTERN_LABELS: Record<PatternKind, string> = {
  email: "Email address",
  phone: "Phone number",
  url: "Web address (URL)",
  number: "First number",
  amount: "Amount (money)",
  date: "Date",
  code: "Invoice-like code (letters and digits)",
  after: "Reference after a keyword",
  regex: "Custom pattern (regular expression)",
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d[\d\s.-]{4,}\d/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const NUMBER = /(?<![\w.])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w])/g;
const AMOUNT =
  /(\()?(-\s?)?((?:[$€£¥₹]|\b(?:USD|EUR|GBP|INR|JPY|CHF|CAD|AUD|NZD|ZAR|SGD|HKD)\b)\s?)?(-\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?![\d])(\))?(\s?(?:CR|DR)\b)?/gi;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE = new RegExp(
  [
    "\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b",
    "\\b\\d{1,2}[-/.]\\d{1,2}[-/.](?:\\d{4}|\\d{2})\\b",
    `\\b\\d{1,2}[\\s-]+${MONTH}[\\s\\-,]+(?:\\d{4}|\\d{2})\\b`,
    `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`,
  ].join("|"),
  "gi",
);
const CODE = /\b[A-Za-z]{1,6}(?:[-\/#.]|\s?#|\s?No\.?\s?)?\d{2,}(?:[-\/]?[A-Za-z0-9]+)*\b/g;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every match in one value, as text. */
function matchesIn(text: string, spec: PatternSpec, custom: RegExp | null): string[] {
  const out: string[] = [];
  const each = (re: RegExp, pick: (m: RegExpExecArray) => string | null) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0] === "") {
        re.lastIndex++;
        continue;
      }
      const v = pick(m);
      if (v) out.push(v);
    }
  };
  switch (spec.kind) {
    case "email":
      each(EMAIL, (m) => m[0].replace(/\.+$/, ""));
      break;
    case "phone":
      each(PHONE, (m) => {
        const digits = m[0].replace(/\D/g, "").length;
        // looks like a date or an amount? not a phone number
        if (/^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/.test(m[0].trim()) || /^\d+\.\d{1,2}$/.test(m[0].trim())) return null;
        return digits >= 7 && digits <= 15 ? m[0].trim() : null;
      });
      break;
    case "url":
      each(URL_RE, (m) => m[0].replace(/[.,;:!?)\]]+$/, ""));
      break;
    case "number":
      each(NUMBER, (m) => m[0]);
      break;
    case "amount":
      each(AMOUNT, (m) => {
        const [, open, minus1, currency, minus2, whole, decimals, close, crdr] = m;
        // a bare whole number (a year, a count) isn't an amount: it needs a currency, decimals or thousands commas
        if (!currency && !decimals && !whole.includes(",")) return null;
        const paren = !!open && !!close;
        const sign = minus1 || minus2 ? "-" : "";
        const body = `${sign}${currency ? currency.trim() : ""}${whole}${decimals ?? ""}${crdr ? " " + crdr.trim() : ""}`;
        return paren ? `(${body})` : body;
      });
      break;
    case "date":
      each(DATE, (m) => m[0]);
      break;
    case "code":
      each(CODE, (m) => (/[A-Za-z]/.test(m[0]) && /\d/.test(m[0]) ? m[0] : null));
      break;
    case "after": {
      const kw = spec.keyword.trim();
      if (!kw) break;
      // a whole word: "ref" mustn't match inside "Refund" or "Reference"
      const before = /^[A-Za-z0-9]/.test(kw) ? "(?<![A-Za-z0-9])" : "";
      const after = /[A-Za-z]$/.test(kw) ? "(?![A-Za-z])" : "";
      const re = new RegExp(`${before}${escapeRegex(kw)}${after}(?:[\\s:#.=\\-]|no\\.?)*([A-Za-z0-9][A-Za-z0-9\\-/._]*)`, "gi");
      each(re, (m) => m[1].replace(/[._\-/]+$/, ""));
      break;
    }
    case "regex":
      if (custom) each(custom, (m) => (m.length > 1 ? (m[1] ?? null) : m[0]));
      break;
  }
  return out;
}

/** Day-first unless some matched date can only be month-first; year-first when that's what they are. */
function guessOrder(texts: string[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  let ymd = 0;
  for (const t of texts) {
    const p = dateParts(t);
    if (!p) continue;
    if (p[0] > 31) ymd++;
    else if (p[0] > 12) dmy++;
    else if (p[1] > 12) mdy++;
  }
  return ymd > dmy && ymd > mdy ? "ymd" : mdy > dmy ? "mdy" : "dmy";
}

/** A custom pattern compiled, or an error in plain words. */
export function compilePattern(source: string, ignoreCase = true): RegExp {
  if (!source) throw new Error("Type a pattern to look for.");
  try {
    return new RegExp(source, ignoreCase ? "gi" : "g");
  } catch (e) {
    throw new Error(`That pattern isn't valid: ${(e as Error).message.replace(/^Invalid regular expression: /, "")}`);
  }
}

/** Find the pattern in every value. */
export function extractPattern(values: readonly (Value | boolean | undefined)[], spec: PatternSpec, opts: ExtractOptions = {}): ExtractResult {
  const custom = spec.kind === "regex" ? compilePattern(spec.regex, spec.ignoreCase ?? true) : null;
  const found = values.map((v) => (v === null || v === undefined ? [] : matchesIn(typeof v === "number" ? String(v) : String(v), spec, custom)));
  const matched = found.map((f) => f.length > 0);
  const count = matched.filter(Boolean).length;
  const numeric = !opts.all && (spec.kind === "number" || spec.kind === "amount" || spec.kind === "date");
  if (!numeric) {
    return { values: found.map((f) => (f.length ? (opts.all ? f.join("; ") : f[0]) : null)), matched, count, type: "text" };
  }
  if (spec.kind === "date") {
    const order = opts.dateOrder ?? guessOrder(found.flat());
    const out = found.map((f) => {
      for (const t of f) {
        const d = parseDateLoose(t.replace(/(\d)(st|nd|rd|th)\b/i, "$1").replace(/\.(?=\s)/, ""), order);
        if (d !== null) return d;
      }
      return null;
    });
    return { values: out, matched: out.map((v) => v !== null), count: out.filter((v) => v !== null).length, type: "date" };
  }
  const out = found.map((f) => {
    for (const t of f) {
      const n = parseNumberLoose(t);
      if (n !== null) return n;
    }
    return null;
  });
  return { values: out, matched: out.map((v) => v !== null), count: out.filter((v) => v !== null).length, type: "number" };
}
