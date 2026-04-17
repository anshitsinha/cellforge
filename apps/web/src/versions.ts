/**
 * Named versions ("sent to auditor", "before the restatement"): a copy of
 * every sheet's state at one moment. Cheap, because the imported data is
 * shared and never changes; only what's on top of it (edits, formats,
 * row order...) is kept.
 */
import type { DataSource } from "@cellforge/grid";
import { columnLetter } from "@cellforge/grid";
import { EditableSource, type SheetState } from "./editable";
import { Workbook, type Sheet } from "./workbook";

export interface VersionSheet {
  id: string;
  name: string;
  color?: string;
  hidden?: boolean;
  base: DataSource;
  extra: number;
  state: SheetState;
  order?: Uint32Array;
}

export interface Version {
  name: string;
  /** when it was saved (ms since 1970) */
  at: number;
  sheets: VersionSheet[];
}

/** The workbook as it is now, as a version. */
export function captureVersion(wb: Workbook, name: string, at = Date.now()): Version {
  return {
    name,
    at,
    sheets: wb.sheets.map((s) => {
      const { state, binary } = s.source.toState();
      // the state is fresh data, but deep-copy it so later edits can't reach it
      return {
        id: s.id,
        name: s.name,
        ...(s.color ? { color: s.color } : {}),
        ...(s.hidden ? { hidden: true } : {}),
        base: s.source.baseSource,
        extra: s.source.extraColumnCount,
        state: structuredClone(state),
        ...(binary.order ? { order: binary.order } : {}),
      };
    }),
  };
}

/** Sheets rebuilt from a version (new sources; the base data is shared). */
export function versionSheets(v: Version): Sheet[] {
  return v.sheets.map((s) => ({
    id: s.id,
    name: s.name,
    source: EditableSource.fromState(s.base, s.extra, structuredClone(s.state), { order: s.order }),
    ...(s.color ? { color: s.color } : {}),
    ...(s.hidden ? { hidden: true } : {}),
  }));
}

export interface CellChange {
  sheet: string;
  /** e.g. B4, where the cell is in the newer of the two */
  cell: string;
  row: number;
  col: number;
  before: string;
  after: string;
}

export interface Comparison {
  changes: CellChange[];
  /** sheets only in one of the two, renamed, or re-sorted */
  notes: string[];
  /** true when there were more changes than listed */
  truncated: boolean;
}

/** What a cell shows, with its formula when it has one: "=A1*2 → 10". */
function shown(src: EditableSource, row: number, col: number): string {
  const v = src.getCell(row, col);
  const value = v === null ? "" : String(v);
  const text = src.getEditText(row, col);
  return text.startsWith("=") ? `${text} → ${value}` : value;
}

/**
 * Cells that differ between two points. Cells are matched by row identity,
 * so a sort or an inserted row doesn't make everything look changed.
 * Checked: every cell either side edited or filled.
 */
export function compareWorkbooks(older: Workbook, newer: Workbook, limit = 2000): Comparison {
  const changes: CellChange[] = [];
  const notes: string[] = [];
  let truncated = false;
  for (const ns of newer.sheets) {
    const os = older.sheets.find((s) => s.id === ns.id);
    if (!os) {
      notes.push(`Sheet "${ns.name}" was added.`);
      continue;
    }
    if (os.name !== ns.name) notes.push(`Sheet "${os.name}" was renamed to "${ns.name}".`);
    const a = os.source;
    const b = ns.source;
    if (a.baseSource !== b.baseSource) {
      notes.push(`Sheet "${ns.name}" holds different imported data.`);
      continue;
    }
    // view row of each row id, both sides
    const posA = rowPositions(a);
    const posB = rowPositions(b);
    if (a.rowCount !== b.rowCount) notes.push(`Sheet "${ns.name}" went from ${a.rowCount.toLocaleString()} to ${b.rowCount.toLocaleString()} rows.`);
    if (a.colCount !== b.colCount) notes.push(`Sheet "${ns.name}" went from ${a.colCount} to ${b.colCount} columns.`);
    if (a.rowOrder !== b.rowOrder && (a.rowOrder || b.rowOrder) && a.rowCount === b.rowCount) notes.push(`Rows on "${ns.name}" are in a different order (sorted).`);
    const cells = new Set<string>();
    for (const src of [a, b]) for (const [id, col] of src.touchedCells(200_000)) cells.add(`${id}:${col}`);
    for (const key of cells) {
      const [id, col] = key.split(":").map(Number);
      const ra = posA(id);
      const rb = posB(id);
      const before = ra >= 0 && col < a.colCount ? shown(a, ra, col) : "";
      const after = rb >= 0 && col < b.colCount ? shown(b, rb, col) : "";
      if (before === after) continue;
      if (changes.length >= limit) {
        truncated = true;
        break;
      }
      const row = rb >= 0 ? rb : ra;
      changes.push({ sheet: ns.name, cell: `${columnLetter(col)}${row + 1}`, row, col, before, after });
    }
  }
  for (const os of older.sheets) if (!newer.sheets.some((s) => s.id === os.id)) notes.push(`Sheet "${os.name}" was deleted.`);
  changes.sort((x, y) => (x.sheet === y.sheet ? x.row - y.row || x.col - y.col : x.sheet < y.sheet ? -1 : 1));
  return { changes, notes, truncated };
}

function rowPositions(src: EditableSource): (id: number) => number {
  return src.rowIdToView();
}

/** A throwaway workbook for a version, to compare against. */
export function versionWorkbook(v: Version): Workbook {
  return Workbook.restore(versionSheets(v));
}
