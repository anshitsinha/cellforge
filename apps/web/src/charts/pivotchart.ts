/**
 * Pivot charts: the pivot of a sheet worked out afresh and laid out as a
 * small grid (labels down the first column, one column per series), which
 * the ordinary chart code then reads like a range of cells. Subtotals and
 * grand totals are left out so bars compare like with like.
 */
import { pivot, type PivotSpec } from "@cellforge/core";
import type { CellValue } from "@cellforge/grid";
import { pivotTable, readSheetColumns, type ColumnSource, type PivotTable, type SheetColumns } from "../pivotpanel";
import type { ChartSource } from "./data";
import type { ChartSpec, SavedPivot } from "./model";
import { loadPivot } from "./pivotspec";

/** A pivot laid out as cells: row 0 holds the series names, column 0 the labels. */
export interface PivotGrid extends ChartSource {
  rows: number;
  cols: number;
  /** the full pivot table (with totals), for showing as a table */
  table: PivotTable;
}

/** Does this chart source also have what reading a pivot needs? EditableSource does. */
export function isColumnSource(src: unknown): src is ColumnSource {
  const s = src as Partial<ColumnSource> | null;
  return !!s && typeof s.getColumnName === "function" && typeof s.toBase === "function" && typeof s.baseColumn === "function";
}

/** The pivot of `data`, as a table. */
export function pivotOf(data: SheetColumns, spec: PivotSpec): PivotTable {
  if (!data.columns.length) throw new Error("The sheet the pivot reads has no data.");
  if (!spec.values.length && !spec.rows.length && !spec.cols.length) throw new Error("The pivot has no fields.");
  return pivotTable(pivot(data.columns, spec), data);
}

/** The grid a pivot chart draws: leaf rows, and the leaf columns of each value. */
export function pivotGridOf(data: SheetColumns, spec: PivotSpec): PivotGrid {
  const result = pivot(data.columns, spec);
  const table = pivotTable(result, data);
  const hasCols = result.colFields.length > 0;
  const hasRows = result.rowFields.length > 0;
  // value columns of leaf column items (or the one grand column when nothing is on Columns)
  const keepCols: number[] = [];
  table.valueAt.forEach(({ c }, j) => {
    const kind = result.colItems[c].kind;
    if (hasCols ? kind === "leaf" : true) keepCols.push(table.labelCols + j);
  });
  const keepRows = table.rows.filter((r) => (hasRows ? r.kind === "leaf" : true));
  const label = (cells: (string | number | null)[]) =>
    cells
      .slice(0, table.labelCols)
      .filter((x) => x !== null && x !== "")
      .join(" / ");
  const grid: CellValue[][] = [["", ...keepCols.map((j) => table.headers[j])]];
  for (const r of keepRows) grid.push([label(r.cells), ...keepCols.map((j) => r.cells[j] as CellValue)]);
  const fmts = ["", ...keepCols.map((j) => table.numFmts[j])];
  return {
    rows: grid.length,
    cols: grid[0].length,
    table,
    getCell: (r, c) => grid[r]?.[c] ?? null,
    getStyle: (r, c) => (r > 0 && fmts[c] ? { numFmt: fmts[c] } : null),
    usedRange: () => ({ rows: grid.length, cols: grid[0].length }),
  };
}

/** Read the sheet and lay out a saved pivot for a chart. */
export function pivotGrid(src: ColumnSource, saved: SavedPivot, tweak?: (spec: PivotSpec, data: SheetColumns) => PivotSpec): PivotGrid {
  const data = readSheetColumns(src);
  let spec = loadPivot(saved, data.names);
  if (tweak) spec = tweak(spec, data);
  return pivotGridOf(data, spec);
}

/**
 * What a chart reads: its sheet, or for a pivot chart the pivot's grid with
 * the spec's range pointed at all of it. Throws with a message to show when
 * the pivot can't be worked out.
 */
export function chartInput(spec: ChartSpec, source: (sheetId: string) => ChartSource | null, tweak?: (spec: PivotSpec, data: SheetColumns) => PivotSpec): { src: ChartSource; spec: ChartSpec } | null {
  if (!spec.pivot) {
    const src = source(spec.range.sheetId);
    return src ? { src, spec } : null;
  }
  const src = source(spec.pivot.sheetId);
  if (!src) return null;
  if (!isColumnSource(src)) throw new Error("This sheet can't be pivoted.");
  const grid = pivotGrid(src, spec.pivot.pivot, tweak);
  if (grid.rows < 2 || grid.cols < 2) throw new Error("The pivot has nothing to chart. Put a field on Rows and one on Values.");
  return {
    src: grid,
    spec: { ...spec, range: { sheetId: spec.pivot.sheetId, top: 0, left: 0, bottom: grid.rows - 1, right: grid.cols - 1 }, seriesIn: "columns", names: true, labels: true },
  };
}
