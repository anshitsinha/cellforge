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
import { columnLetter, expandToMerges, intersects } from "@cellforge/grid";
import { type ColChange, formatFormula, parseFormula, parseTyped, type Node, type RowChange } from "@cellforge/core";
import { type ColumnRemoval, type EditableSource, effectiveShift, type Fill, type FormulaSnapshot, isFormula, parseInput, type Stored } from "./editable";
import { BlankSource, EditableSource as Source } from "./editable";
import { CLEAR_ALL, type ColumnStyles, type StylePatch } from "./styles";
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

const color = s.string("CSS colour, e.g. #c00000");
const nullable = (x: JsonSchema) => s.anyOf(x, s.null());
const borderLine = s.object(
  { style: s.string("line style", { enum: ["thin", "medium", "thick", "dashed", "dotted", "double"] }), color: s.string("CSS colour, or auto for the theme text colour") },
  ["style", "color"],
);
const styleSchema = s.object(
  {
    bold: nullable(s.bool()),
    italic: nullable(s.bool()),
    underline: nullable(s.bool()),
    strike: nullable(s.bool()),
    size: nullable(s.int("font size in points", 6, 96)),
    font: nullable(s.string("font family")),
    color: nullable(color),
    fill: nullable(color),
    align: nullable(s.string("horizontal alignment; centerAcross centres over the empty cells to the right", { enum: ["left", "center", "right", "centerAcross"] })),
    valign: nullable(s.string("vertical alignment", { enum: ["top", "middle", "bottom"] })),
    wrap: nullable(s.bool()),
    numFmt: nullable(s.string('Excel number format code, e.g. "#,##0.00", "0.0%", "yyyy-mm-dd", \'$#,##0;[Red]($#,##0)\'', { maxLength: 255 })),
    borderTop: nullable(borderLine),
    borderRight: nullable(borderLine),
    borderBottom: nullable(borderLine),
    borderLeft: nullable(borderLine),
  },
  [],
  "properties to set; null clears one, missing ones are left alone",
);

/** Most rows a format can touch on a sorted sheet (where a range is scattered). */
const MAX_SCATTERED_FORMAT_ROWS = 5_000_000;

/**
 * Apply several (range, patch) pairs as one change. Returns the inverse,
 * which puts every touched column's formatting back exactly.
 */
function applyFormats(ctx: SheetCtx, id: string, data: EditableSource, items: { range: Range; patch: StylePatch }[]): Action | null {
  const live = items.filter(({ range: r, patch }) => r.bottom >= r.top && r.right >= r.left && Object.keys(patch).length);
  if (!live.length) return null;
  const before = new Map<number, ColumnStyles | undefined>();
  for (const { range: r } of live) {
    checkBounds(data, [{ row: r.bottom, col: r.right }]);
    const whole = r.top === 0 && r.bottom >= data.rowCount - 1;
    if (data.rowOrder && !whole && r.bottom - r.top + 1 > MAX_SCATTERED_FORMAT_ROWS) {
      throw new Error(
        "Formatting more than " + MAX_SCATTERED_FORMAT_ROWS.toLocaleString() + " rows of a sorted sheet is not supported yet; format whole columns instead.",
      );
    }
    for (let c = r.left; c <= r.right; c++) if (!before.has(c)) before.set(c, data.styles.snapshot(c));
  }
  for (const { range: r, patch } of live) {
    const rows = r.top === 0 && r.bottom >= data.rowCount - 1 ? "all" : data.rowIdIntervals(r.top, r.bottom);
    for (let c = r.left; c <= r.right; c++) data.styles.apply(c, rows, patch);
  }
  return { type: "format.restore", params: { sheet: id, cols: ctx.blobs.put([...before]) } };
}

type BorderWhich = "all" | "outline" | "inner" | "top" | "bottom" | "left" | "right" | "none";

