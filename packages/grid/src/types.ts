export type CellValue = string | number | null;

/**
 * Anything the grid can display. The grid only ever asks for cells that are
 * currently on screen, so implementations are free to be lazy (generate values
 * on the fly, page them in from a worker, etc).
 */
export interface DataSource {
  readonly rowCount: number;
  readonly colCount: number;
  getCell(row: number, col: number): CellValue;
  /**
   * Optional header label. Falls back to spreadsheet letters (A, B, ... AA)
   * when missing or when it returns undefined.
   */
  getColumnName?(col: number): string | undefined;
  /**
   * Optional text to put in the editor when a cell is edited. Lets a source
   * show "=SUM(A1:A9)" for editing while getCell returns the result.
   */
  getEditText?(row: number, col: number): string;
  /** Optional cell formatting; null or undefined means the default look. */
  getStyle?(row: number, col: number): CellStyle | null | undefined;
  /**
   * Optional display text for a value (number formats). A colour from the
   * format (e.g. [Red]) wins over the cell's text colour.
   */
  formatValue?(value: CellValue, style: CellStyle | null): { text: string; color?: string };
  /** True when a cell has something to explain (a lookup near miss): drawn as a corner marker. */
  hasNote?(row: number, col: number): boolean;
}

export interface CellRef {
  row: number;
  col: number;
}

/** Inclusive rectangle of cells, always normalised so top <= bottom etc. */
export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface GridOptions {
  rowHeight?: number;
  headerHeight?: number;
  defaultColumnWidth?: number;
  /**
   * Handle touch input (swipe to scroll, tap to select, double-tap to edit).
   * Turn off for decorative grids that sit inside a scrolling page, so a
   * swipe over them still scrolls the page. Default true.
   */
  touch?: boolean;
  /**
   * Font size for the in-cell editor. iOS Safari zooms the whole page when
   * focusing an input with text smaller than 16px, so use 16 on phones.
   */
  editorFontSize?: number;
}

export interface Theme {
  background: string;
  headerBackground: string;
  gridLine: string;
  text: string;
  mutedText: string;
  accent: string;
}

export type BorderStyle = "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";

export interface BorderLine {
  style: BorderStyle;
  color: string;
}

/**
 * How a cell looks. Every property is optional; a missing one means the
 * default (the theme's text colour, no fill, numbers right / text left, ...).
 */
export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** font size in points */
  size?: number;
  font?: string;
  color?: string;
  fill?: string;
  /** centerAcross: centred over the empty cells to the right that share it */
  align?: "left" | "center" | "right" | "centerAcross";
  valign?: "top" | "middle" | "bottom";
  wrap?: boolean;
  /** Excel number format code, e.g. "#,##0.00" or "yyyy-mm-dd" */
  numFmt?: string;
  borderTop?: BorderLine;
  borderRight?: BorderLine;
  borderBottom?: BorderLine;
  borderLeft?: BorderLine;
}
