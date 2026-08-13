/**
 * Working out how a text file is written before importing it: its encoding
 * (from a byte-order mark, or whether it's valid UTF-8, falling back to the
 * Windows-1252 that old exports use) and its delimiter.
 */
import { CsvParser, detectDelimiter } from "./csv";
import { getLocale } from "./locale";

export type Encoding = "utf-8" | "windows-1252" | "utf-16le" | "utf-16be";

export function detectEncoding(bytes: Uint8Array): Encoding {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  // UTF-16 without a BOM: every other byte zero in plain ASCII text
  let zeroOdd = 0;
  const n = Math.min(bytes.length, 4096);
  for (let i = 1; i < n; i += 2) if (bytes[i] === 0) zeroOdd++;
  if (n > 16 && zeroOdd > n / 4) return "utf-16le";
  try {
    // a chunk boundary can split a character; trim the last 3 bytes
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.max(0, Math.min(bytes.length, 256 * 1024) - (bytes.length > 256 * 1024 ? 3 : 0))));
    return "utf-8";
  } catch {
    return "windows-1252";
  }
}

export interface CsvOptions {
  encoding?: Encoding;
  delimiter?: string;
  /** first row (after skipped ones) holds the column names; default true */
  header?: boolean;
  /** rows to drop at the top (report titles and the like) */
  skipRows?: number;
}

/** The text after the first n lines (so title rows don't confuse delimiter detection). */
export function afterLines(text: string, n: number): string {
  let at = 0;
  for (let i = 0; i < n; i++) {
    const nl = text.indexOf("\n", at);
    if (nl < 0) return "";
    at = nl + 1;
  }
  return text.slice(at);
}

export interface CsvPreview {
  encoding: Encoding;
  delimiter: string;
  rows: string[][];
}

/** Decode the start of a file and show its first rows, with what was detected. */
export function previewCsv(bytes: Uint8Array, opts: CsvOptions = {}, maxRows = 12): CsvPreview {
  const encoding = opts.encoding ?? detectEncoding(bytes);
  let text = new TextDecoder(encoding).decode(bytes.subarray(0, 256 * 1024));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = opts.delimiter ?? detectDelimiter(afterLines(text, opts.skipRows ?? 0).slice(0, 64 * 1024), defaultCsvDelimiter());
  const rows: string[][] = [];
  const parser = new CsvParser((r) => {
    if (rows.length < maxRows + (opts.skipRows ?? 0)) rows.push(r);
  }, delimiter);
  parser.push(text);
  parser.end();
  return { encoding, delimiter, rows: rows.slice(opts.skipRows ?? 0) };
}

/** The delimiter a new CSV is written with, and the tie-break when detecting: the locale's (";" where the comma is the decimal). */
export function defaultCsvDelimiter(): string {
  return getLocale().csvDelimiter;
}
