/**
 * The sheet's actions. Everything that changes data goes through here, so it
 * is undoable, can be recorded into a recipe, and can be called by the AI
 * with the same validation a user's edit gets.
 */
import { type Action, ActionRegistry, BlobStore, s } from "@cellforge/actions";
import { columnLetter } from "@cellforge/grid";
import { formatFormula, parseFormula, type Node } from "@cellforge/core";
import { type EditableSource, effectiveShift, type Fill, isFormula, parseInput, type Stored } from "./editable";

export interface SheetCtx {
  sheet: EditableSource;
  blobs: BlobStore;
  /** sorts in a worker; resolves to a view->base order, or null if cancelled */
  sortRows(sheet: EditableSource, col: number, descending: boolean): Promise<Uint32Array | null>;
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

export function sheetActions(): ActionRegistry<SheetCtx> {
  return new ActionRegistry<SheetCtx>()
    .register<{ cells: { row: number; col: number; input: string | null }[]; label?: string }>({
      type: "cells.set",
      title: "Write values or formulas into cells, exactly as a user would type them",
      schema: s.object(
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
      apply({ sheet }, p) {
        checkBounds(sheet, p.cells);
        const before = snapshot(sheet, p.cells);
        for (const c of p.cells) sheet.setCell(c.row, c.col, c.input === null ? null : parseInput(c.input));
        return { type: "cells.restore", params: p.label ? { cells: before, label: p.label } : { cells: before } };
      },
    })
    .register<{ cells: RestoreCell[]; label?: string }>({
      type: "cells.restore",
      title: "Put cells back exactly as they were",
      internal: true,
      schema: s.object(
        {
          cells: s.array(
            s.object({ row: s.int(undefined, 0), col: s.int(undefined, 0), value: storedSchema, revert: s.bool() }, ["row", "col"]),
          ),
          label: s.string(),
        },
        ["cells"],
      ),
      describe: (p) => p.label ?? describeCells(p.cells, "restore"),
      apply({ sheet }, p) {
        const before = snapshot(sheet, p.cells);
        for (const c of p.cells) {
          if (c.revert) sheet.revertCell(c.row, c.col);
          else sheet.setCell(c.row, c.col, fromJson(c.value ?? null));
        }
        return { type: "cells.restore", params: p.label ? { cells: before, label: p.label } : { cells: before } };
      },
    })
    .register<{ range: Range }>({
      type: "fill.down",
      title: "Copy the top row of a range into every row below it (Ctrl+D)",
      schema: s.object({ range: rangeSchema }),
      describe: () => "fill down",
      recordable: true,
      apply(ctx, { range }) {
        const { sheet } = ctx;
        if (range.bottom <= range.top || range.right < range.left) return null;
        checkBounds(sheet, [{ row: range.bottom, col: range.right }]);
        if (sheet.rowOrder) {
          // sorted: rows adjacent in the view are scattered in the data, so a
          // fill can't be one block. Write the cells individually.
          const cells: { row: number; col: number; value: StoredJson }[] = [];
          for (let col = range.left; col <= range.right; col++) {
            const { template, origin } = sheet.getTemplate(range.top, col);
            for (let row = range.top + 1; row <= range.bottom; row++) {
              const value: Stored = isFormula(template)
                ? { ...template, shift: row - origin, text: template.ast ? formatFormula(template.ast, row - origin) : template.text }
                : template;
              cells.push({ row, col, value: toJson(value, row) });
            }
          }
          const before = snapshot(sheet, cells);
          for (const c of cells) sheet.setCell(c.row, c.col, fromJson(c.value));
          return { type: "cells.restore", params: { cells: before, label: "fill down" } };
        }
        // unsorted: one Fill per column (O(1) storage, compiled when possible),
        // plus whatever explicit edits it covered so undo can put them back
        const fills: Fill[] = [];
        const covered: { row: number; col: number; value: Stored }[] = [];
        for (let col = range.left; col <= range.right; col++) {
          const { template, origin } = sheet.getTemplate(range.top, col);
          covered.push(...sheet.takeEdits(col, range.top + 1, range.bottom));
          fills.push(sheet.addFill(col, range.top + 1, range.bottom, template, origin));
        }
        return { type: "fill.remove", params: { fills: ctx.blobs.put(fills), covered: ctx.blobs.put(covered) } };
      },
    })
    .register<{ fills: string; covered: string }>({
      type: "fill.remove",
      title: "Undo a fill down",
      internal: true,
      schema: s.object({ fills: s.string(), covered: s.string() }),
      describe: () => "fill down",
      apply({ sheet, blobs }, p) {
        for (const f of blobs.get<Fill[]>(p.fills)) sheet.removeFill(f);
        for (const c of blobs.get<{ row: number; col: number; value: Stored }[]>(p.covered)) sheet.setCell(c.row, c.col, c.value);
        return { type: "fill.restore", params: p };
      },
    })
    .register<{ fills: string; covered: string }>({
      type: "fill.restore",
      title: "Redo a fill down",
      internal: true,
      schema: s.object({ fills: s.string(), covered: s.string() }),
      describe: () => "fill down",
      apply({ sheet, blobs }, p) {
        for (const c of blobs.get<{ row: number; col: number }[]>(p.covered)) sheet.revertCell(c.row, c.col);
        for (const f of blobs.get<Fill[]>(p.fills)) sheet.restoreFill(f);
        return { type: "fill.remove", params: p };
      },
    })
    .register<{ col: number; descending?: boolean }>({
      type: "rows.sort",
      title: "Sort all rows by one column",
      schema: s.object({ col: s.int("column to sort by, 0-based", 0), descending: s.bool("largest first") }, ["col"]),
      describe: (p) => `sort by column ${columnLetter(p.col)}${p.descending ? " (descending)" : ""}`,
      recordable: true,
      async apply(ctx, p) {
        const { sheet } = ctx;
        checkBounds(sheet, [{ row: 0, col: p.col }]);
        const before = sheet.rowOrder;
        const viewOrder = await ctx.sortRows(sheet, p.col, !!p.descending);
        if (!viewOrder) return null; // cancelled
        // the worker sorts view rows; map them through the order we started from
        sheet.setRowOrder(before ? viewOrder.map((v) => before[v]) : viewOrder);
        return { type: "rows.order", params: { order: before ? ctx.blobs.put(before) : null } };
      },
    })
    .register<{ order: string | null }>({
      type: "rows.order",
      title: "Restore a previous row order",
      internal: true,
      schema: s.object({ order: s.anyOf(s.string(), s.null()) }),
      describe: () => "sort",
      apply(ctx, p) {
        const current = ctx.sheet.rowOrder;
        ctx.sheet.setRowOrder(p.order ? ctx.blobs.get<Uint32Array>(p.order) : null);
        return { type: "rows.order", params: { order: current ? ctx.blobs.put(current) : null } };
      },
    });
}

/** Convenience for building cells.set from a block of typed text. */
export function setCells(cells: { row: number; col: number; input: string | null }[], label?: string): Action {
  return { type: "cells.set", params: label ? { cells, label } : { cells } };
}
