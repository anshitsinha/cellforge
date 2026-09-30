import {
  CellError,
  compileFill,
  errors,
  evaluate,
  formatFormula,
  parseFormula,
  Table,
  type ColumnData,
  type CompiledFill,
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
  /** Evaluate as if filled this many rows down from where it was written. */
  shift?: number;
}

/** What can live in a cell: a plain value or a formula. */
export type Stored = CellValue | Formula;

export function isFormula(v: Stored | undefined): v is Formula {
  return typeof v === "object" && v !== null && v.kind === "formula";
}

/**
 * A fill-down: one template covering a block of rows in one column, stored
 * once no matter how many rows it spans. Row v of the fill evaluates the
 * template with rowShift = v - origin.
 *
 * Rows are *base* rows (like edits), and fills are only created while the
 * sheet is unsorted, so at creation time base == view.
 */
export interface Fill {
  col: number;
  top: number;
  bottom: number;
  origin: number;
  template: Stored;
  /** compiled kernel, or null if the template can't be compiled */
  kernel: CompiledFill | null;
  /**
   * Kernel output, computed lazily in chunks of CHUNK_ROWS rows (NaN = ask the
   * interpreter). Map order doubles as LRU order.
   */
  chunks: Map<number, Float64Array>;
  computing: boolean;
}

// 64K rows = 512KB per chunk. Small enough that scrolling to a new spot costs
// well under a frame, big enough that the per-chunk overhead (materialising
// input windows, calling the kernel) is negligible.
const CHUNK_ROWS = 65_536;
// ~128MB of results across all fills before old chunks get evicted.
const MAX_CHUNKS = 256;

export interface KernelRun {
  col: number;
  rows: number;
  ms: number;
  totalRows: number; // whole fill, for "chunk 3 of 1526" style reporting
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

/** Kernel input encoding: numbers as-is, blank -> 0, anything else -> NaN. */
function asInput(v: Scalar): number {
  if (typeof v === "number") return v;
  return v === null ? 0 : NaN;
}

/**
 * Wraps a read-only source and layers user edits (values and formulas),
 * fill-downs, and an optional row order (from sorting) on top.
 *
 * Lookup order for a cell: explicit edit > newest fill covering it > base data.
 *
 * Coordinates: every public method takes *view* rows - row N is whatever is
 * currently displayed on row N. Internally edits and fills are keyed by
 * *base* rows (the row in the original data), so when the sheet is re-sorted
 * an edit moves along with the rest of its row. Formula references are in
 * view coordinates, same as what the user sees.
 *
 * Formula results are cached and everything is dropped on any change. That's
 * crude - a dependency graph would only recompute what changed - but always
 * correct. Fills are the exception to "per cell": the first time any cell of
 * a compiled fill is needed, the kernel computes the whole fill in one pass.
 */
export class EditableSource implements DataSource {
  // base row -> (col -> value). Nested so looking up a row is cheap.
  private edits = new Map<number, Map<number, Stored>>();
  private editsPerColumn = new Map<number, number>();
  private count = 0;
  private formulas = 0;
  private fills: Fill[] = [];

  // view row -> base row. null means "unsorted" (identity).
  private order: Uint32Array | null = null;

  private cache = new Map<number, Scalar>();
  private inProgress = new Set<number>(); // for cycle detection

  private chunkCount = 0;

  /** Called after a fill kernel runs, so the UI can report it. */
  onKernelRun: ((run: KernelRun) => void) | null = null;

  /**
   * @param extraColumns empty columns after the data, so imported sheets have
   *        room for calculated columns
   */
  constructor(
    private readonly base: DataSource,
    private readonly extraColumns = 0,
  ) {}

  get rowCount(): number {
    return this.base.rowCount;
  }

  get colCount(): number {
    return this.base.colCount + this.extraColumns;
  }

  get editCount(): number {
    return this.count + this.fills.length;
  }

  get hasFormulas(): boolean {
    return this.formulas > 0 || this.fills.some((f) => isFormula(f.template));
  }

  getColumnName(col: number): string | undefined {
    // spare columns past the data fall back to letters in the grid
    return col < this.base.colCount ? this.base.getColumnName?.(col) : undefined;
  }

  /** Display value, i.e. formulas evaluated and errors turned into "#DIV/0!" etc. */
  getCell(row: number, col: number): CellValue {
    return toDisplay(this.value(row, col));
  }

