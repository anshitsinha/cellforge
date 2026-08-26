/**
 * Footing (adding up each column), cross-footing (adding across each row)
 * and roll-forward checks (opening + movements = closing), compared with
 * the totals the schedule states. Blank and text cells count as nothing.
 */
import { cellNumber, type Cell } from "../audit/values";

export interface FootLine {
  /** Row or column index within the range. */
  index: number;
  /** The row's or column's label, when there is one. */
  label: string;
  computed: number;
  /** The stated total, or null when its cell is blank or not a number. */
  stated: number | null;
  difference: number;
  ok: boolean;
}

export interface FootOptions {
  /** Rows at the top that hold headings (not added). Default 0. */
  headerRows?: number;
  /** Columns on the left that hold labels (not added). Default 0. */
  labelCols?: number;
  /** The last row holds the stated column totals. Default true. */
  totalRow?: boolean;
  /** The last column holds the stated row totals. Default true. */
  totalCol?: boolean;
  /** Differences up to this are fine. Default 0.005. */
  tolerance?: number;
}

export interface FootResult {
  /** Footing: each column added down, against the total row. */
  columns: FootLine[];
  /** Cross-footing: each row added across, against the total column. */
  rows: FootLine[];
  /** The corner cell (grand total) against the sum of the total row and the sum of the total column. */
  grand: { stated: number | null; byColumns: number; byRows: number; ok: boolean } | null;
  /** Lines (and the grand total) that don't agree. */
  issues: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function line(index: number, label: string, computed: number, stated: number | null, tol: number): FootLine {
  const difference = stated === null ? r2(-computed) : r2(stated - computed);
  return { index, label, computed: r2(computed), stated, difference, ok: stated === null ? Math.abs(computed) <= tol : Math.abs(stated - computed) <= tol };
}

/** Foot and cross-foot a block of cells (rows of columns). */
export function footRange(cells: readonly (readonly Cell[])[], opts: FootOptions = {}): FootResult {
  const tol = opts.tolerance ?? 0.005;
  const h = Math.max(0, opts.headerRows ?? 0);
  const l = Math.max(0, opts.labelCols ?? 0);
  const totalRow = opts.totalRow ?? true;
  const totalCol = opts.totalCol ?? true;
  const nr = cells.length;
  const nc = cells.reduce((m, r) => Math.max(m, r.length), 0);
  const num = (r: number, c: number) => cellNumber(cells[r]?.[c]) ?? 0;
  const stated = (r: number, c: number) => cellNumber(cells[r]?.[c]);
  const lastR = totalRow ? nr - 1 : nr;
  const lastC = totalCol ? nc - 1 : nc;
  const text = (v: Cell | undefined) => (v === null || v === undefined ? "" : String(v).trim());
  const colLabel = (c: number) => (h ? text(cells[h - 1]?.[c]) : "");
  const rowLabel = (r: number) => (l ? Array.from({ length: l }, (_, c) => text(cells[r]?.[c])).filter(Boolean).join(" ") : "");
  const columns: FootLine[] = [];
  const rows: FootLine[] = [];
  if (totalRow && lastR > h) {
    for (let c = l; c < nc; c++) {
      let s = 0;
      for (let r = h; r < lastR; r++) s += num(r, c);
      columns.push(line(c, colLabel(c), s, stated(lastR, c), tol));
    }
  }
  if (totalCol && lastC > l) {
    for (let r = h; r < nr; r++) {
      let s = 0;
      for (let c = l; c < lastC; c++) s += num(r, c);
      rows.push(line(r, rowLabel(r), s, stated(r, lastC), tol));
    }
  }
  let grand: FootResult["grand"] = null;
  if (totalRow && totalCol && lastR > h && lastC > l) {
    let byColumns = 0;
    for (let c = l; c < lastC; c++) byColumns += num(lastR, c);
    let byRows = 0;
    for (let r = h; r < lastR; r++) byRows += num(r, lastC);
    const g = stated(lastR, lastC);
    grand = { stated: g, byColumns: r2(byColumns), byRows: r2(byRows), ok: g !== null && Math.abs(g - byColumns) <= tol && Math.abs(g - byRows) <= tol };
  }
  const issues = columns.filter((x) => !x.ok).length + rows.filter((x) => !x.ok).length + (grand && !grand.ok ? 1 : 0);
  return { columns, rows, grand, issues };
}

/** Guess the heading rows and label columns of a block: a top row with text in it, and left columns that are mostly text. */
export function guessFootLayout(cells: readonly (readonly Cell[])[]): { headerRows: number; labelCols: number } {
  const isText = (v: Cell | undefined) => typeof v === "string" && v.trim() !== "" && cellNumber(v) === null;
  const nc = cells.reduce((m, r) => Math.max(m, r.length), 0);
  let headerRows = 0;
  while (headerRows < Math.min(3, cells.length - 1)) {
    const row = cells[headerRows];
    // a heading row has text, and its numbers (if any) look like years
    const yearish = (v: Cell) => /^(19|20)\d\d$/.test(String(v).trim());
    if (row.some((v) => isText(v) || yearish(v)) && row.every((v) => v === null || v === "" || isText(v) || yearish(v))) headerRows++;
    else break;
  }
  let labelCols = 0;
  while (labelCols < Math.min(3, nc - 1)) {
    let t = 0;
    let n = 0;
    for (let r = headerRows; r < cells.length; r++) {
      const v = cells[r][labelCols];
      if (isText(v)) t++;
      else if (cellNumber(v) !== null) n++;
    }
    if (t > 0 && t >= n) labelCols++;
    else break;
  }
  return { headerRows, labelCols };
}

export interface RollLine {
  index: number;
  opening: number;
  movements: number[];
  expected: number;
  closing: number | null;
  difference: number;
  ok: boolean;
}

export interface RollResult {
  lines: RollLine[];
  issues: number;
  totals: { opening: number; movements: number[]; expected: number; closing: number };
}

/**
 * Roll-forward: opening + each movement (times its sign) should equal the
 * closing balance, line by line. Rows with nothing in them are skipped.
 */
export function rollForward(opening: readonly Cell[], movements: readonly { values: readonly Cell[]; sign?: 1 | -1 }[], closing: readonly Cell[], tolerance = 0.005): RollResult {
  const n = Math.max(opening.length, closing.length, ...movements.map((m) => m.values.length));
  const lines: RollLine[] = [];
  const totals = { opening: 0, movements: movements.map(() => 0), expected: 0, closing: 0 };
  for (let i = 0; i < n; i++) {
    const o = cellNumber(opening[i]);
    const ms = movements.map((m) => cellNumber(m.values[i]));
    const c = cellNumber(closing[i]);
    if (o === null && c === null && ms.every((x) => x === null)) continue;
    const mv = ms.map((x, k) => (x ?? 0) * (movements[k].sign ?? 1));
    const expected = r2((o ?? 0) + mv.reduce((a, b) => a + b, 0));
    const difference = r2((c ?? 0) - expected);
    const ok = Math.abs((c ?? 0) - expected) <= tolerance;
    lines.push({ index: i, opening: o ?? 0, movements: mv, expected, closing: c, difference, ok });
    totals.opening += o ?? 0;
    mv.forEach((x, k) => (totals.movements[k] += x));
    totals.expected += expected;
    totals.closing += c ?? 0;
  }
  totals.opening = r2(totals.opening);
  totals.movements = totals.movements.map(r2);
  totals.expected = r2(totals.expected);
  totals.closing = r2(totals.closing);
  return { lines, issues: lines.filter((x) => !x.ok).length, totals };
}
