import {
  CellError,
  errors,
  evaluate,
  parseFormula,
  type EvalContext,
  type Node,
  type RangeRef,
  type Scalar,
} from "@cellforge/core";
import { formatCell, type CellValue, type DataSource } from "@cellforge/grid";

/** An empty sheet - what you get from "New". */
export class BlankSource implements DataSource {
  constructor(
    readonly rowCount = 1000,
    readonly colCount = 26,
  ) {}

  getCell(): CellValue {
    return null;
  }
}

export interface Formula {
  kind: "formula";
  text: string; // what the user typed, including the "="
  ast: Node | null; // null when it didn't parse
}

/** What can live in a cell: a plain value or a formula. */
export type Stored = CellValue | Formula;

export function isFormula(v: Stored | undefined): v is Formula {
  return typeof v === "object" && v !== null && v.kind === "formula";
}

/** Sources that can hand over a raw numeric column (the columnar Table does). */
interface NumericColumns {
  numberColumn(col: number): Float64Array | null;
}

const hasNumericColumns = (s: DataSource): s is DataSource & NumericColumns =>
  typeof (s as Partial<NumericColumns>).numberColumn === "function";

// cell -> single number key for the cache. 16384 is Excel's column limit and
// 1e8 * 16384 is still well inside Number.MAX_SAFE_INTEGER.
const key = (row: number, col: number) => row * 16384 + col;

/**
 * Wraps a read-only source and layers user edits (values and formulas) on top.
 *
 * Edits are kept in a sparse map, so editing a handful of cells in a 100M row
 * sheet costs a handful of map entries, not a copy of the data.
 *
 * Formula results are cached and the whole cache is dropped on any edit.
 * That's crude - a dependency graph would only recompute what changed - but
 * it's always correct, and recomputing the handful of visible formulas is
 * cheap. Smarter invalidation comes with the fill-down compiler.
 */
export class EditableSource implements DataSource {
  // row -> (col -> value). Nested so looking up a row is cheap.
  private edits = new Map<number, Map<number, Stored>>();
  private editsPerColumn = new Map<number, number>();
  private count = 0;

  private cache = new Map<number, Scalar>();
  private inProgress = new Set<number>(); // for cycle detection

  constructor(private readonly base: DataSource) {}

  get rowCount(): number {
    return this.base.rowCount;
  }

  get colCount(): number {
    return this.base.colCount;
  }

  get editCount(): number {
    return this.count;
  }

  getColumnName(col: number): string | undefined {
    return this.base.getColumnName?.(col);
  }

  /** Display value, i.e. formulas evaluated and errors turned into "#DIV/0!" etc. */
  getCell(row: number, col: number): CellValue {
    return toDisplay(this.value(row, col));
  }

  /** What goes in the formula bar / cell editor: the formula itself, not its result. */
  getEditText(row: number, col: number): string {
    const stored = this.edits.get(row)?.get(col);
    if (isFormula(stored)) return stored.text;
    return formatCell(this.getCell(row, col));
  }

  /** The stored edit for a cell, or undefined if it's untouched. Used by undo. */
  getStored(row: number, col: number): Stored | undefined {
    return this.edits.get(row)?.get(col);
  }

  setCell(row: number, col: number, value: Stored): void {
    let rowEdits = this.edits.get(row);
    if (!rowEdits) {
      rowEdits = new Map();
      this.edits.set(row, rowEdits);
    }
    if (!rowEdits.has(col)) {
      this.count++;
      this.editsPerColumn.set(col, (this.editsPerColumn.get(col) ?? 0) + 1);
    }
    rowEdits.set(col, value);
    this.cache.clear();
  }

  /** Forget an edit entirely, so the cell shows the underlying data again. */
  revertCell(row: number, col: number): void {
    const rowEdits = this.edits.get(row);
    if (!rowEdits?.has(col)) return;
    rowEdits.delete(col);
    if (rowEdits.size === 0) this.edits.delete(row);
    this.count--;
    const n = this.editsPerColumn.get(col)! - 1;
    if (n === 0) this.editsPerColumn.delete(col);
    else this.editsPerColumn.set(col, n);
    this.cache.clear();
  }

  /**
   * Smallest (rows, cols) that contains every non-empty cell. For a blank
   * sheet that's just the edited area - nobody wants to export 1000 empty
   * rows. For real data it's the data size, grown to fit any edits beyond it.
   */
  usedRange(): { rows: number; cols: number } {
    let rows = this.base instanceof BlankSource ? 0 : this.base.rowCount;
    let cols = this.base instanceof BlankSource ? 0 : this.base.colCount;
    for (const [r, rowEdits] of this.edits) {
      for (const [c, v] of rowEdits) {
        if (v === null) continue;
        rows = Math.max(rows, r + 1);
        cols = Math.max(cols, c + 1);
      }
    }
    return { rows, cols };
  }

  // ---------------------------------------------------------------------------
  // evaluation

  private value(row: number, col: number): Scalar {
    const stored = this.edits.get(row)?.get(col);
    if (stored === undefined) return this.base.getCell(row, col);
    if (!isFormula(stored)) return stored;

    const k = key(row, col);
    const cached = this.cache.get(k);
    if (cached !== undefined) return cached;
    if (this.inProgress.has(k)) return errors.cycle;

    this.inProgress.add(k);
    let result: Scalar;
    try {
      result = stored.ast ? evaluate(stored.ast, this.ctx) : errors.syntax;
    } finally {
      this.inProgress.delete(k);
    }
    this.cache.set(k, result);
    return result;
  }

  private readonly ctx: EvalContext = {
    cell: (row, col) =>
      row < this.rowCount && col < this.colCount ? this.value(row, col) : errors.ref,
    eachInRange: (range, visit) => this.eachInRange(range, visit),
  };

  private eachInRange(range: RangeRef, visit: (v: Scalar) => void): void {
    const bottom = Math.min(range.bottom, this.rowCount - 1);
    const right = Math.min(range.right, this.colCount - 1);

    // Fast path: untouched numeric columns of an imported table can be read
    // straight out of the Float64Array without going through getCell for
    // every row. Visits column by column, which is fine for aggregates.
    const fast = hasNumericColumns(this.base) ? this.base : null;
    const allFast =
      fast !== null &&
      Array.from({ length: right - range.left + 1 }, (_, i) => range.left + i).every(
        (c) => !this.editsPerColumn.has(c) && fast.numberColumn(c) !== null,
      );

    if (allFast) {
      for (let c = range.left; c <= right; c++) {
        const values = fast.numberColumn(c)!;
        for (let r = range.top; r <= bottom; r++) {
          const v = values[r];
          visit(Number.isNaN(v) ? null : v);
        }
      }
      return;
    }

    for (let r = range.top; r <= bottom; r++) {
      for (let c = range.left; c <= right; c++) visit(this.value(r, c));
    }
  }
}

function toDisplay(v: Scalar): CellValue {
  if (v instanceof CellError) return v.code;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return v;
}

/**
 * Turn what the user typed into something to store. "=..." becomes a formula,
 * numbers become numbers (so they right-align and work in maths), everything
 * else stays a string.
 */
export function parseInput(text: string): Stored {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("=") && trimmed.length > 1) {
    let ast: Node | null = null;
    try {
      ast = parseFormula(trimmed);
    } catch {
      // keep the text so the user can fix it; it'll display as #ERROR!
    }
    return { kind: "formula", text: trimmed, ast };
  }
  // Number("") and Number(" ") are 0, and Number("0x1f") is 31 - neither of
  // which we want, hence the regex instead of just Number(trimmed).
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) {
    return Number(trimmed);
  }
  return text;
}
