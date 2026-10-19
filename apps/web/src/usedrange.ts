/**
 * How much of a sheet actually holds data. `usedRange()` counts every cell
 * that has an edit or a filled formula, so a template whose formulas run
 * down 2,000 rows (showing "" until their inputs are filled) looks 2,000
 * rows deep. Tools that count, sort, pivot or chart "the data" want the
 * last row and column that show something instead.
 */
import type { EditableSource } from "./editable";

/** Most columns looked at when deciding whether a row is blank. */
const MAX_SCAN_COLS = 256;

const shows = (v: unknown) => v !== null && v !== undefined && !(typeof v === "string" && v.trim() === "");

/** The used area, trimmed to the last row and column that show a value. */
export function dataExtent(src: Pick<EditableSource, "usedRange" | "getCell">): { rows: number; cols: number } {
  const used = src.usedRange();
  const cols = Math.min(used.cols, MAX_SCAN_COLS);
  let rows = used.rows;
  // from the bottom: big imported data ends in data, so this stops at once;
  // a template stops after its formula-only rows
  for (; rows > 0; rows--) {
    let any = false;
    for (let c = 0; c < cols && !any; c++) any = shows(src.getCell(rows - 1, c));
    if (any) break;
  }
  let lastCol = 0;
  if (rows > 0) {
    // the rightmost column with a value, from a sample of rows (header plus the first and last stretch)
    const sample = new Set<number>();
    for (let r = 0; r < Math.min(rows, 200); r++) sample.add(r);
    for (let r = Math.max(0, rows - 200); r < rows; r++) sample.add(r);
    for (const r of sample) for (let c = cols - 1; c >= lastCol; c--) if (shows(src.getCell(r, c))) { lastCol = c + 1; break; }
  }
  return { rows, cols: rows > 0 ? lastCol : 0 };
}

/** Rows that hold data (including a header row, if the sheet has one). */
export const dataRows = (src: Pick<EditableSource, "usedRange" | "getCell">) => dataExtent(src).rows;
