/**
 * The clean-up tool's logic: read a sheet as text, un-wrap the report,
 * work out each column's type, and build the clean sheet and the list of
 * dropped rows. Pure, so the action can redo it exactly.
 */
import { formatValue, isDateFormat, parseAs, profileColumn, unwrapReport, type ColumnProfile, type DroppedRow, Table, type ColumnData } from "@cellforge/core";
import { EditableSource, type Stored } from "./editable";

export interface CleanPlan {
  header: string[];
  headerRow: number;
  dataRows: number;
  sourceRows: number[];
  dropped: DroppedRow[];
  filledDown: number[];
  profiles: ColumnProfile[];
}

const MAX_CLEAN_ROWS = 2_000_000;

/** Column names shown in the grid's header (an imported or clean sheet), or null. */
export function namedHeader(src: EditableSource): string[] | null {
  const cols = src.usedRange().cols;
  const names = Array.from({ length: cols }, (_, c) => src.getColumnName?.(c) ?? "");
  return names.some(Boolean) ? names : null;
}

/**
 * The sheet's used area as text, the way it reads on screen. Column names
 * shown in the grid's header come first, as row "-1" (shift 1).
 */
export function sheetText(src: EditableSource): string[][] {
  const { rows, cols } = src.usedRange();
  if (rows > MAX_CLEAN_ROWS) throw new Error(`Clean-up works on up to ${MAX_CLEAN_ROWS.toLocaleString()} rows for now.`);
  const named = namedHeader(src);
  const out: string[][] = named ? [named] : [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      const v = src.getCell(r, c);
      const code = typeof v === "number" ? src.getStyle(r, c)?.numFmt : undefined;
      // a value already shown as a date stays a date (read back as ISO text)
      if (typeof v === "number" && code && isDateFormat(code)) row.push(formatValue(v, v % 1 ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd").text);
      else row.push(v === null ? "" : String(v));
    }
    out.push(row);
  }
  return out;
}

/** Plan the clean-up. `shift` rows at the top of `text` aren't sheet rows (the named header), so row numbers are moved back by it. */
export function planCleanup(text: string[][], unwrap = true, shift = 0): { plan: CleanPlan; rows: string[][] } {
  const u = unwrap
    ? unwrapReport(text)
    : { header: text[0] ?? [], rows: text.slice(1), sourceRows: text.slice(1).map((_, i) => i + 1), headerRow: 0, dropped: [], filledDown: [] };
  const width = u.header.length;
  const profiles = Array.from({ length: width }, (_, c) => profileColumn(u.rows.map((r) => r[c] ?? "")));
  return {
    plan: {
      header: u.header,
      headerRow: u.headerRow - shift,
      dataRows: u.rows.length,
      sourceRows: u.sourceRows.map((r) => r - shift),
      dropped: u.dropped.map((d) => ({ ...d, row: d.row - shift })),
      filledDown: u.filledDown,
      profiles,
    },
    rows: u.rows,
  };
}

/**
 * The clean sheet: column names in row 1 (as the imported data's header),
 * numbers and dates as real values, text as text; anything that didn't fit
 * its column's type stays as the original text so nothing is lost.
 */
export function buildClean(plan: CleanPlan, rows: string[][]): { source: EditableSource; formats: { col: number; numFmt: string }[] } {
  const n = rows.length;
  const columns: ColumnData[] = [];
  const edits: { row: number; col: number; value: Stored }[] = [];
  plan.header.forEach((name, c) => {
    const p = plan.profiles[c];
    if (p.type === "number" || p.type === "date") {
      const values = new Float64Array(n).fill(NaN);
      rows.forEach((r, i) => {
        const raw = r[c] ?? "";
        if (!raw) return;
        const v = parseAs(raw, p);
        if (v !== null) values[i] = v;
        else edits.push({ row: i, col: c, value: raw }); // a misfit keeps its text
      });
      columns.push({ kind: "number", name, values });
    } else {
      const codes = new Uint32Array(n);
      const dict: string[] = [];
      const lookup = new Map<string, number>();
      rows.forEach((r, i) => {
        const s = r[c] ?? "";
        if (!s) return;
        let code = lookup.get(s);
        if (code === undefined) {
          dict.push(s);
          code = dict.length;
          lookup.set(s, code);
        }
        codes[i] = code;
      });
      columns.push({ kind: "string", name, codes, dict });
    }
  });
  const source = new EditableSource(new Table(columns), 5);
  source.loadEdits(edits);
  const formats = plan.profiles.flatMap((p, col) => (p.numFmt ? [{ col, numFmt: p.numFmt }] : []));
  for (const f of formats) source.styles.apply(f.col, "all", { numFmt: f.numFmt });
  return { source, formats };
}

/** The dropped rows as a small sheet: where each was and why. */
export function buildDropped(plan: CleanPlan): EditableSource {
  const n = plan.dropped.length;
  const row = new Float64Array(n);
  const reason = new Uint32Array(n);
  const text = new Uint32Array(n);
  const reasons: string[] = [];
  const texts: string[] = [];
  const code = (list: string[], s: string) => {
    let i = list.indexOf(s);
    if (i < 0) i = list.push(s) - 1;
    return i + 1;
  };
  plan.dropped.forEach((d, i) => {
    row[i] = d.row + 1; // 0 = the column names
    reason[i] = code(reasons, d.reason);
    if (d.text) text[i] = code(texts, d.text);
  });
  return new EditableSource(
    new Table([
      { kind: "number", name: "original row", values: row },
      { kind: "string", name: "why it was dropped", codes: reason, dict: reasons },
      { kind: "string", name: "what it said", codes: text, dict: texts },
    ]),
  );
}