function borderItems(r: Range, which: BorderWhich, line: StylePatch["borderTop"]): { range: Range; patch: StylePatch }[] {
  const row = (at: number): Range => ({ ...r, top: at, bottom: at });
  const col = (at: number): Range => ({ ...r, left: at, right: at });
  switch (which) {
    case "none":
      return [{ range: r, patch: { borderTop: null, borderRight: null, borderBottom: null, borderLeft: null } }];
    case "all":
      return [{ range: r, patch: { borderTop: line, borderRight: line, borderBottom: line, borderLeft: line } }];
    case "top":
      return [{ range: row(r.top), patch: { borderTop: line } }];
    case "bottom":
      return [{ range: row(r.bottom), patch: { borderBottom: line } }];
    case "left":
      return [{ range: col(r.left), patch: { borderLeft: line } }];
    case "right":
      return [{ range: col(r.right), patch: { borderRight: line } }];
    case "outline":
      return [
        ...borderItems(r, "top", line),
        ...borderItems(r, "bottom", line),
        ...borderItems(r, "left", line),
        ...borderItems(r, "right", line),
      ];
    case "inner": {
      const out: { range: Range; patch: StylePatch }[] = [];
      if (r.bottom > r.top) out.push({ range: { ...r, bottom: r.bottom - 1 }, patch: { borderBottom: line } });
      if (r.right > r.left) out.push({ range: { ...r, right: r.right - 1 }, patch: { borderRight: line } });
      return out;
    }
  }
}

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

const restoreParams = (sheet: string, cells: RestoreCell[], label?: string, formats?: string) => ({
  sheet,
  cells,
  ...(label ? { label } : {}),
  ...(formats ? { formats } : {}),
});

