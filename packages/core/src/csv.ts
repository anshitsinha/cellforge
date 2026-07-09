const QUOTE = 34; // "
const LF = 10;
const CR = 13;

/**
 * Streaming RFC 4180-ish CSV parser.
 *
 * Feed it text in arbitrary chunks with push(); it calls onRow for every
 * complete record. Fields, quotes and line breaks are allowed to straddle
 * chunk boundaries, which is the whole point - files are read in 1MB-ish
 * pieces and a chunk can end anywhere.
 *
 * Rather than appending one character at a time (slow), it remembers where the
 * current field started inside the chunk and slices once at the delimiter.
 */
export class CsvParser {
  private readonly delim: number;
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  private afterQuote = false; // saw a " inside a quoted field; next char decides
  private skipLF = false; // just ended a row on \r, swallow a following \n

  constructor(
    private readonly onRow: (fields: string[]) => void,
    delimiter = ",",
  ) {
    this.delim = delimiter.charCodeAt(0);
  }

  push(chunk: string): void {
    const n = chunk.length;
    let start = 0;

    for (let i = 0; i < n; i++) {
      const c = chunk.charCodeAt(i);

      if (this.afterQuote) {
        this.afterQuote = false;
        if (c === QUOTE) {
          // "" inside quotes is an escaped quote
          this.field += '"';
          start = i + 1;
          continue;
        }
        // otherwise the quoted section just ended; handle c normally below
        this.inQuotes = false;
        start = i;
      }

      if (this.inQuotes) {
        if (c === QUOTE) {
          this.field += chunk.slice(start, i);
          this.afterQuote = true;
          start = i + 1;
        }
        continue;
      }

      if (this.skipLF) {
        this.skipLF = false;
        if (c === LF) {
          start = i + 1;
          continue;
        }
      }

      if (c === QUOTE && start === i && this.field === "") {
        this.inQuotes = true;
        start = i + 1;
      } else if (c === this.delim) {
        this.row.push(this.field + chunk.slice(start, i));
        this.field = "";
        start = i + 1;
      } else if (c === LF || c === CR) {
        this.field += chunk.slice(start, i);
        this.endRow();
        start = i + 1;
        this.skipLF = c === CR;
      }
    }

    this.field += chunk.slice(start);
  }

  /** Flush the last record if the file didn't end with a newline. */
  end(): void {
    if (this.field !== "" || this.row.length > 0) this.endRow();
  }

  private endRow(): void {
    this.row.push(this.field);
    this.field = "";
    const row = this.row;
    this.row = [];
    // skip blank lines rather than producing a row with one empty field
    if (row.length === 1 && row[0] === "") return;
    this.onRow(row);
  }
}

/**
 * Guess the delimiter from a sample of the file by counting candidates on the
 * first line. Handles the usual suspects - Excel in many European locales
 * writes semicolons, and TSV exports use tabs.
 */
export function detectDelimiter(sample: string): string {
  const candidates = [",", ";", "\t", "|"];
  const counts = new Map(candidates.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ",";
  for (const d of candidates) {
    if (counts.get(d)! > counts.get(best)!) best = d;
  }
  return best;
}
