/**
 * Text to columns: split one column of text into several, by delimiters or
 * at fixed character positions, then decide what each new column holds
 * (numbers, dates or text) the same way imports do.
 */
import { parseAs, profileColumn, type ColumnProfile } from "../clean/values";

export type SplitOptions =
  | {
      mode: "delimited";
      /** One or more delimiters, such as [","], ["\t", ";"] or [" - "]. */
      delimiters: string[];
      /** Two or more delimiters in a row count as one. */
      consecutiveAsOne?: boolean;
      /** Text inside this character is never split ('"' by default, "" for none). "" inside it is one quote. */
      qualifier?: string;
    }
  | {
      mode: "fixed";
      /** Character positions to cut at, such as [4, 10]. */
      breaks: number[];
    };

export interface SplitResult {
  /** The pieces as text: columns[c][row]. Missing pieces are "". */
  columns: string[][];
  /** What each column holds. */
  profiles: ColumnProfile[];
  /** The pieces as values: numbers (dates as serials), text, or null when blank. */
  values: (number | string | null)[][];
}

/** One value split by delimiters. */
export function splitDelimited(text: string, delimiters: readonly string[], consecutiveAsOne = false, qualifier = '"'): string[] {
  const delims = delimiters.filter((d) => d.length > 0).sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let field = "";
  let i = 0;
  let fieldStart = true;
  let lastWasDelim = false;
  const delimAt = (pos: number) => delims.find((d) => text.startsWith(d, pos));
  while (i < text.length) {
    if (qualifier && fieldStart && text.startsWith(qualifier, i)) {
      // a quoted field: read to the closing qualifier, "" is a literal quote
      const open = i;
      i += qualifier.length;
      let closed = false;
      while (i < text.length) {
        if (text.startsWith(qualifier, i)) {
          if (text.startsWith(qualifier, i + qualifier.length)) {
            field += qualifier;
            i += qualifier.length * 2;
            continue;
          }
          i += qualifier.length;
          closed = true;
          break;
        }
        field += text[i++];
      }
      if (!closed) {
        // no closing quote: the quote is just a character, split the rest normally
        field = qualifier;
        i = open + qualifier.length;
      }
      fieldStart = false;
      lastWasDelim = false;
      continue;
    }
    const d = delimAt(i);
    if (d) {
      if (!(consecutiveAsOne && lastWasDelim)) out.push(field);
      field = "";
      i += d.length;
      fieldStart = true;
      lastWasDelim = true;
      continue;
    }
    field += text[i++];
    fieldStart = false;
    lastWasDelim = false;
  }
  if (!(consecutiveAsOne && lastWasDelim && field === "") || out.length === 0) out.push(field);
  return out;
}

/** One value cut at fixed positions, each piece trimmed. */
export function splitFixed(text: string, breaks: readonly number[]): string[] {
  const cuts = [...new Set(breaks.filter((b) => Number.isInteger(b) && b > 0))].sort((a, b) => a - b);
  const out: string[] = [];
  let from = 0;
  for (const b of cuts) {
    out.push(text.slice(from, b).trim());
    from = b;
  }
  out.push(text.slice(from).trim());
  return out;
}

/**
 * Split every value and type the resulting columns. A column whose numbers
 * have leading zeros (account codes like 0042) stays text so the zeros
 * aren't lost.
 */
export function textToColumns(values: readonly string[], opts: SplitOptions): SplitResult {
  const pieces = values.map((v) =>
    opts.mode === "fixed" ? splitFixed(v, opts.breaks) : splitDelimited(v, opts.delimiters, opts.consecutiveAsOne ?? false, opts.qualifier ?? '"'),
  );
  // a blank value gives one empty piece, which shouldn't make a column
  const width = pieces.reduce((w, p) => Math.max(w, p.length), 0);
  const columns: string[][] = Array.from({ length: width }, (_, c) => pieces.map((p) => (p[c] ?? "").trim()));
  const profiles: ColumnProfile[] = [];
  const typed: (number | string | null)[][] = [];
  for (const col of columns) {
    let p = profileColumn(col);
    if (p.type === "number" && col.some((v) => /^0\d/.test(v))) p = { ...p, type: "text", confidence: 1, misfits: [] };
    profiles.push(p);
    typed.push(col.map((v) => (v === "" ? null : (parseAs(v, p) ?? v))));
  }
  return { columns, profiles, values: typed };
}
