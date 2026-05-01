/**
 * Array values: what =A1:A3*2, FILTER(...) or SEQUENCE(5) evaluate to.
 * A formula whose result is an array "spills" into the cells below and to
 * the right of it (see the sheet). Row-major, like Excel's arrays.
 */
import { CellError, errors, type Node } from "./ast";

export type Scalar = number | string | boolean | null | CellError;

export class CellArray {
  constructor(
    readonly rows: number,
    readonly cols: number,
    readonly data: Scalar[],
  ) {}

  static of(rows: Scalar[][]): CellArray {
    const r = rows.length;
    const c = Math.max(0, ...rows.map((x) => x.length));
    const data: Scalar[] = [];
    for (const row of rows) for (let j = 0; j < c; j++) data.push(j < row.length ? row[j] : errors.na);
    return new CellArray(r, c, data);
  }

  static column(values: Scalar[]): CellArray {
    return new CellArray(values.length, 1, values);
  }

  get(r: number, c: number): Scalar {
    // a single row or column broadcasts along the other direction (Excel)
    const rr = this.rows === 1 ? 0 : r;
    const cc = this.cols === 1 ? 0 : c;
    if (rr >= this.rows || cc >= this.cols) return errors.na;
    return this.data[rr * this.cols + cc];
  }

  row(r: number): Scalar[] {
    return this.data.slice(r * this.cols, (r + 1) * this.cols);
  }

  column(c: number): Scalar[] {
    return Array.from({ length: this.rows }, (_, r) => this.data[r * this.cols + c]);
  }

  map(f: (v: Scalar) => Scalar): CellArray {
    return new CellArray(this.rows, this.cols, this.data.map(f));
  }
}

/** A function made with LAMBDA. */
export class Lambda {
  constructor(
    readonly params: string[],
    readonly body: Node,
    readonly env: ReadonlyMap<string, Value>,
    /** the fill shift the LAMBDA was written under, so its references stay put */
    readonly shift = 0,
  ) {}
}

export type Value = Scalar | CellArray | Lambda;

export const isArray = (v: unknown): v is CellArray => v instanceof CellArray;

/** Element-wise over one or two operands, broadcasting single rows/columns. */
export function lift2(a: Value, b: Value, f: (x: Scalar, y: Scalar) => Scalar): Value {
  if (a instanceof Lambda || b instanceof Lambda) return errors.value;
  if (!isArray(a) && !isArray(b)) return f(a, b);
  const rows = Math.max(isArray(a) ? a.rows : 1, isArray(b) ? b.rows : 1);
  const cols = Math.max(isArray(a) ? a.cols : 1, isArray(b) ? b.cols : 1);
  const data: Scalar[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = isArray(a) ? a.get(r, c) : a;
      const y = isArray(b) ? b.get(r, c) : b;
      data.push(f(x, y));
    }
  }
  return new CellArray(rows, cols, data);
}

/** A single value out of anything: the top-left of an array (Excel's implicit intersection, simplified). */
export function firstOf(v: Value): Scalar {
  if (v instanceof Lambda) return errors.value;
  return isArray(v) ? (v.rows && v.cols ? v.data[0] : errors.calc) : v;
}