  /** What goes in the formula bar / cell editor: the formula itself, not its result. */
  getEditText(row: number, col: number): string {
    const b = this.toBase(row);
    const stored = this.edits.get(b)?.get(col);
    if (isFormula(stored)) return formulaText(stored, stored.shift ?? 0);
    if (stored === undefined) {
      const fill = this.fillAt(b, col);
      if (fill && isFormula(fill.template)) return formulaText(fill.template, row - fill.origin);
    }
    return formatCell(this.getCell(row, col));
  }

  /** The stored edit for a cell, or undefined if it's untouched. Used by undo. */
  getStored(row: number, col: number): Stored | undefined {
    return this.edits.get(this.toBase(row))?.get(col);
  }

  /**
   * What "fill down from this cell" should copy, and the row its formula's
   * references are relative to.
   */
  getTemplate(row: number, col: number): { template: Stored; origin: number } {
    const b = this.toBase(row);
    const stored = this.edits.get(b)?.get(col);
    if (isFormula(stored)) return { template: { ...stored, shift: 0 }, origin: row - (stored.shift ?? 0) };
    if (stored !== undefined) return { template: stored, origin: row };
    const fill = this.fillAt(b, col);
    if (fill) return { template: fill.template, origin: fill.origin };
    return { template: col < this.base.colCount ? this.base.getCell(b, col) : null, origin: row };
  }

  setCell(row: number, col: number, value: Stored): void {
    const b = this.toBase(row);
    let rowEdits = this.edits.get(b);
    if (!rowEdits) {
      rowEdits = new Map();
      this.edits.set(b, rowEdits);
    }
    const prev = rowEdits.get(col);
    if (prev === undefined && !rowEdits.has(col)) {
      this.count++;
      this.editsPerColumn.set(col, (this.editsPerColumn.get(col) ?? 0) + 1);
    }
    if (isFormula(prev)) this.formulas--;
    if (isFormula(value)) this.formulas++;
    rowEdits.set(col, value);
    this.invalidate();
  }

  /** Forget an edit entirely, so the cell shows the underlying data again. */
  revertCell(row: number, col: number): void {
    const b = this.toBase(row);
    const rowEdits = this.edits.get(b);
    if (!rowEdits?.has(col)) return;
    if (isFormula(rowEdits.get(col))) this.formulas--;
    rowEdits.delete(col);
    if (rowEdits.size === 0) this.edits.delete(b);
    this.count--;
    const n = this.editsPerColumn.get(col)! - 1;
    if (n === 0) this.editsPerColumn.delete(col);
    else this.editsPerColumn.set(col, n);
    this.invalidate();
  }

  // ---------------------------------------------------------------------------
  // fills

  /**
   * Fill rows top..bottom (view rows) of `col` from a template. Only valid
   * while unsorted. Returns the fill so it can be removed again (undo).
   */
  addFill(col: number, top: number, bottom: number, template: Stored, origin: number): Fill {
    if (this.order) throw new Error("fills can only be added to an unsorted sheet");
    let kernel: CompiledFill | null = null;
    if (isFormula(template) && template.ast) {
      kernel = compileFill(template.ast, origin);
      // a fill that reads its own column (running totals etc.) depends on its
      // own output; leave that to the interpreter
      if (kernel?.columns.some((c) => c.col === col)) kernel = null;
    }
    const fill: Fill = { col, top, bottom, origin, template, kernel, chunks: new Map(), computing: false };
    this.fills.push(fill);
    this.invalidate();
    return fill;
  }

  removeFill(fill: Fill): void {
    this.fills = this.fills.filter((f) => f !== fill);
    this.invalidate();
  }

  /** Re-add a fill removed by undo (keeps its compiled kernel). */
  restoreFill(fill: Fill): void {
    this.fills.push(fill);
    this.invalidate();
  }

  /** Drop explicit edits in a block of one column, returning them for undo. */
  takeEdits(col: number, top: number, bottom: number): { row: number; col: number; value: Stored }[] {
    const taken: { row: number; col: number; value: Stored }[] = [];
    for (const [b, rowEdits] of this.edits) {
      if (b < top || b > bottom || !rowEdits.has(col)) continue;
      taken.push({ row: b, col, value: rowEdits.get(col)! });
    }
    // rows are base rows; fills (and so this) only happen unsorted, where
    // base == view, so revertCell's view->base mapping is the identity
    for (const t of taken) this.revertCell(t.row, col);
    return taken;
  }

