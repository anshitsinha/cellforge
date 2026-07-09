import type { ColumnData } from "./columns";

export type Value = string | number | null;

/**
 * A read-only table backed by typed-array columns.
 *
 * Structurally matches the grid's DataSource interface, but core doesn't
 * import from the grid package - data shouldn't depend on rendering.
 */
export class Table {
  readonly rowCount: number;

  constructor(readonly columns: ColumnData[]) {
    this.rowCount = columns.length
      ? columns[0].kind === "number"
        ? columns[0].values.length
        : columns[0].codes.length
      : 0;
  }

  get colCount(): number {
    return this.columns.length;
  }

  getColumnName(col: number): string | undefined {
    return this.columns[col]?.name;
  }

  getCell(row: number, col: number): Value {
    const column = this.columns[col];
    if (!column || row >= this.rowCount) return null;
    if (column.kind === "number") {
      const v = column.values[row];
      return Number.isNaN(v) ? null : v;
    }
    const code = column.codes[row];
    return code === 0 ? null : column.dict[code - 1];
  }
}
