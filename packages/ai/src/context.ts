/**
 * What the parser, the validator and a model get to know about the
 * workbook: just enough to turn "sort by amount" into column numbers. No
 * cell values beyond the header texts, so a prompt stays small.
 */

export interface CellRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface SheetInfo {
  /** sheet id, as actions take it */
  id: string;
  /** the name on the tab */
  name: string;
  /** header text per column (index = column, 0-based); "" for a column with no header */
  columns: string[];
  /**
   * Where the header is: 0 when the first row holds the column names (it
   * stays on top when sorting), -1 when the sheet has its own column names
   * (an imported file) or no header at all.
   */
  headerRow: number;
  rowCount: number;
  /** defaults to columns.length */
  colCount?: number;
}

export interface AskContext {
  sheets: SheetInfo[];
  /** id of the sheet on screen */
  activeSheet: string;
  /** the selected cells on the active sheet, 0-based */
  selection: CellRange;
}

export function activeSheet(ctx: AskContext): SheetInfo {
  return ctx.sheets.find((s) => s.id === ctx.activeSheet) ?? ctx.sheets[0];
}

export const colCount = (sheet: SheetInfo): number => sheet.colCount ?? sheet.columns.length;

/** A, B, ..., Z, AA, ... */
export function columnLetter(col: number): string {
  let s = "";
  let n = col + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "AB" → 27; -1 if not letters */
export function columnIndex(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export const cellRef = (row: number, col: number) => `${columnLetter(col)}${row + 1}`;

export function rangeRef(r: CellRange): string {
  return r.top === r.bottom && r.left === r.right ? cellRef(r.top, r.left) : `${cellRef(r.top, r.left)}:${cellRef(r.bottom, r.right)}`;
}

/** "Amount (column C)", or "column C" when it has no header. */
export function columnLabel(sheet: SheetInfo, col: number): string {
  const name = sheet.columns[col];
  return name ? `${name} (column ${columnLetter(col)})` : `column ${columnLetter(col)}`;
}

/** First data row: just under the header row, if there is one. */
export const firstDataRow = (sheet: SheetInfo) => (sheet.headerRow >= 0 ? sheet.headerRow + 1 : 0);

/** A whole column's data cells (below the header). */
export function columnData(sheet: SheetInfo, left: number, right = left): CellRange {
  const top = Math.min(firstDataRow(sheet), Math.max(0, sheet.rowCount - 1));
  return { top, left, bottom: Math.max(top, sheet.rowCount - 1), right };
}

// ------------------------------------------------------------ fuzzy names --

/** Lower case, letters and digits only, with common abbreviations folded. */
export function normalizeName(text: string): string {
  return text
    .toLowerCase()
    .replace(/#/g, " no ")
    .replace(/\b(number|num|nbr|nr)\b/g, "no")
    .replace(/\b(amt)\b/g, "amount")
    .replace(/\b(qty)\b/g, "quantity")
    .replace(/\b(desc)\b/g, "description")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/numbers?/g, "no");
}

/** Edit distance with transpositions (optimal string alignment). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const singular = (t: string) => (t.endsWith("ies") ? t.slice(0, -3) + "y" : t.endsWith("ses") ? t.slice(0, -2) : t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

export type ColumnMatch =
  | { ok: true; col: number; exact: boolean }
  | { ok: false; reason: "unknown" | "ambiguous" | "outside"; candidates: number[] };

/**
 * Find a column from what someone typed: a header name (any case, spaces,
 * plurals, a typo or two) or a column letter ("C", "column C").
 */
export function findColumn(sheet: SheetInfo, raw: string): ColumnMatch {
  let text = raw.trim().replace(/^["'“‘]|["'”’]$/g, "").trim();
  text = text.replace(/^the\s+/i, "").replace(/\s+(column|field)$/i, "");
  const forcedLetter = /^col(?:umn)?\s+([A-Za-z]{1,3})$/i.exec(text);
  const n = colCount(sheet);
  if (forcedLetter) {
    const c = columnIndex(forcedLetter[1]);
    return c < n ? { ok: true, col: c, exact: true } : { ok: false, reason: "outside", candidates: [] };
  }
  text = text.replace(/^col(?:umn)?\s+/i, "");
  const want = normalizeName(text);
  if (!want) return { ok: false, reason: "unknown", candidates: [] };
  const names = sheet.columns.map(normalizeName);
  // 1. exact header name
  const exact = names.flatMap((nm, i) => (nm && nm === want ? [i] : []));
  if (exact.length === 1) return { ok: true, col: exact[0], exact: true };
  if (exact.length > 1) return { ok: false, reason: "ambiguous", candidates: exact };
  // 2. a column letter
  if (/^[A-Za-z]{1,3}$/.test(text)) {
    const c = columnIndex(text);
    if (c < n && (text.length === 1 || text === text.toUpperCase())) return { ok: true, col: c, exact: true };
    if (text.length === 1) return { ok: false, reason: "outside", candidates: [] };
  }
  const outside = /^[A-Z]{2,3}$/.test(text) && columnIndex(text) >= n;
  // 3. plural / singular
  const sing = names.flatMap((nm, i) => (nm && singular(nm) === singular(want) ? [i] : []));
  if (sing.length === 1) return { ok: true, col: sing[0], exact: false };
  // 4. close spelling
  const scored = names
    .map((nm, i) => ({ i, d: nm ? Math.min(editDistance(nm, want), editDistance(singular(nm), singular(want))) : 99, len: nm.length }))
    .filter((x) => x.d <= Math.max(1, Math.floor(Math.min(x.len, want.length) / 4)))
    .sort((a, b) => a.d - b.d);
  if (scored.length === 1 || (scored.length > 1 && scored[0].d < scored[1].d)) return { ok: true, col: scored[0].i, exact: false };
  if (scored.length > 1) return { ok: false, reason: "ambiguous", candidates: scored.filter((x) => x.d === scored[0].d).map((x) => x.i) };
  // 5. a unique header that starts with, or contains, what was typed ("invoice" → "Invoice Number")
  if (want.length >= 3) {
    const starts = names.flatMap((nm, i) => (nm.startsWith(want) ? [i] : []));
    if (starts.length === 1) return { ok: true, col: starts[0], exact: false };
    const contains = names.flatMap((nm, i) => (nm.includes(want) ? [i] : []));
    if (contains.length === 1) return { ok: true, col: contains[0], exact: false };
    if (contains.length > 1) return { ok: false, reason: "ambiguous", candidates: contains };
  }
  return { ok: false, reason: outside ? "outside" : "unknown", candidates: [] };
}

/** Header names closest to what was typed, for "did you mean". */
export function closestColumns(sheet: SheetInfo, raw: string, max = 3): number[] {
  const want = normalizeName(raw);
  return sheet.columns
    .map((c, i) => ({ i, d: c ? editDistance(normalizeName(c), want) : 99 }))
    .filter((x) => x.d < 99)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.i);
}
