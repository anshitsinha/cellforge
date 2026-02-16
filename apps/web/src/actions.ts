/**
 * The workbook's actions. Everything that changes data goes through here, so
 * it is undoable, can be recorded into a recipe, and can be called by the AI
 * with the same validation a user's edit gets.
 *
 * Cell actions take an optional `sheet` id (default: the sheet on screen).
 * Inverses always name their sheet explicitly, so undoing after switching
 * tabs still changes the right sheet.
 */
import { type Action, ActionRegistry, type BlobStore, type JsonSchema, s } from "@cellforge/actions";
import { columnLetter } from "@cellforge/grid";
import { formatFormula, parseFormula, type Node, type RowChange } from "@cellforge/core";
import { type EditableSource, effectiveShift, type Fill, type FormulaSnapshot, isFormula, parseInput, type Stored } from "./editable";
import { BlankSource, EditableSource as Source } from "./editable";
import type { Sheet, Workbook } from "./workbook";

export interface SheetCtx {
  workbook: Workbook;
  /** id of the sheet on screen: the default target of cell actions */
  activeSheet: string;
  blobs: BlobStore;
  /** sorts in a worker; resolves to a view->base order, or null if cancelled */
  sortRows(sheet: EditableSource, col: number, descending: boolean): Promise<Uint32Array | null>;
  /** called when a sheet is added or restored, so the UI can show it */
  onSheetShown?(id: string): void;
}

/** A stored value as plain JSON (undo entries and recipes must serialise). */
export type StoredJson = null | number | string | { formula: string; shift?: number };

/**
 * `row` is where the value is shown now: a formula is stored with the
 * shift it has *at that row*, so restoring it there evaluates identically.
 */
export function toJson(v: Stored, row: number): StoredJson {
  if (!isFormula(v)) return v;
  const shift = effectiveShift(v, row);
  // canonical unshifted text, so the shift isn't applied twice on the way back
  const formula = v.ast ? formatFormula(v.ast, 0) : v.text;
  return shift ? { formula, shift } : { formula };
}

export function fromJson(v: StoredJson): Stored {
  if (v === null || typeof v !== "object") return v;
  let ast: Node | null = null;
  try {
    ast = parseFormula(v.formula);
  } catch {
    // unparseable formulas are kept as typed and show #ERROR!
  }
  const text = ast && v.shift ? formatFormula(ast, v.shift) : v.formula;
  return { kind: "formula", text, ast, shift: v.shift };
}

const cellRef = (row: number, col: number) => `${columnLetter(col)}${row + 1}`;

const sheetParam = s.string("sheet id; defaults to the sheet on screen");
const withSheet = (props: Record<string, JsonSchema>, required: string[]) =>
  s.object({ ...props, sheet: sheetParam }, required);

const rangeSchema = s.object(
  {
    top: s.int("first row, 0-based", 0),
    left: s.int("first column, 0-based", 0),
    bottom: s.int("last row, 0-based, inclusive", 0),
    right: s.int("last column, 0-based, inclusive", 0),
  },
  undefined,
  "a rectangle of cells",
);

