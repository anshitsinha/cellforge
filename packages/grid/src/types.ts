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