/** Swap columns' formatting with a saved copy; returns the blob to swap back. */
function swapFormats(ctx: SheetCtx, data: EditableSource, blob: string): string {
  const saved = ctx.blobs.get<[number, ColumnStyles | undefined][]>(blob);
  const now = saved.map(([c]) => [c, data.styles.snapshot(c)] as [number, ColumnStyles | undefined]);
  for (const [c, e] of saved) data.styles.restore(c, e && { base: e.base, runs: e.runs.clone() });
  return ctx.blobs.put(now);
}

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
        // "12%", "$1,200", "2024-01-15": store the number, and give the cell
        // a matching format unless it already has one (as Excel does)
        const formatted: { row: number; col: number; format: string }[] = [];
        for (const c of p.cells) {
          // a cell formatted as Text keeps exactly what was typed
          if (c.input !== null && data.getStyle(c.row, c.col)?.numFmt === "@") {
            data.setCell(c.row, c.col, c.input);
            continue;
          }
          const typed = c.input !== null && !c.input.trim().startsWith("=") ? parseTyped(c.input) : null;
          if (typed) {
            data.setCell(c.row, c.col, typed.value);
            if (!data.getStyle(c.row, c.col)?.numFmt) formatted.push({ row: c.row, col: c.col, format: typed.format });
          } else data.setCell(c.row, c.col, c.input === null ? null : parseInput(c.input));
        }
        let formats: string | undefined;
        if (formatted.length) {
          const cols = new Map<number, ColumnStyles | undefined>();
          for (const f of formatted) if (!cols.has(f.col)) cols.set(f.col, data.styles.snapshot(f.col));
          formats = ctx.blobs.put([...cols]);
          for (const f of formatted) data.styles.apply(f.col, data.rowIdIntervals(f.row, f.row), { numFmt: f.format });
        }
        return { type: "cells.restore", params: restoreParams(id, before, p.label, formats) };
      },
    })
    .register<{ cells: RestoreCell[]; label?: string; formats?: string; sheet?: string }>({
      type: "cells.restore",
      title: "Put cells back exactly as they were",
      internal: true,
      schema: withSheet(
        {
          cells: s.array(
            s.object({ row: s.int(undefined, 0), col: s.int(undefined, 0), value: storedSchema, revert: s.bool() }, ["row", "col"]),
          ),
          label: s.string(),
          formats: s.string("saved formatting to swap back"),
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
        const formats = p.formats ? swapFormats(ctx, data, p.formats) : undefined;
        return { type: "cells.restore", params: restoreParams(id, before, p.label, formats) };
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
        if (data.merges.length) throw new Error("Sorting needs merged cells to be unmerged first.");
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

  registry
    .register<{ at: number; count?: number; sheet?: string }>({
      type: "cols.insert",
      title: "Insert empty columns; formulas everywhere adjust like Excel",
      schema: withSheet({ at: s.int("insert before this column, 0-based (A = 0)", 0), count: s.int("how many columns", 1, 16_384) }, ["at"]),
      describe: (p) => `insert ${p.count ?? 1} column${(p.count ?? 1) > 1 ? "s" : ""}`,
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const count = p.count ?? 1;
        if (p.at > data.colCount) throw new Error(`Column ${columnLetter(p.at)} is past the end of the sheet.`);
        if (data.colCount + count > 16_384) throw new Error("A sheet can have at most 16,384 columns (XFD), like Excel.");
        const formulas = adjustColumnsEverywhere(ctx, id, { at: p.at, count, insert: true });
        data.insertColumns(p.at, count);
        return { type: "cols.splice", params: { sheet: id, at: p.at, remove: count, insert: null, formulas: ctx.blobs.put(formulas) } };
      },
    })
    .register<{ at: number; count?: number; sheet?: string }>({
      type: "cols.delete",
      title: "Delete columns; references to them become #REF! like Excel",
      schema: withSheet({ at: s.int("first column to delete, 0-based (A = 0)", 0), count: s.int("how many columns", 1, 16_384) }, ["at"]),
      describe: (p) => `delete ${p.count ?? 1} column${(p.count ?? 1) > 1 ? "s" : ""}`,
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const count = p.count ?? 1;
        if (p.at + count > data.colCount) throw new Error("Those columns are past the end of the sheet.");
        if (count >= data.colCount) throw new Error("A sheet needs at least one column.");
        const formulas = adjustColumnsEverywhere(ctx, id, { at: p.at, count, insert: false });
        const removed = data.deleteColumns(p.at, count);
        return { type: "cols.splice", params: { sheet: id, at: p.at, remove: 0, insert: ctx.blobs.put(removed), formulas: ctx.blobs.put(formulas) } };
      },
    })
    .register<{ sheet: string; at: number; remove: number; insert: string | null; formulas: string }>({
      type: "cols.splice",
      title: "Undo or redo a column insert or delete",
      internal: true,
      schema: s.object({
        sheet: s.string(),
        at: s.int(undefined, 0),
        remove: s.int(undefined, 0),
        insert: s.anyOf(s.string(), s.null()),
        formulas: s.string(),
      }),
      describe: () => "insert or delete columns",
      apply(ctx, p) {
        const data = ctx.workbook.get(p.sheet).source;
        const before = snapshotFormulas(ctx);
        const removed = p.remove ? data.deleteColumns(p.at, p.remove) : null;
        const restore = p.insert ? ctx.blobs.get<ColumnRemoval>(p.insert) : null;
        if (restore) data.restoreColumns(p.at, restore);
        restoreFormulas(ctx, ctx.blobs.get(p.formulas));
        return {
          type: "cols.splice",
          params: {
            sheet: p.sheet,
            at: p.at,
            remove: restore ? restore.map.length : 0,
            insert: removed ? ctx.blobs.put(removed) : null,
            formulas: ctx.blobs.put(before),
          },
        };
      },
    });

  registry
    .register<{ at: number; count?: number; hidden: boolean; sheet?: string }>({
      type: "rows.hide",
      title: "Hide or unhide rows (unhiding a range shows any hidden rows inside it)",
      schema: withSheet(
        { at: s.int("first row, 0-based", 0), count: s.int("how many rows", 1, 100_000_000), hidden: s.bool("true to hide, false to show") },
        ["at", "hidden"],
      ),
      describe: (p) => (p.hidden ? "hide rows" : "unhide rows"),
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const changed = data.setRowsHidden(p.at, p.count ?? 1, p.hidden);
        if (!changed.length) return null;
        return { type: "rows.hideIds", params: { sheet: id, ids: ctx.blobs.put(changed), hidden: !p.hidden } };
      },
    })
    .register<{ sheet: string; ids: string; hidden: boolean }>({
      type: "rows.hideIds",
      title: "Undo hiding rows",
      internal: true,
      schema: s.object({ sheet: s.string(), ids: s.string(), hidden: s.bool() }),
      describe: () => "hide rows",
      apply(ctx, p) {
        ctx.workbook.get(p.sheet).source.toggleRowIds(ctx.blobs.get<number[]>(p.ids), p.hidden);
        return { type: "rows.hideIds", params: { ...p, hidden: !p.hidden } };
      },
    })
    .register<{ at: number; count?: number; hidden: boolean; sheet?: string }>({
      type: "cols.hide",
      title: "Hide or unhide columns (unhiding a range shows any hidden columns inside it)",
      schema: withSheet(
        { at: s.int("first column, 0-based (A = 0)", 0), count: s.int("how many columns", 1, 16_384), hidden: s.bool("true to hide, false to show") },
        ["at", "hidden"],
      ),
      describe: (p) => (p.hidden ? "hide columns" : "unhide columns"),
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const cols = Array.from({ length: p.count ?? 1 }, (_, i) => p.at + i);
        const changed = data.setColsHidden(cols, p.hidden);
        if (!changed.length) return null;
        if (p.hidden && data.hiddenColumns.size >= data.colCount) {
          data.setColsHidden(changed, false);
          throw new Error("At least one column has to stay visible.");
        }
        return { type: "cols.hideList", params: { sheet: id, cols: changed, hidden: !p.hidden } };
      },
    })
    .register<{ sheet: string; cols: number[]; hidden: boolean }>({
      type: "cols.hideList",
      title: "Undo hiding columns",
      internal: true,
      schema: s.object({ sheet: s.string(), cols: s.array(s.int(undefined, 0)), hidden: s.bool() }),
      describe: () => "hide columns",
      apply(ctx, p) {
        ctx.workbook.get(p.sheet).source.setColsHidden(p.cols, p.hidden);
        return { type: "cols.hideList", params: { ...p, hidden: !p.hidden } };
      },
    });

  // ------------------------------------------------------------ merge --
  registry
    .register<{ range: Range; across?: boolean; center?: boolean; sheet?: string }>({
      type: "cells.merge",
      title: "Merge a range into one cell (across: one merge per row; center: centre the text). The first value is kept.",
      schema: withSheet(
        { range: rangeSchema, across: s.bool("merge each row separately"), center: s.bool("centre the text too") },
        ["range"],
      ),
      describe: (p) => (p.across ? "merge across" : p.center ? "merge and centre" : "merge cells"),
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        checkBounds(data, [{ row: p.range.bottom, col: p.range.right }]);
        // grow over merges it touches, then replace them
        const r = expandToMerges(p.range, data.merges);
        const blocks: Range[] = p.across
          ? Array.from({ length: r.bottom - r.top + 1 }, (_, i) => ({ ...r, top: r.top + i, bottom: r.top + i }))
          : [r];
        const real = blocks.filter((b) => b.bottom > b.top || b.right > b.left);
        if (!real.length) return null;
        if (real.some((b) => (b.bottom - b.top + 1) * (b.right - b.left + 1) > 100_000)) {
          throw new Error("Merged blocks are limited to 100,000 cells.");
        }
        const prevMerges = data.merges.map((m) => ({ ...m }));
        // keep the first value of each block in its top-left cell, clear the rest
        const writes: { row: number; col: number; value: Stored }[] = [];
        for (const b of real) {
          let first: Stored | undefined;
          let firstAt: { row: number; col: number } | null = null;
          for (let row = b.top; row <= b.bottom; row++) {
            for (let col = b.left; col <= b.right; col++) {
              if (data.getCell(row, col) === null) continue;
              if (!firstAt) {
                firstAt = { row, col };
                first = data.getStored(row, col) ?? parseInput(data.getEditText(row, col));
              }
              if (row !== b.top || col !== b.left) writes.push({ row, col, value: null });
            }
          }
          if (firstAt && (firstAt.row !== b.top || firstAt.col !== b.left)) writes.push({ row: b.top, col: b.left, value: first ?? null });
        }
        const before = snapshot(data, writes);
        for (const w of writes) data.setCell(w.row, w.col, w.value);
        data.merges = [...data.merges.filter((m) => !intersects(m, r)), ...real];
        let formats: string | undefined;
        if (p.center) {
          const undoFormat = applyFormats(ctx, id, data, [{ range: r, patch: { align: "center" } }]);
          formats = undoFormat ? (undoFormat.params as { cols: string }).cols : undefined;
        }
        return {
          type: "cells.mergeRestore",
          params: { sheet: id, merges: ctx.blobs.put(prevMerges), cells: before, ...(formats ? { formats } : {}) },
        };
      },
    })
    .register<{ range: Range; sheet?: string }>({
      type: "cells.unmerge",
      title: "Unmerge every merged block that touches a range",
      schema: withSheet({ range: rangeSchema }, ["range"]),
      describe: () => "unmerge cells",
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const keep = data.merges.filter((m) => !intersects(m, p.range));
        if (keep.length === data.merges.length) return null;
        const prev = data.merges.map((m) => ({ ...m }));
        data.merges = keep;
        return { type: "cells.mergeRestore", params: { sheet: id, merges: ctx.blobs.put(prev), cells: [] } };
      },
    })
    .register<{ sheet: string; merges: string; cells: RestoreCell[]; formats?: string }>({
      type: "cells.mergeRestore",
      title: "Put merged cells back as they were",
      internal: true,
      schema: s.object(
        {
          sheet: s.string(),
          merges: s.string(),
          cells: s.array(s.object({ row: s.int(undefined, 0), col: s.int(undefined, 0), value: storedSchema, revert: s.bool() }, ["row", "col"])),
          formats: s.string(),
        },
        ["sheet", "merges", "cells"],
      ),
      describe: () => "merge cells",
      apply(ctx, p) {
        const data = ctx.workbook.get(p.sheet).source;
        const now = data.merges.map((m) => ({ ...m }));
        const before = snapshot(data, p.cells);
        for (const c of p.cells) {
          if (c.revert) data.revertCell(c.row, c.col);
          else data.setCell(c.row, c.col, fromJson(c.value ?? null));
        }
        data.merges = ctx.blobs.get<Range[]>(p.merges).map((m) => ({ ...m }));
        const formats = p.formats ? swapFormats(ctx, data, p.formats) : undefined;
        return {
          type: "cells.mergeRestore",
          params: { sheet: p.sheet, merges: ctx.blobs.put(now), cells: before, ...(formats ? { formats } : {}) },
        };
      },
    });

  // ------------------------------------------------------------- view --
  registry
    .register<{ at: number; count?: number; height?: number | null; heights?: (number | null)[]; sheet?: string }>({
      type: "rows.height",
      title: "Set the height of rows in pixels (null for the default height)",
      schema: withSheet(
        {
          at: s.int("first row, 0-based", 0),
          count: s.int("how many rows", 1, 100_000_000),
          height: s.anyOf(s.int("height in px", 8, 409), s.null()),
          heights: s.array(s.anyOf(s.int(undefined, 8, 409), s.null()), "a height per row from at on, instead of one height"),
        },
        ["at"],
      ),
      describe: () => "row height",
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const changed = p.heights
          ? p.heights.flatMap((h, i) => data.setRowHeights(p.at + i, 1, h))
          : data.setRowHeights(p.at, p.count ?? 1, p.height ?? null);
        if (!changed.length) return null;
        return { type: "rows.heightIds", params: { sheet: id, entries: ctx.blobs.put(changed) } };
      },
    })
    .register<{ sheet: string; entries: string }>({
      type: "rows.heightIds",
      title: "Put row heights back",
      internal: true,
      schema: s.object({ sheet: s.string(), entries: s.string() }),
      describe: () => "row height",
      apply(ctx, p) {
        const data = ctx.workbook.get(p.sheet).source;
        const before = data.restoreRowHeights(ctx.blobs.get<[number, number | null][]>(p.entries));
        return { type: "rows.heightIds", params: { sheet: p.sheet, entries: ctx.blobs.put(before) } };
      },
    })
    .register<{ rows: number; cols: number; sheet?: string }>({
      type: "view.freeze",
      title: "Freeze panes: keep the top rows and left columns on screen while scrolling (0, 0 unfreezes)",
      schema: withSheet(
        { rows: s.int("rows to freeze from the top", 0, 1000), cols: s.int("columns to freeze from the left", 0, 100) },
        ["rows", "cols"],
      ),
      describe: (p) => (p.rows || p.cols ? "freeze panes" : "unfreeze panes"),
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const before = { ...data.frozen };
        if (before.rows === p.rows && before.cols === p.cols) return null;
        data.frozen = { rows: p.rows, cols: p.cols };
        return { type: "view.freeze", params: { ...before, sheet: id } };
      },
    });

  // ----------------------------------------------------------- format --
  registry
    .register<{ range: Range; style: StylePatch; sheet?: string }>({
      type: "format.set",
      title: "Format a range: bold, italic, underline, strikethrough, font, size, text colour, fill, alignment, wrap, borders",
      schema: withSheet({ range: rangeSchema, style: styleSchema }, ["range", "style"]),
      describe: (p) => "format " + Object.keys(p.style).join(", "),
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        return applyFormats(ctx, id, data, [{ range: p.range, patch: p.style }]);
      },
    })
    .register<{ range: Range; which: BorderWhich; line?: { style: string; color: string }; sheet?: string }>({
      type: "format.borders",
      title: "Draw or clear borders around, inside or on one side of a range",
      schema: withSheet(
        {
          range: rangeSchema,
          which: s.string("which borders", { enum: ["all", "outline", "inner", "top", "bottom", "left", "right", "none"] }),
          line: borderLine,
        },
        ["range", "which"],
      ),
      describe: (p) => (p.which === "none" ? "clear borders" : p.which + " borders"),
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const line = (p.line ?? { style: "thin", color: "auto" }) as StylePatch["borderTop"];
        return applyFormats(ctx, id, data, borderItems(p.range, p.which, line));
      },
    })
    .register<{ range: Range; sheet?: string }>({
      type: "format.clear",
      title: "Remove all formatting from a range (values stay)",
      schema: withSheet({ range: rangeSchema }, ["range"]),
      describe: () => "clear formatting",
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        return applyFormats(ctx, id, data, [{ range: p.range, patch: CLEAR_ALL }]);
      },
    })
    .register<{ sheet: string; cols: string }>({
      type: "format.restore",
      title: "Put columns' formatting back",
      internal: true,
      schema: s.object({ sheet: s.string(), cols: s.string() }),
      describe: () => "format",
      apply(ctx, p) {
        const data = ctx.workbook.get(p.sheet).source;
        return { type: "format.restore", params: { sheet: p.sheet, cols: swapFormats(ctx, data, p.cols) } };
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

/** Like adjustEverywhere, for a column change on sheet `id`. */
function adjustColumnsEverywhere(ctx: SheetCtx, id: string, change: ColChange): Snapshots {
  const snaps = snapshotFormulas(ctx);
  const name = ctx.workbook.get(id).name;
  for (const sheet of ctx.workbook.sheets) sheet.source.adjustForColumns(change, sheet.id === id, name);
  return snaps;
}