interface Range {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

const storedSchema = s.anyOf(
  s.null(),
  s.number(),
  s.string(),
  s.object({ formula: s.string(), shift: s.int() }, ["formula"]),
);

/** The sheet a cell action targets, and its id for the inverse. */
function target(ctx: SheetCtx, sheet: string | undefined): { id: string; data: EditableSource } {
  const id = sheet ?? ctx.activeSheet;
  return { id, data: ctx.workbook.get(id).source };
}

// "restore" writes exact previous values: `revert` means "no edit at all,
// show the original data", which is different from an edit to empty.
type RestoreCell = { row: number; col: number; value?: StoredJson; revert?: boolean };

function snapshot(sheet: EditableSource, cells: { row: number; col: number }[]): RestoreCell[] {
  return cells.map(({ row, col }) => {
    const prev = sheet.getStored(row, col);
    return prev === undefined ? { row, col, revert: true } : { row, col, value: toJson(prev, row) };
  });
}

function checkBounds(sheet: EditableSource, cells: { row: number; col: number }[]) {
  for (const { row, col } of cells) {
    if (row >= sheet.rowCount || col >= sheet.colCount) {
      throw new Error(`${cellRef(row, col)} is outside the sheet (${sheet.rowCount} rows × ${sheet.colCount} columns)`);
    }
  }
}

function describeCells(cells: { row: number; col: number }[], verb: string) {
  if (cells.length === 1) return `${verb} ${cellRef(cells[0].row, cells[0].col)}`;
  return `${verb} ${cells.length.toLocaleString()} cells`;
}

const restoreParams = (sheet: string, cells: RestoreCell[], label?: string) => (label ? { sheet, cells, label } : { sheet, cells });

export function sheetActions(): ActionRegistry<SheetCtx> {
  const registry = new ActionRegistry<SheetCtx>();

  // ------------------------------------------------------------ cells --

  registry
    .register<{ cells: { row: number; col: number; input: string | null }[]; label?: string; sheet?: string }>({
      type: "cells.set",
      title: "Write values or formulas into cells, exactly as a user would type them",
      schema: withSheet(
        {
          cells: s.array(
            s.object({
              row: s.int("row, 0-based", 0),
              col: s.int("column, 0-based (A = 0)", 0),
              input: s.anyOf(s.string("text as typed: '42', 'hello' or '=SUM(A1:A9)'"), s.null()),
            }),
            undefined,
            1,
          ),
          label: s.string("what this edit was, for the undo menu"),
        },
        ["cells"],
      ),
      describe: (p) => p.label ?? describeCells(p.cells, "edit"),
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        checkBounds(data, p.cells);
        const before = snapshot(data, p.cells);
        for (const c of p.cells) data.setCell(c.row, c.col, c.input === null ? null : parseInput(c.input));
        return { type: "cells.restore", params: restoreParams(id, before, p.label) };
      },
    })
    .register<{ cells: RestoreCell[]; label?: string; sheet?: string }>({
      type: "cells.restore",
      title: "Put cells back exactly as they were",
      internal: true,
      schema: withSheet(
        {
          cells: s.array(
            s.object({ row: s.int(undefined, 0), col: s.int(undefined, 0), value: storedSchema, revert: s.bool() }, ["row", "col"]),
          ),
          label: s.string(),
        },
        ["cells"],
      ),
      describe: (p) => p.label ?? describeCells(p.cells, "restore"),
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const before = snapshot(data, p.cells);
        for (const c of p.cells) {
          if (c.revert) data.revertCell(c.row, c.col);
          else data.setCell(c.row, c.col, fromJson(c.value ?? null));
        }
        return { type: "cells.restore", params: restoreParams(id, before, p.label) };
      },
    })
    .register<{ range: Range; sheet?: string }>({
      type: "fill.down",
      title: "Copy the top row of a range into every row below it (Ctrl+D)",
      schema: withSheet({ range: rangeSchema }, ["range"]),
      describe: () => "fill down",
      recordable: true,
      apply(ctx, { range, sheet }) {
        const { id, data } = target(ctx, sheet);
        if (range.bottom <= range.top || range.right < range.left) return null;
        checkBounds(data, [{ row: range.bottom, col: range.right }]);
        if (data.rowOrder) {
          // sorted: rows adjacent in the view are scattered in the data, so a
          // fill can't be one block. Write the cells individually.
          const cells: { row: number; col: number; value: StoredJson }[] = [];
          for (let col = range.left; col <= range.right; col++) {
            const { template, origin } = data.getTemplate(range.top, col);
            for (let row = range.top + 1; row <= range.bottom; row++) {
              const value: Stored = isFormula(template)
                ? { ...template, shift: row - origin, text: template.ast ? formatFormula(template.ast, row - origin) : template.text }
                : template;
              cells.push({ row, col, value: toJson(value, row) });
            }
          }
          const before = snapshot(data, cells);
          for (const c of cells) data.setCell(c.row, c.col, fromJson(c.value));
          return { type: "cells.restore", params: restoreParams(id, before, "fill down") };
        }
        // unsorted: one Fill per column (O(1) storage, compiled when possible),
        // plus whatever explicit edits it covered so undo can put them back
        const fills: Fill[] = [];
        const covered: { row: number; col: number; value: Stored }[] = [];
        for (let col = range.left; col <= range.right; col++) {
          const { template, origin } = data.getTemplate(range.top, col);
          covered.push(...data.takeEdits(col, range.top + 1, range.bottom));
          fills.push(data.addFill(col, range.top + 1, range.bottom, template, origin));
        }
        return { type: "fill.remove", params: { sheet: id, fills: ctx.blobs.put(fills), covered: ctx.blobs.put(covered) } };
      },
    })
    .register<{ fills: string; covered: string; sheet?: string }>({
      type: "fill.remove",
      title: "Undo a fill down",
      internal: true,
      schema: withSheet({ fills: s.string(), covered: s.string() }, ["fills", "covered"]),
      describe: () => "fill down",
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        for (const f of ctx.blobs.get<Fill[]>(p.fills)) data.removeFill(f);
        for (const c of ctx.blobs.get<{ row: number; col: number; value: Stored }[]>(p.covered)) data.setCell(c.row, c.col, c.value);
        return { type: "fill.restore", params: { ...p, sheet: id } };
      },
    })
    .register<{ fills: string; covered: string; sheet?: string }>({
      type: "fill.restore",
      title: "Redo a fill down",
      internal: true,
      schema: withSheet({ fills: s.string(), covered: s.string() }, ["fills", "covered"]),
      describe: () => "fill down",
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        for (const c of ctx.blobs.get<{ row: number; col: number }[]>(p.covered)) data.revertCell(c.row, c.col);
        for (const f of ctx.blobs.get<Fill[]>(p.fills)) data.restoreFill(f);
        return { type: "fill.remove", params: { ...p, sheet: id } };
      },
    })
    .register<{ col: number; descending?: boolean; sheet?: string }>({
      type: "rows.sort",
      title: "Sort all rows by one column",
      schema: withSheet({ col: s.int("column to sort by, 0-based", 0), descending: s.bool("largest first") }, ["col"]),
      describe: (p) => `sort by column ${columnLetter(p.col)}${p.descending ? " (descending)" : ""}`,
      recordable: true,
      async apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        checkBounds(data, [{ row: 0, col: p.col }]);
        const before = data.rowOrder;
        const viewOrder = await ctx.sortRows(data, p.col, !!p.descending);
        if (!viewOrder) return null; // cancelled
        // the worker sorts view rows; map them through the order we started from
        data.setRowOrder(before ? viewOrder.map((v) => before[v]) : viewOrder);
        return { type: "rows.order", params: { sheet: id, order: before ? ctx.blobs.put(before) : null } };
      },
    })
    .register<{ order: string | null; sheet?: string }>({
      type: "rows.order",
      title: "Restore a previous row order",
      internal: true,
      schema: withSheet({ order: s.anyOf(s.string(), s.null()) }, ["order"]),
      describe: () => "sort",
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const current = data.rowOrder;
        data.setRowOrder(p.order ? ctx.blobs.get<Uint32Array>(p.order) : null);
        return { type: "rows.order", params: { sheet: id, order: current ? ctx.blobs.put(current) : null } };
      },
    });

  // -------------------------------------------------------- structure --

  registry
    .register<{ at: number; count?: number; sheet?: string }>({
      type: "rows.insert",
      title: "Insert empty rows; formulas everywhere adjust like Excel",
      schema: withSheet({ at: s.int("insert before this row, 0-based", 0), count: s.int("how many rows", 1, 1_000_000) }, ["at"]),
      describe: (p) => `insert ${(p.count ?? 1).toLocaleString()} row${(p.count ?? 1) > 1 ? "s" : ""}`,
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const count = p.count ?? 1;
        if (p.at > data.rowCount) throw new Error(`Row ${p.at + 1} is past the end of the sheet.`);
        if (!data.rowOrder && data.rowCount > MAX_RESTRUCTURE_ROWS) {
          throw new Error(`Inserting or deleting rows on sheets over ${MAX_RESTRUCTURE_ROWS.toLocaleString()} rows isn't supported yet.`);
        }

        const formulas = adjustEverywhere(ctx, id, { at: p.at, count, insert: true });
        data.insertRows(p.at, count);
        return { type: "rows.splice", params: { sheet: id, at: p.at, remove: count, insert: null, formulas: ctx.blobs.put(formulas) } };
      },
    })
    .register<{ at: number; count?: number; sheet?: string }>({
      type: "rows.delete",
      title: "Delete rows; references to them become #REF! like Excel",
      schema: withSheet({ at: s.int("first row to delete, 0-based", 0), count: s.int("how many rows", 1, 1_000_000) }, ["at"]),
      describe: (p) => `delete ${(p.count ?? 1).toLocaleString()} row${(p.count ?? 1) > 1 ? "s" : ""}`,
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const count = p.count ?? 1;
        if (p.at + count > data.rowCount) throw new Error("Those rows are past the end of the sheet.");
        if (count >= data.rowCount) throw new Error("A sheet needs at least one row.");
        if (!data.rowOrder && data.rowCount > MAX_RESTRUCTURE_ROWS) {
          throw new Error(`Inserting or deleting rows on sheets over ${MAX_RESTRUCTURE_ROWS.toLocaleString()} rows isn't supported yet.`);
        }

        const formulas = adjustEverywhere(ctx, id, { at: p.at, count, insert: false });
        const removed = data.deleteRows(p.at, count);
        return { type: "rows.splice", params: { sheet: id, at: p.at, remove: 0, insert: ctx.blobs.put(removed), formulas: ctx.blobs.put(formulas) } };
      },
    })
    .register<{ sheet: string; at: number; remove: number; insert: string | null; formulas: string }>({
      type: "rows.splice",
      title: "Undo or redo a row insert or delete",
      internal: true,
      schema: s.object({
        sheet: s.string(),
        at: s.int(undefined, 0),
        remove: s.int(undefined, 0),
        insert: s.anyOf(s.string(), s.null()),
        formulas: s.string(),
      }),
      describe: () => "insert or delete rows",
      apply(ctx, p) {
        const data = ctx.workbook.get(p.sheet).source;
        const before = snapshotFormulas(ctx);
        const removed = data.deleteRows(p.at, p.remove);
        const inserted = p.insert ? ctx.blobs.get<number[]>(p.insert) : [];
        if (inserted.length) data.restoreRows(p.at, inserted);
        restoreFormulas(ctx, ctx.blobs.get(p.formulas));
        return {
          type: "rows.splice",
          params: { sheet: p.sheet, at: p.at, remove: inserted.length, insert: removed.length ? ctx.blobs.put(removed) : null, formulas: ctx.blobs.put(before) },
        };
      },
    });

  // ----------------------------------------------------------- sheets --

  registry
    .register<{ name?: string; index?: number; rows?: number; cols?: number }>({
      type: "sheet.add",
      title: "Add a blank sheet",
      schema: s.object(
        {
          name: s.string("sheet name; defaults to the next free 'SheetN'"),
          index: s.int("position, 0-based; defaults to after the last sheet", 0),
          rows: s.int("rows", 1, 1_048_576),
          cols: s.int("columns", 1, 16_384),
        },
        [],
      ),
      describe: (p) => `add sheet${p.name ? ` "${p.name}"` : ""}`,
      recordable: true,
      apply(ctx, p) {
        const name = p.name ?? ctx.workbook.freeName();
        const sheet = ctx.workbook.add(name, new Source(new BlankSource(p.rows ?? 1000, p.cols ?? 26)), p.index);
        ctx.onSheetShown?.(sheet.id);
        return { type: "sheet.delete", params: { sheet: sheet.id } };
      },
    })
    .register<{ sheet: string }>({
      type: "sheet.delete",
      title: "Delete a sheet",
      schema: s.object({ sheet: s.string("sheet id") }),
      describe: () => "delete sheet",
      recordable: true,
      apply(ctx, p) {
        const { sheet, index } = ctx.workbook.remove(p.sheet);
        return { type: "sheet.restore", params: { blob: ctx.blobs.put(sheet), index } };
      },
    })
    .register<{ blob: string; index: number }>({
      type: "sheet.restore",
      title: "Put a deleted sheet back",
      internal: true,
      schema: s.object({ blob: s.string(), index: s.int(undefined, 0) }),
      describe: () => "delete sheet",
      apply(ctx, p) {
        const old = ctx.blobs.get<Sheet>(p.blob);
        const { id, name, source, ...extra } = old;
        ctx.workbook.add(name, source, p.index, id, extra);
        ctx.onSheetShown?.(id);
        return { type: "sheet.delete", params: { sheet: id } };
      },
    })
    .register<{ sheet: string; name?: string }>({
      type: "sheet.duplicate",
      title: "Copy a sheet, with all its data, next to it",
      schema: s.object({ sheet: s.string("sheet id"), name: s.string("name for the copy") }, ["sheet"]),
      describe: () => "duplicate sheet",
      recordable: true,
      apply(ctx, p) {
        const original = ctx.workbook.get(p.sheet);
        const name = p.name ?? ctx.workbook.freeName(`${original.name} (2)`);
        const copy = ctx.workbook.add(name, original.source.clone(), ctx.workbook.indexOf(p.sheet) + 1, undefined, {
          color: original.color,
        });
        ctx.onSheetShown?.(copy.id);
        return { type: "sheet.delete", params: { sheet: copy.id } };
      },
    })
    .register<{ sheet: string; name: string }>({
      type: "sheet.rename",
      title: "Rename a sheet",
      schema: s.object({ sheet: s.string("sheet id"), name: s.string("new name", { minLength: 1, maxLength: 31 }) }),
      describe: (p) => `rename sheet to "${p.name}"`,
      recordable: true,
      apply(ctx, p) {
        const old = ctx.workbook.rename(p.sheet, p.name);
        return old === p.name ? null : { type: "sheet.rename", params: { sheet: p.sheet, name: old } };
      },
    })
    .register<{ sheet: string; index: number }>({
      type: "sheet.move",
      title: "Move a sheet to another position",
      schema: s.object({ sheet: s.string("sheet id"), index: s.int("new position, 0-based", 0) }),
      describe: () => "move sheet",
      recordable: true,
      apply(ctx, p) {
        const from = ctx.workbook.move(p.sheet, p.index);
        return from === ctx.workbook.indexOf(p.sheet) ? null : { type: "sheet.move", params: { sheet: p.sheet, index: from } };
      },
    })
    .register<{ sheet: string; color: string | null }>({
      type: "sheet.color",
      title: "Set or clear a sheet tab's colour",
      schema: s.object({ sheet: s.string("sheet id"), color: s.anyOf(s.string("CSS colour"), s.null()) }),
      describe: () => "colour sheet tab",
      recordable: true,
      apply(ctx, p) {
        const sheet = ctx.workbook.get(p.sheet);
        const before = sheet.color ?? null;
        if (before === p.color) return null;
        sheet.color = p.color ?? undefined;
        return { type: "sheet.color", params: { sheet: p.sheet, color: before } };
      },
    })
    .register<{ sheet: string; hidden: boolean }>({
      type: "sheet.hide",
      title: "Hide or unhide a sheet",
      schema: s.object({ sheet: s.string("sheet id"), hidden: s.bool("true to hide, false to show") }),
      describe: (p) => (p.hidden ? "hide sheet" : "unhide sheet"),
      recordable: true,
      apply(ctx, p) {
        const was = ctx.workbook.setHidden(p.sheet, p.hidden);
        if (was === p.hidden) return null;
        if (!p.hidden) ctx.onSheetShown?.(p.sheet);
        return { type: "sheet.hide", params: { sheet: p.sheet, hidden: was } };
      },
    });

  return registry;
}

