/**
 * Finished, immutable column data. These are plain objects + typed arrays so
 * they can be posted between a worker and the main thread with the buffers
 * transferred (zero copy).
 *
 * - number columns: one Float64Array, NaN marks an empty cell
 * - string columns: dictionary encoded. codes[i] = 0 means empty, otherwise
 *   dict[codes[i] - 1] is the value. Repeated values ("North", "South", ...)
 *   are stored once, which is the common case in real CSVs.
 */
export type ColumnData =
  | { kind: "number"; name: string; values: Float64Array }
  | { kind: "string"; name: string; codes: Uint32Array; dict: string[] };

const NUMERIC = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

/** Parse a CSV field as a number, or return null if it isn't one. */
export function parseNumber(raw: string): number | null {
  return NUMERIC.test(raw) ? Number(raw) : null;
}

/** The buffers to list in postMessage's transfer list. */
export function transferablesOf(columns: ColumnData[]): ArrayBuffer[] {
  return columns.map((c) => (c.kind === "number" ? c.values.buffer : c.codes.buffer) as ArrayBuffer);
}

/**
 * Accumulates one column's values while a file is being parsed.
 *
 * Every column starts out assuming it's numeric. The first value that doesn't
 * parse as a number flips it to a string column, re-encoding what it had so
 * far. Known limitation: numbers seen before the flip are re-stringified, so
 * "007" read early would come back as "7". Good enough for now; a smarter
 * version would sniff the first N rows before committing to a type.
 */
export class ColumnBuilder {
  private kind: "number" | "string" = "number";
  private nums = new Float64Array(1024);
  private codes: Uint32Array | null = null;
  private dict: string[] = [];
  private lookup = new Map<string, number>();
  length = 0;

  constructor(readonly name: string) {}

  push(raw: string): void {
    if (this.kind === "number") {
      if (raw === "") {
        this.pushNumber(NaN);
        return;
      }
      const n = parseNumber(raw);
      if (n !== null) {
        this.pushNumber(n);
        return;
      }
      this.switchToStrings();
    }
    this.pushCode(raw === "" ? 0 : this.intern(raw));
  }

  /** Fill with empty cells until the column has `n` rows. */
  padTo(n: number): void {
    while (this.length < n) this.push("");
  }

  finish(): ColumnData {
    if (this.kind === "number") {
      // slice() so the transferred buffer is exactly the right size instead of
      // up to 2x bigger from the growth strategy
      return { kind: "number", name: this.name, values: this.nums.slice(0, this.length) };
    }
    return {
      kind: "string",
      name: this.name,
      codes: this.codes!.slice(0, this.length),
      dict: this.dict,
    };
  }

  private pushNumber(n: number): void {
    if (this.length === this.nums.length) {
      const bigger = new Float64Array(this.nums.length * 2);
      bigger.set(this.nums);
      this.nums = bigger;
    }
    this.nums[this.length++] = n;
  }

  private pushCode(code: number): void {
    if (this.length === this.codes!.length) {
      const bigger = new Uint32Array(this.codes!.length * 2);
      bigger.set(this.codes!);
      this.codes = bigger;
    }
    this.codes![this.length++] = code;
  }

  private intern(s: string): number {
    let code = this.lookup.get(s);
    if (code === undefined) {
      this.dict.push(s);
      code = this.dict.length; // 1-based, 0 is reserved for "empty"
      this.lookup.set(s, code);
    }
    return code;
  }

  private switchToStrings(): void {
    this.kind = "string";
    this.codes = new Uint32Array(Math.max(1024, this.nums.length));
    for (let i = 0; i < this.length; i++) {
      const v = this.nums[i];
      this.codes[i] = Number.isNaN(v) ? 0 : this.intern(String(v));
    }
    // free the number buffer, it can be huge
    this.nums = new Float64Array(0);
  }
}
