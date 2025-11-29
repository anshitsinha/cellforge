import type { CellValue, DataSource } from "@cellforge/grid";

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

/**
 * Wraps a read-only source and layers user edits on top of it.
 *
 * Edits are kept in a sparse map, so editing a handful of cells in a 100M row
 * sheet costs a handful of map entries, not a copy of the data. This is a
 * stopgap until the columnar store exists - it'll keep the same "dense base +
 * sparse overrides" idea though.
 */
export class EditableSource implements DataSource {
  // row -> (col -> value). Nested so clearing/looking up a row is cheap.
  private edits = new Map<number, Map<number, CellValue>>();
  private count = 0;

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

  getCell(row: number, col: number): CellValue {
    const rowEdits = this.edits.get(row);
    if (rowEdits?.has(col)) return rowEdits.get(col)!;
    return this.base.getCell(row, col);
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

  setCell(row: number, col: number, value: CellValue): void {
    let rowEdits = this.edits.get(row);
    if (!rowEdits) {
      rowEdits = new Map();
      this.edits.set(row, rowEdits);
    }
    if (!rowEdits.has(col)) this.count++;
    rowEdits.set(col, value);
  }
}

/**
 * Turn what the user typed into a cell value. Numbers become numbers so they
 * right-align and (later) work in formulas; everything else stays a string.
 */
export function parseInput(text: string): CellValue {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // Number("") and Number(" ") are 0, and Number("0x1f") is 31 - neither of
  // which we want, hence the regex instead of just Number(trimmed).
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) {
    return Number(trimmed);
  }
  return text;
}