  isCompiled(fill: Fill): boolean {
    return fill.kernel !== null;
  }

  private fillAt(baseRow: number, col: number): Fill | null {
    // newest first, so a later fill over the same rows wins
    for (let i = this.fills.length - 1; i >= 0; i--) {
      const f = this.fills[i];
      if (f.col === col && baseRow >= f.top && baseRow <= f.bottom) return f;
    }
    return null;
  }

  private columnTouched(col: number): boolean {
    return this.editsPerColumn.has(col) || this.fills.some((f) => f.col === col);
  }

  /**
   * Kernel output for one row of a fill, computing (and caching) the chunk it
   * lives in if needed. NaN means "use the interpreter" - including when the
   * kernel can't be used at all right now.
   */
  private kernelValue(fill: Fill, baseRow: number): number {
    // kernels index rows directly, which only matches the view when unsorted
    if (!fill.kernel || this.order) return NaN;
    const index = Math.floor((baseRow - fill.top) / CHUNK_ROWS);
    let chunk = fill.chunks.get(index);
    if (chunk) {
      // refresh LRU position
      fill.chunks.delete(index);
      fill.chunks.set(index, chunk);
    } else {
      // re-entrant call (a fill whose inputs lead back to itself): let the
      // interpreter handle it, its cycle detection will sort it out
      if (fill.computing) return NaN;
      chunk = this.computeChunk(fill, index);
      fill.chunks.set(index, chunk);
      if (++this.chunkCount > MAX_CHUNKS) this.evictChunk();
    }
    return chunk[baseRow - fill.top - index * CHUNK_ROWS];
  }

  private computeChunk(fill: Fill, index: number): Float64Array {
    const k = fill.kernel!;
    const n = this.rowCount;
    const start = fill.top + index * CHUNK_ROWS;
    const end = Math.min(fill.bottom + 1, start + CHUNK_ROWS);
    fill.computing = true;
    try {
      const started = performance.now();
      // input window: the chunk's rows widened by the template's ref offsets
      const lo = Math.max(0, start + k.minOffset);
      const hi = Math.min(n - 1, end - 1 + k.maxOffset);
      const cols = k.columns.map(({ col }) => this.inputColumn(col, lo, Math.max(lo, hi)));
      const scalars = Float64Array.from(k.scalars, ({ col, row }) =>
        row < n && col < this.colCount ? asInput(this.value(row, col)) : NaN,
      );
      const out = new Float64Array(end - start);
      k.run(cols, scalars, out, start, end, n, lo);
      this.onKernelRun?.({
        col: fill.col,
        rows: out.length,
        ms: performance.now() - started,
        totalRows: fill.bottom - fill.top + 1,
      });
      return out;
    } finally {
      fill.computing = false;
    }
  }

  /** Drop the least recently used chunk across all fills. */
  private evictChunk(): void {
    // Each fill's Map is in LRU order, but there's no global order across
    // fills - evicting the oldest chunk of the fill holding the most is a
    // fine approximation.
    let victim: Fill | null = null;
    for (const f of this.fills) if (!victim || f.chunks.size > victim.chunks.size) victim = f;
    const oldest = victim?.chunks.keys().next();
    if (victim && oldest && !oldest.done) {
      victim.chunks.delete(oldest.value);
      this.chunkCount--;
    }
  }

  /** Rows lo..hi of a column as kernel input (see asInput). */
  private inputColumn(col: number, lo: number, hi: number): Float64Array {
    if (col >= this.colCount) return new Float64Array(hi - lo + 1).fill(NaN);
    // zero-copy when the column is untouched imported data. Blanks there are
    // NaN rather than 0, which just sends those rows to the interpreter.
    if (!this.order && !this.columnTouched(col) && hasNumericColumns(this.base)) {
      const values = this.base.numberColumn(col);
      if (values) return values.subarray(lo, hi + 1);
    }
    const out = new Float64Array(hi - lo + 1);
    for (let r = lo; r <= hi; r++) out[r - lo] = asInput(this.value(r, col));
    return out;
  }

  // ---------------------------------------------------------------------------
  // row order (sorting)

