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
}

export interface Theme {
  background: string;
  headerBackground: string;
  gridLine: string;
  text: string;
  mutedText: string;
  accent: string;
}
