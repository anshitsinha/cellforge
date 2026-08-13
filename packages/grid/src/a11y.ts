/**
 * What a screen reader hears about the grid. A canvas has no content a
 * screen reader can read, so the grid keeps an off-screen live region and
 * puts plain sentences in it: the active cell, the size of the selection,
 * edits and errors. These helpers build the sentences; they're pure so
 * they can be tested without a DOM.
 */
import { columnLetter } from "./columns";
import type { CellRange } from "./types";

/** Excel's error values, as cells show them. */
const ERRORS = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!)$/;

export function isErrorText(text: string): boolean {
  return ERRORS.test(text);
}

/** "B5" for row 4, column 1 (both 0-based). */
export function cellAddress(row: number, col: number): string {
  return `${columnLetter(col)}${row + 1}`;
}

/** "B2:D10" (or "B2" for a single cell). */
export function rangeAddress(r: CellRange): string {
  const a = cellAddress(r.top, r.left);
  return r.top === r.bottom && r.left === r.right ? a : `${a}:${cellAddress(r.bottom, r.right)}`;
}

export interface CellInfo {
  row: number;
  col: number;
  /** the column's name (a header), if it has one */
  columnName?: string;
  /** what the cell shows ("1,234.50"), empty for a blank cell */
  shown: string;
  /** what editing would show; a formula starts with "=" */
  editText?: string;
}

/** "B5, Amount, 1,234.50, formula =SUM(B2:B4)". Blank cells say "blank"; errors say "error". */
export function describeCell(c: CellInfo): string {
  const parts = [cellAddress(c.row, c.col)];
  if (c.columnName) parts.push(c.columnName);
  const shown = c.shown.trim();
  if (!shown) parts.push("blank");
  else if (isErrorText(shown)) parts.push(`error ${shown}`);
  else parts.push(shown);
  if (c.editText?.startsWith("=")) parts.push(`formula ${c.editText}`);
  return parts.join(", ");
}

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "B2:D10 selected, 9 rows by 3 columns, 27 cells"; null for a single cell. */
export function describeRange(r: CellRange): string | null {
  const rows = r.bottom - r.top + 1;
  const cols = r.right - r.left + 1;
  if (rows === 1 && cols === 1) return null;
  return `${rangeAddress(r)} selected, ${plural(rows, "row")} by ${plural(cols, "column")}, ${plural(rows * cols, "cell")}`;
}

/** After an edit: "B5 set to 1,234.50", "B5 cleared", or the error the cell now shows. */
export function describeEdit(c: CellInfo): string {
  const at = cellAddress(c.row, c.col);
  const shown = c.shown.trim();
  if (!shown) return `${at} cleared`;
  if (isErrorText(shown)) return `${at} now shows error ${shown}`;
  return `${at} set to ${shown}`;
}

/** The keys the grid answers to, read out as its description. */
export const GRID_KEY_HELP =
  "Spreadsheet. Arrow keys move. Shift with arrows selects. Control with arrows jumps to the edge. " +
  "Page Up and Page Down move a screen. Home and End go to the start and end of the row. " +
  "Type to replace a cell, F2 to edit it, Enter to save, Escape to cancel. Delete clears. " +
  "Control A selects everything. Shift F10 or the Menu key opens the cell menu. " +
  "Alt Down opens a list or filter. Control K finds any command. " +
  "Press Escape, then Tab, to leave the grid.";

/** Whether a key press asks for the cell menu (the Menu key or Shift+F10). */
export function isMenuKey(e: { key: string; shiftKey: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): boolean {
  if (e.key === "ContextMenu") return true;
  return e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
}