  /**
   * The imported column behind `col`, if it's safe to read directly: the base
   * is a columnar Table and nothing has been edited or filled in that column.
   * Callers still need to apply rowOrder themselves. Used by the fast paths in
   * sort and stats.
   */
  baseColumn(col: number): ColumnData | null {
    if (!(this.base instanceof Table) || this.columnTouched(col)) return null;
    return this.base.columns[col] ?? null;
  }

  get rowOrder(): Uint32Array | null {
    return this.order;
  }

  /** Replace the view -> base row mapping. null restores the original order. */
  setRowOrder(order: Uint32Array | null): void {
    if (order && order.length !== this.rowCount) throw new Error("row order has the wrong length");
    this.order = order;
    this.invalidate();
  }

  toBase(row: number): number {
    return this.order ? this.order[row] : row;
  }

  /**
   * Smallest (rows, cols) that contains every non-empty cell. For a blank
   * sheet that's just the edited area - nobody wants to export 1000 empty
   * rows. For real data it's the data size, grown to fit any edits beyond it.
   */
  usedRange(): { rows: number; cols: number } {
    const blank = this.base instanceof BlankSource;
    let rows = blank ? 0 : this.base.rowCount;
    let cols = blank ? 0 : this.base.colCount; // spare columns only count once used

    // edits are keyed by base row, so map back to view rows if sorted
    let toView: (b: number) => number = (b) => b;
    if (blank && this.order) {
      const inverse = new Uint32Array(this.order.length);
      this.order.forEach((b, v) => (inverse[b] = v));
      toView = (b) => inverse[b];
    }

    for (const [b, rowEdits] of this.edits) {
      for (const [c, v] of rowEdits) {
        if (v === null) continue;
        rows = Math.max(rows, toView(b) + 1);
        cols = Math.max(cols, c + 1);
      }
    }
    for (const f of this.fills) {
      if (f.template === null) continue;
      // a fill is contiguous in base rows, not necessarily in view rows
      rows = this.order ? Math.max(rows, this.rowCount) : Math.max(rows, f.bottom + 1);
      cols = Math.max(cols, f.col + 1);
    }
    return { rows: Math.min(rows, this.rowCount), cols };
  }

  // ---------------------------------------------------------------------------
  // evaluation

  private invalidate(): void {
    this.cache.clear();
    for (const f of this.fills) f.chunks.clear();
    this.chunkCount = 0;
  }

  private value(row: number, col: number): Scalar {
    const b = this.toBase(row);
    const stored = this.edits.get(b)?.get(col);
    if (stored !== undefined) {
      return isFormula(stored) ? this.evalFormula(row, col, stored, stored.shift ?? 0) : stored;
    }
    const fill = this.fillAt(b, col);
    if (!fill) return col < this.base.colCount ? this.base.getCell(b, col) : null;
    if (!isFormula(fill.template)) return fill.template;

    // compiled fast path: finite kernel output is exactly the interpreter's
    // answer (see compile.ts), anything else falls through to the interpreter
    const x = this.kernelValue(fill, b);
    if (x - x === 0) return x;
    return this.evalFormula(row, col, fill.template, row - fill.origin);
  }

  private evalFormula(row: number, col: number, f: Formula, shift: number): Scalar {
    const k = key(row, col);
    const cached = this.cache.get(k);
    if (cached !== undefined) return cached;
    if (this.inProgress.has(k)) return errors.cycle;

    this.inProgress.add(k);
    let result: Scalar;
    try {
      result = f.ast ? evaluate(f.ast, this.ctx, shift) : errors.syntax;
    } catch (e) {
      // very long dependency chains (a running total filled down 100k rows)
      // recurse once per row and can blow the stack
      if (e instanceof RangeError) result = errors.cycle;
      else throw e;
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
    // every row. It visits in base order, so when sorted it's only valid if
    // the range covers whole columns (then order doesn't matter).
    const fast = hasNumericColumns(this.base) ? this.base : null;
    const orderOk = !this.order || (range.top === 0 && bottom === this.rowCount - 1);
    let allFast = fast !== null && orderOk;
    for (let c = range.left; allFast && c <= right; c++) {
      allFast = !this.columnTouched(c) && fast!.numberColumn(c) !== null;
    }

    if (allFast) {
      for (let c = range.left; c <= right; c++) {
        const values = fast!.numberColumn(c)!;
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

function formulaText(f: Formula, shift: number): string {
  return shift === 0 || !f.ast ? f.text : formatFormula(f.ast, shift);
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