/** Convenience for building cells.set from a block of typed text. */
export function setCells(cells: { row: number; col: number; input: string | null }[], label?: string, sheet?: string): Action {
  const params: Record<string, unknown> = { cells };
  if (label) params.label = label;
  if (sheet) params.sheet = sheet;
  return { type: "cells.set", params };
}


// ------------------------------------------------------------ structure --

/**
 * Inserting or deleting rows builds a full row map for now; above this size
 * that's too much memory. A segment map (instant at any size) is planned.
 */
const MAX_RESTRUCTURE_ROWS = 20_000_000;

type Snapshots = Map<string, FormulaSnapshot>;

/** Every sheet's formulas, so a structural change can be undone exactly. */
function snapshotFormulas(ctx: SheetCtx): Snapshots {
  const out: Snapshots = new Map();
  for (const sheet of ctx.workbook.sheets) out.set(sheet.id, sheet.source.formulaSnapshot());
  return out;
}

function restoreFormulas(ctx: SheetCtx, snaps: Snapshots): void {
  for (const sheet of ctx.workbook.sheets) {
    const snap = snaps.get(sheet.id);
    if (snap) sheet.source.restoreFormulas(snap);
  }
}

/**
 * Rewrite formulas on every sheet for a row change on sheet `id`, before the
 * rows themselves move. Returns the snapshot to undo with; if any sheet
 * can't be adjusted, everything is put back and the error is rethrown.
 */
function adjustEverywhere(ctx: SheetCtx, id: string, change: RowChange): Snapshots {
  const snaps = snapshotFormulas(ctx);
  const name = ctx.workbook.get(id).name;
  try {
    for (const sheet of ctx.workbook.sheets) sheet.source.adjustForRows(change, sheet.id === id, name);
  } catch (e) {
    restoreFormulas(ctx, snaps);
    throw e;
  }
  return snaps;
}
