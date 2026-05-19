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
import { type CellStyle, type CellValue, columnLetter, expandToMerges, intersects } from "@cellforge/grid";
import { squeeze, adjustForColChange, adjustForRowChange, type ColChange, formatFormula, isDateFormat, moveFormula, parseFormula, parseTyped, seriesOf, type Node, type RowChange, type SeriesValue } from "@cellforge/core";
import { type ColumnRemoval, type EditableSource, effectiveShift, type Fill, type FormulaSnapshot, isFormula, parseInput, type Stored } from "./editable";
import { BlankSource, EditableSource as Source } from "./editable";
import { CLEAR_ALL, type ColumnStyles, type StylePatch } from "./styles";
import { captureVersion, versionSheets, type Version } from "./versions";
import { describeCondition, type FilterCondition, type FilterSpec, type FilterView } from "./filter";
import { buildClean, buildDropped, namedHeader, planCleanup, sheetText } from "./cleanup";
import { type IdRuns, type RowMap, runsLength } from "./rowmap";
import { nameProblem, type NameDef, type Sheet, type Workbook } from "./workbook";

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
export type StoredJson = null | number | string | boolean | { formula: string; shift?: number };

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
  s.bool(),
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

function safeParse(text: string): Node | null {
  try {
    return parseFormula(text);
  } catch {
    return null;
  }
}

function removeVersion(ctx: SheetCtx, name: string): Action {
  const list = ctx.workbook.versions;
  const index = list.findIndex((v) => v.name.toLowerCase() === name.toLowerCase());
  if (index < 0) throw new Error(`No version called "${name}".`);
  const [v] = list.splice(index, 1);
  return { type: "version.put", params: { version: ctx.blobs.put(v), index } };
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

/**
 * Sort by several keys, most important first: a stable sort per key, least
 * important first. With a header, row 0 stays on top. False if cancelled
 * (the order is left as it was).
 */
async function sortByKeys(ctx: SheetCtx, data: EditableSource, keys: { col: number; descending?: boolean }[], hasHeader: boolean): Promise<boolean> {
  for (const k of keys) checkBounds(data, [{ row: 0, col: k.col }]);
  if (data.merges.length) throw new Error("Sorting needs merged cells to be unmerged first.");
  const start = data.rowOrder;
  for (const k of [...keys].reverse()) {
    const before = data.rowOrder;
    let viewOrder = await ctx.sortRows(data, k.col, !!k.descending);
    if (!viewOrder) {
      data.setRowOrder(start);
      return false;
    }
    if (hasHeader) {
      const rest = viewOrder.filter((v) => v !== 0);
      viewOrder = new Uint32Array(viewOrder.length);
      viewOrder[0] = 0;
      viewOrder.set(rest, 1);
    }
    data.setRowOrder(before ? before.compose(viewOrder) : viewOrder);
  }
  data.lastSort = keys.map((k) => ({ col: k.col, descending: !!k.descending }));
  return true;
}

/** Most cells one fill can write one by one (a formula filled down uses fill.down instead). */
const MAX_FILL_CELLS = 2_000_000;

type FillDir = "down" | "up" | "right" | "left";

function fillDirection(src: Range, to: Range): FillDir {
  const sameCols = to.left === src.left && to.right === src.right;
  const sameRows = to.top === src.top && to.bottom === src.bottom;
  if (sameCols && to.top === src.top && to.bottom > src.bottom) return "down";
  if (sameCols && to.bottom === src.bottom && to.top < src.top) return "up";
  if (sameRows && to.left === src.left && to.right > src.right) return "right";
  if (sameRows && to.right === src.right && to.left < src.left) return "left";
  throw new Error("The fill range has to extend the source range in one direction.");
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
          const typed = c.input !== null && !c.input.trim().startsWith("=") && !c.input.startsWith("'") ? parseTyped(c.input) : null;
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
        // typing in the row just under a table makes the table one row longer,
        let tables: string | undefined;
        for (const t of data.tables) {
          if (p.cells.some((c) => c.row === t.bottom + 1 && c.col >= t.left && c.col <= t.right && c.input !== null && c.input !== "")) {
            tables ??= ctx.blobs.put(data.tables.map((x) => ({ ...x })));
            t.bottom++;
          }
        }
        // and a header typed just right of it adds a column (as in Excel)
        for (const t of data.tables) {
          if (p.cells.some((c) => c.row === t.top && c.col === t.right + 1 && c.input !== null && c.input.trim() !== "")) {
            tables ??= ctx.blobs.put(data.tables.map((x) => ({ ...x })));
            t.right++;
          }
        }
        if (tables) data.clearCaches();
        return { type: "cells.restore", params: { ...restoreParams(id, before, p.label, formats), ...(tables ? { tables } : {}) } };
      },
    })
    .register<{ cells: RestoreCell[]; label?: string; formats?: string; tables?: string; sheet?: string }>({
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
          tables: s.string("saved tables to swap back"),
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
        let tables: string | undefined;
        if (p.tables) {
          tables = ctx.blobs.put(data.tables.map((x) => ({ ...x })));
          data.tables = ctx.blobs.get<typeof data.tables>(p.tables).map((x) => ({ ...x }));
          data.clearCaches();
        }
        return { type: "cells.restore", params: { ...restoreParams(id, before, p.label, formats), ...(tables ? { tables } : {}) } };
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
        data.setRowOrder(before ? before.compose(viewOrder) : viewOrder);
        data.lastSort = [{ col: p.col, descending: !!p.descending }];
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
        data.setRowOrder(p.order ? ctx.blobs.get<RowMap | Uint32Array>(p.order) : null);
        return { type: "rows.order", params: { sheet: id, order: current ? ctx.blobs.put(current) : null } };
      },
    });

  // ------------------------------------------------------------ filter --
  const cond = s.anyOf(
    s.object({ kind: s.string(undefined, { enum: ["values"] }), keys: s.array(s.string(), "values to keep, as keys: 'n:12.5' for a number, 's:north' for text (lower case), '' for blanks") }),
    s.object({ kind: s.string(undefined, { enum: ["text"] }), op: s.string(undefined, { enum: ["contains", "notContains", "begins", "ends", "equals", "notEquals"] }), value: s.string() }),
    s.object(
      {
        kind: s.string(undefined, { enum: ["number"] }),
        op: s.string(undefined, { enum: [">", ">=", "<", "<=", "=", "!=", "between", "top", "bottom", "aboveAverage", "belowAverage"] }),
        a: s.number("the number (or N for top / bottom)"),
        b: s.number("upper end for between"),
      },
      ["kind", "op"],
    ),
    s.object({ kind: s.string(undefined, { enum: ["date"] }), op: s.string(undefined, { enum: ["before", "after", "on", "between"] }), a: s.number("date as a serial number"), b: s.number() }, ["kind", "op", "a"]),
    s.object({ kind: s.string(undefined, { enum: ["blanks"] }), blank: s.bool("true: only blanks; false: only non-blank") }),
  );
  const filterUndo = (id: string, data: EditableSource, ctx: SheetCtx) => ({
    type: "filter.restore",
    params: { sheet: id, filter: data.filter ? ctx.blobs.put(structuredClone(data.filter)) : null, ids: ctx.blobs.put(data.filteredRowIds) },
  });
  registry
    .register<{ col: number; condition: FilterCondition | null; headerRow?: number; sheet?: string }>({
      type: "filter.set",
      title: "Filter rows by a column: keep only rows whose value matches (null removes this column's filter). Other columns' filters stay.",
      schema: withSheet(
        {
          col: s.int("column, 0-based", 0),
          condition: s.anyOf(cond, s.null()),
          headerRow: s.int("header row, 0-based; -1 when the sheet's column names are the header (default: as before, else the column names or row 0)", -1),
        },
        ["col", "condition"],
      ),
      describe: (p) => (p.condition ? `filter ${columnLetter(p.col)}: ${describeCondition(p.condition)}` : `clear filter on ${columnLetter(p.col)}`),
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const undo = filterUndo(id, data, ctx);
        const headerRow = p.headerRow ?? data.filter?.headerRow ?? (data.getColumnName(0) !== undefined ? -1 : 0);
        const conditions = (data.filter?.conditions ?? []).filter((c) => c.col !== p.col);
        if (p.condition) conditions.push({ col: p.col, cond: p.condition });
        data.setFilter({ headerRow, conditions });
        return undo;
      },
    })
    .register<{ sheet?: string }>({
      type: "filter.clear",
      title: "Remove the filter: show every row it hid",
      schema: withSheet({}, []),
      describe: () => "clear filter",
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        if (!data.filter) return null;
        const undo = filterUndo(id, data, ctx);
        data.setFilter(null);
        return undo;
      },
    })
    .register<{ sheet?: string }>({
      type: "filter.reapply",
      title: "Apply the filter again after the data changed",
      schema: withSheet({}, []),
      describe: () => "reapply filter",
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        if (!data.filter) return null;
        const undo = filterUndo(id, data, ctx);
        data.reapplyFilter();
        return undo;
      },
    })
    .register<{ filter: string | null; ids: string; sheet?: string }>({
      type: "filter.restore",
      title: "Put a filter back as it was",
      internal: true,
      schema: withSheet({ filter: s.anyOf(s.string(), s.null()), ids: s.string() }, ["filter", "ids"]),
      describe: () => "filter",
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const undo = filterUndo(id, data, ctx);
        data.restoreFilter(p.filter ? ctx.blobs.get<FilterSpec>(p.filter) : null, ctx.blobs.get<number[]>(p.ids));
        return undo;
      },
    })
    .register<{ name: string; sheet?: string }>({
      type: "filter.saveView",
      title: "Save the current filter and sort as a named view (replaces a view with that name)",
      schema: withSheet({ name: s.string("view name", { minLength: 1, maxLength: 60 }) }, ["name"]),
      describe: (p) => `save view "${p.name}"`,
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const before = structuredClone(data.filterViews);
        const view: FilterView = { name: p.name, filter: data.filter ? structuredClone(data.filter) : null, sort: data.lastSort ? [...data.lastSort] : [] };
        const i = data.filterViews.findIndex((v) => v.name.toLowerCase() === p.name.toLowerCase());
        if (i >= 0) data.filterViews[i] = view;
        else data.filterViews.push(view);
        return { type: "filter.views", params: { sheet: id, views: ctx.blobs.put(before) } };
      },
    })
    .register<{ name: string; sheet?: string }>({
      type: "filter.deleteView",
      title: "Delete a saved filter view",
      schema: withSheet({ name: s.string("view name") }, ["name"]),
      describe: (p) => `delete view "${p.name}"`,
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const before = structuredClone(data.filterViews);
        data.filterViews = data.filterViews.filter((v) => v.name.toLowerCase() !== p.name.toLowerCase());
        if (data.filterViews.length === before.length) throw new Error(`No view called "${p.name}".`);
        return { type: "filter.views", params: { sheet: id, views: ctx.blobs.put(before) } };
      },
    })
    .register<{ views: string; sheet?: string }>({
      type: "filter.views",
      title: "Put the saved views back",
      internal: true,
      schema: withSheet({ views: s.string() }, ["views"]),
      describe: () => "views",
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const before = structuredClone(data.filterViews);
        data.filterViews = ctx.blobs.get<FilterView[]>(p.views);
        return { type: "filter.views", params: { sheet: id, views: ctx.blobs.put(before) } };
      },
    })
    .register<{ keys: { col: number; descending?: boolean }[]; hasHeader?: boolean; sheet?: string }>({
      type: "rows.sortBy",
      title: "Sort rows by several columns (first key first), keeping a header row in place if there is one",
      schema: withSheet(
        {
          keys: s.array(s.object({ col: s.int("column, 0-based", 0), descending: s.bool("largest / latest / Z first") }, ["col"]), "sort keys, most important first", 1, 16),
          hasHeader: s.bool("the first row is a header and stays at the top"),
        },
        ["keys"],
      ),
      describe: (p) => `sort by ${p.keys.map((k) => columnLetter(k.col) + (k.descending ? " ↓" : "")).join(", ")}`,
      recordable: true,
      async apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const start = data.rowOrder;
        if (!(await sortByKeys(ctx, data, p.keys, !!p.hasHeader))) return null;
        return { type: "rows.order", params: { sheet: id, order: start ? ctx.blobs.put(start) : null } };
      },
    })
    .register<{ name: string; sheet?: string }>({
      type: "filter.applyView",
      title: "Switch to a saved filter view: its filter and its sort",
      schema: withSheet({ name: s.string("view name") }, ["name"]),
      describe: (p) => `view "${p.name}"`,
      recordable: true,
      async apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const view = data.filterViews.find((v) => v.name.toLowerCase() === p.name.toLowerCase());
        if (!view) throw new Error(`No view called "${p.name}".`);
        const undo = {
          type: "filter.state",
          params: {
            sheet: id,
            order: data.rowOrder ? ctx.blobs.put(data.rowOrder) : null,
            filter: data.filter ? ctx.blobs.put(structuredClone(data.filter)) : null,
            ids: ctx.blobs.put(data.filteredRowIds),
          },
        };
        if (view.sort.length && !(await sortByKeys(ctx, data, view.sort, (view.filter?.headerRow ?? -1) === 0))) return null;
        data.setFilter(view.filter);
        return undo;
      },
    })
    .register<{ order: string | null; filter: string | null; ids: string; sheet?: string }>({
      type: "filter.state",
      title: "Put the row order and filter back",
      internal: true,
      schema: withSheet({ order: s.anyOf(s.string(), s.null()), filter: s.anyOf(s.string(), s.null()), ids: s.string() }, ["order", "filter", "ids"]),
      describe: () => "view",
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const undo = {
          type: "filter.state",
          params: {
            sheet: id,
            order: data.rowOrder ? ctx.blobs.put(data.rowOrder) : null,
            filter: data.filter ? ctx.blobs.put(structuredClone(data.filter)) : null,
            ids: ctx.blobs.put(data.filteredRowIds),
          },
        };
        data.setRowOrder(p.order ? ctx.blobs.get<RowMap | Uint32Array>(p.order) : null);
        data.restoreFilter(p.filter ? ctx.blobs.get<FilterSpec>(p.filter) : null, ctx.blobs.get<number[]>(p.ids));
        return undo;
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
        if (data.rowOrder?.isArray && data.rowCount > MAX_RESTRUCTURE_ROWS) {
          throw new Error(`Inserting or deleting rows in a sorted sheet over ${MAX_RESTRUCTURE_ROWS.toLocaleString()} rows isn't supported yet; undo the sort first.`);
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
        if (data.rowOrder?.isArray && data.rowCount > MAX_RESTRUCTURE_ROWS) {
          throw new Error(`Inserting or deleting rows in a sorted sheet over ${MAX_RESTRUCTURE_ROWS.toLocaleString()} rows isn't supported yet; undo the sort first.`);
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
        const inserted = p.insert ? ctx.blobs.get<IdRuns>(p.insert) : [];
        if (inserted.length) data.restoreRows(p.at, inserted);
        restoreFormulas(ctx, ctx.blobs.get(p.formulas));
        return {
          type: "rows.splice",
          params: { sheet: p.sheet, at: p.at, remove: runsLength(inserted), insert: removed.length ? ctx.blobs.put(removed) : null, formulas: ctx.blobs.put(before) },
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

  // ------------------------------------------------------------- fill --
  registry.register<{ source: Range; target: Range; sheet?: string }>({
    type: "fill.series",
    title:
      "Fill from a source range into a bigger target range, like dragging the fill handle: numbers and dates continue their trend, day/month names and numbered text count on, formulas move, other values repeat; formats are copied",
    schema: withSheet({ source: rangeSchema, target: rangeSchema }, ["source", "target"]),
    describe: (p) => `fill ${fillDirection(p.source, p.target)}`,
    recordable: true,
    apply(ctx, p) {
      const { id, data } = target(ctx, p.sheet);
      const { source: src, target: to } = p;
      checkBounds(data, [{ row: to.bottom, col: to.right }]);
      const dir = fillDirection(src, to);
      const vertical = dir === "down" || dir === "up";
      const cells = (to.bottom - to.top + 1) * (to.right - to.left + 1) - (src.bottom - src.top + 1) * (src.right - src.left + 1);
      if (cells > MAX_FILL_CELLS) throw new Error(`That fills ${cells.toLocaleString()} cells; the limit for now is ${MAX_FILL_CELLS.toLocaleString()}.`);

      const writes: { row: number; col: number; value: Stored }[] = [];
      const styled: { row: number; col: number; from: { row: number; col: number } }[] = [];
      // one line per column (vertical fill) or row (horizontal fill)
      const lines = vertical ? src.right - src.left + 1 : src.bottom - src.top + 1;
      const n = vertical ? src.bottom - src.top + 1 : src.right - src.left + 1;
      for (let l = 0; l < lines; l++) {
        const at = (k: number) => (vertical ? { row: src.top + k, col: src.left + l } : { row: src.top + l, col: src.left + k });
        const srcCells = Array.from({ length: n }, (_, k) => at(k));
        const texts = srcCells.map(({ row, col }) => data.getEditText(row, col));
        const formulas = texts.map((t) => (t.startsWith("=") ? safeParse(t) : null));
        const anyFormula = formulas.some((f) => f !== null);
        const values: SeriesValue[] = srcCells.map(({ row, col }) => {
          const v = data.getCell(row, col);
          return typeof v === "number" || typeof v === "string" ? v : null;
        });
        const dates = srcCells.every(({ row, col }, k) => values[k] === null || isDateFormat(data.getStyle(row, col)?.numFmt)) && values.some((v) => typeof v === "number");
        const f = anyFormula ? null : seriesOf(values, { dates });
        const first = vertical ? (dir === "down" ? src.bottom + 1 : to.top) : dir === "right" ? src.right + 1 : to.left;
        const last = vertical ? (dir === "down" ? to.bottom : src.top - 1) : dir === "right" ? to.right : src.left - 1;
        for (let pos = first; pos <= last; pos++) {
          const i = pos - (vertical ? src.top : src.left); // index in the series
          const k = ((i % n) + n) % n;
          const cell = vertical ? { row: pos, col: src.left + l } : { row: src.top + l, col: pos };
          let value: Stored;
          if (f) value = f(i);
          else {
            const ast = formulas[k];
            if (ast) {
              const shift = i - k;
              value = parseInput(formatFormula(moveFormula(ast, vertical ? shift : 0, vertical ? 0 : shift)));
            } else value = values[k];
          }
          writes.push({ ...cell, value });
          styled.push({ ...cell, from: at(k) });
        }
      }
      const before = snapshot(data, writes);
      // formats: the target takes the source's, cell for cell
      const cols = new Map<number, ColumnStyles | undefined>();
      for (let c = to.left; c <= to.right; c++) cols.set(c, data.styles.snapshot(c));
      for (const w of writes) data.setCell(w.row, w.col, w.value);
      const fillArea: Range = vertical
        ? { top: dir === "down" ? src.bottom + 1 : to.top, bottom: dir === "down" ? to.bottom : src.top - 1, left: to.left, right: to.right }
        : { top: to.top, bottom: to.bottom, left: dir === "right" ? src.right + 1 : to.left, right: dir === "right" ? to.right : src.left - 1 };
      const sourceStyled = styled.some((s) => data.getStyle(s.from.row, s.from.col));
      const targetStyled = !data.styles.isEmpty;
      if (sourceStyled || targetStyled) {
        for (let c = fillArea.left; c <= fillArea.right; c++) data.styles.apply(c, data.rowIdIntervals(fillArea.top, fillArea.bottom), CLEAR_ALL);
        if (sourceStyled) {
          if (styled.length > 200_000) throw new Error("Filling formats over more than 200,000 cells isn't supported yet.");
          for (const s of styled) {
            const st = data.getStyle(s.from.row, s.from.col);
            if (st) data.styles.apply(s.col, data.rowIdIntervals(s.row, s.row), st as StylePatch);
          }
        }
      }
      return { type: "cells.restore", params: restoreParams(id, before, undefined, ctx.blobs.put([...cols])) };
    },
  });

  registry.register<{ from: Range; fromSheet?: string; to: { row: number; col: number }; mode?: "all" | "values" | "formulas" | "formats"; sheet?: string }>({
    type: "cells.paste",
    title:
      "Paste a copied range from this workbook at a cell: all (formulas moved, values and formats), values (results only), formulas, or formats",
    schema: withSheet(
      {
        from: rangeSchema,
        fromSheet: s.string("sheet id the range was copied from; defaults to the target sheet"),
        to: s.object({ row: s.int("row, 0-based", 0), col: s.int("column, 0-based", 0) }),
        mode: s.string("what to paste", { enum: ["all", "values", "formulas", "formats"] }),
      },
      ["from", "to"],
    ),
    describe: (p) => (p.mode && p.mode !== "all" ? `paste ${p.mode}` : "paste"),
    recordable: true,
    apply(ctx, p) {
      const { id, data } = target(ctx, p.sheet);
      const src = ctx.workbook.get(p.fromSheet ?? id).source;
      const mode = p.mode ?? "all";
      const { from, to } = p;
      const rows = Math.min(from.bottom - from.top + 1, data.rowCount - to.row);
      const cols = Math.min(from.right - from.left + 1, data.colCount - to.col);
      if (rows <= 0 || cols <= 0) return null;
      if (rows * cols > MAX_FILL_CELLS) throw new Error(`Pasting more than ${MAX_FILL_CELLS.toLocaleString()} cells isn't supported yet.`);
      const dr = to.row - from.top;
      const dc = to.col - from.left;
      // read everything first: the source and target may overlap
      const cells: { row: number; col: number; value?: Stored; style: CellStyle | null }[] = [];
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          const r = from.top + i;
          const c = from.left + j;
          const style = src.getStyle(r, c);
          let value: Stored | undefined;
          if (mode !== "formats") {
            const text = src.getEditText(r, c);
            const ast = text.startsWith("=") ? safeParse(text) : null;
            if (ast && mode !== "values") value = parseInput(formatFormula(moveFormula(ast, dr, dc)));
            else value = src.getCell(r, c);
          }
          cells.push({ row: to.row + i, col: to.col + j, value, style });
        }
      }
      const writes = cells.filter((c) => c.value !== undefined) as { row: number; col: number; value: Stored }[];
      const before = snapshot(data, writes);
      let formats: string | undefined;
      if (mode === "all" || mode === "formats") {
        const saved = new Map<number, ColumnStyles | undefined>();
        for (let c = to.col; c < to.col + cols; c++) saved.set(c, data.styles.snapshot(c));
        formats = ctx.blobs.put([...saved]);
      }
      for (const w of writes) data.setCell(w.row, w.col, w.value);
      if (formats) {
        for (let c = to.col; c < to.col + cols; c++) data.styles.apply(c, data.rowIdIntervals(to.row, to.row + rows - 1), CLEAR_ALL);
        for (const c of cells) if (c.style) data.styles.apply(c.col, data.rowIdIntervals(c.row, c.row), c.style as StylePatch);
      }
      return { type: "cells.restore", params: restoreParams(id, before, undefined, formats) };
    },
  });

  // ---------------------------------------------------- report clean-up --
  registry
    .register<{ sheet?: string; unwrap?: boolean }>({
      type: "data.cleanup",
      title:
        "Make a clean copy of a messy export: find the header row, drop titles, totals, footers and repeated headers, fill down group labels, and turn text numbers and dates into real ones. Adds a sheet with the clean data and one listing the dropped rows.",
      schema: withSheet({ unwrap: s.bool("un-wrap a printed report (default true)") }, []),
      describe: () => "clean up",
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const original = ctx.workbook.get(id);
        const { plan, rows } = planCleanup(sheetText(data), p.unwrap ?? true, namedHeader(data) ? 1 : 0);
        if (!plan.dataRows) throw new Error("No data rows found to clean.");
        const at = ctx.workbook.indexOf(id) + 1;
        const added: string[] = [];
        const clean = ctx.workbook.add(ctx.workbook.freeName(`${original.name} clean`.slice(0, 31)), buildClean(plan, rows).source, at);
        added.push(clean.id);
        if (plan.dropped.length) {
          const dropped = ctx.workbook.add(ctx.workbook.freeName(`${original.name} dropped`.slice(0, 31)), buildDropped(plan), at + 1);
          added.push(dropped.id);
        }
        ctx.onSheetShown?.(clean.id);
        return { type: "sheets.remove", params: { ids: added } };
      },
    })
    .register<{ ids: string[] }>({
      type: "sheets.remove",
      title: "Take sheets out (undo of adding them)",
      internal: true,
      schema: s.object({ ids: s.array(s.string()) }),
      describe: () => "sheets",
      apply(ctx, p) {
        // last sheet first, so each recorded index is right when they go back in ascending order
        const order = [...p.ids].sort((a, b) => ctx.workbook.indexOf(b) - ctx.workbook.indexOf(a));
        const removed = order.map((sid) => ctx.workbook.remove(sid));
        return { type: "sheets.put", params: { sheets: ctx.blobs.put(removed) } };
      },
    })
    .register<{ sheets: string }>({
      type: "sheets.put",
      title: "Put sheets back",
      internal: true,
      schema: s.object({ sheets: s.string() }),
      describe: () => "sheets",
      apply(ctx, p) {
        const list = ctx.blobs.get<{ sheet: Sheet; index: number }[]>(p.sheets).slice().reverse();
        for (const { sheet, index } of list) ctx.workbook.add(sheet.name, sheet.source, index, sheet.id, { color: sheet.color, hidden: sheet.hidden });
        return { type: "sheets.remove", params: { ids: list.map((x) => x.sheet.id) } };
      },
    });

  registry.register<{ name: string; source: string; numFmts?: string[] }>({
    type: "sheet.insert",
    title: "Add a sheet holding data that was read in (combined files)",
    internal: true,
    schema: s.object({ name: s.string(), source: s.string(), numFmts: s.array(s.string()) }, ["name", "source"]),
    describe: (p) => `add "${p.name}"`,
    apply(ctx, p) {
      const source = ctx.blobs.get<EditableSource>(p.source).clone();
      (p.numFmts ?? []).forEach((numFmt, col) => {
        if (numFmt) source.styles.apply(col, "all", { numFmt });
      });
      const sheet = ctx.workbook.add(ctx.workbook.freeName(p.name.slice(0, 31)), source);
      ctx.onSheetShown?.(sheet.id);
      return { type: "sheet.delete", params: { sheet: sheet.id } };
    },
  });

  // ------------------------------------------------------------ clean --
  const cleanAction = (type: string, title: string, verb: string, change: (v: CellValue | boolean) => Stored | undefined) =>
    registry.register<{ range: Range; sheet?: string }>({
      type,
      title,
      schema: withSheet({ range: rangeSchema }, ["range"]),
      describe: () => verb,
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const r = p.range;
        const bottom = Math.min(r.bottom, data.rowCount - 1);
        const right = Math.min(r.right, data.colCount - 1);
        if ((bottom - r.top + 1) * (right - r.left + 1) > MAX_FILL_CELLS) throw new Error("That's too many cells to clean at once.");
        const writes: { row: number; col: number; value: Stored }[] = [];
        for (let row = r.top; row <= bottom; row++) {
          for (let col = r.left; col <= right; col++) {
            if (data.getEditText(row, col).startsWith("=")) continue; // leave formulas alone
            const v = data.getCell(row, col);
            if (v === null) continue;
            const next = change(v);
            if (next !== undefined && next !== v) writes.push({ row, col, value: next });
          }
        }
        if (!writes.length) return null;
        const before = snapshot(data, writes);
        for (const w of writes) data.setCell(w.row, w.col, w.value);
        return { type: "cells.restore", params: restoreParams(id, before, verb) };
      },
    });
  cleanAction("cells.trim", "Remove extra spaces from text (both ends, doubled spaces, non-breaking spaces from exports)", "trim spaces", (v) =>
    typeof v === "string" ? squeeze(v) : undefined,
  );
  cleanAction("cells.toNumber", "Turn numbers stored as text into real numbers (\"1,200\", \" 42 \", \"(15)\")", "convert to numbers", (v) => {
    if (typeof v !== "string") return undefined;
    const t = squeeze(v);
    const paren = /^\((.*)\)$/.exec(t);
    const body = (paren ? paren[1] : t).replace(/,/g, "");
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(body)) return undefined;
    return paren ? -Number(body) : Number(body);
  });

  // ----------------------------------------------------------- tables --
  registry
    .register<{ range: Range; name?: string; sheet?: string }>({
      type: "tables.create",
      title: "Make a range with a header row into a table: a name, banded rows, structured references like Sales[Amount], and it grows when you type below it",
      schema: withSheet({ range: rangeSchema, name: s.string("the table's name; Table1, Table2... if left out") }, ["range"]),
      describe: (p) => `make table ${p.name ?? ""}`.trim(),
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const r = p.range;
        checkBounds(data, [{ row: r.bottom, col: r.right }]);
        if (r.bottom <= r.top) throw new Error("A table needs a header row and at least one row of data.");
        const overlap = (a: Range, b: Range) => a.top <= b.bottom && b.top <= a.bottom && a.left <= b.right && b.left <= a.right;
        if (data.tables.some((t) => overlap(t, r))) throw new Error("That overlaps another table.");
        if (data.merges.some((m) => overlap(m, r))) throw new Error("Unmerge the cells first; tables can't contain merged cells.");
        const headers = Array.from({ length: r.right - r.left + 1 }, (_, i) => String(data.getCell(r.top, r.left + i) ?? "").trim());
        if (headers.some((h) => !h)) throw new Error("Every column needs a header in the first row.");
        if (new Set(headers.map((h) => h.toLowerCase())).size !== headers.length) throw new Error("Each column header has to be different.");
        let name = p.name?.trim();
        if (!name) for (let n = 1; ; n++) if (!ctx.workbook.findTable(`Table${n}`) && !ctx.workbook.getName(`Table${n}`)) { name = `Table${n}`; break; }
        const problem = nameProblem(name!);
        if (problem) throw new Error(problem);
        if (ctx.workbook.findTable(name!) || ctx.workbook.getName(name!)) throw new Error(`The name ${name} is already used.`);
        const before = data.tables.map((t) => ({ ...t }));
        data.tables = [...data.tables, { name: name!, top: r.top, left: r.left, bottom: r.bottom, right: r.right }];
        data.clearCaches();
        return { type: "tables.restore", params: { sheet: id, tables: before } };
      },
    })
    .register<{ name: string }>({
      type: "tables.delete",
      title: "Turn a table back into a plain range (the data stays; references to it show #REF!)",
      schema: s.object({ name: s.string() }),
      describe: (p) => `remove table ${p.name}`,
      recordable: true,
      apply(ctx, p) {
        const found = ctx.workbook.findTable(p.name);
        if (!found) throw new Error(`There's no table called ${p.name}.`);
        const sheet = ctx.workbook.sheets.find((x) => x.source === found.source)!;
        const before = found.source.tables.map((t) => ({ ...t }));
        found.source.tables = found.source.tables.filter((t) => t !== found.table);
        ctx.workbook.sheets.forEach((x) => x.source.clearCaches());
        return { type: "tables.restore", params: { sheet: sheet.id, tables: before } };
      },
    })
    .register<{ sheet: string; tables: (Range & { name: string })[] }>({
      type: "tables.restore",
      title: "Put a sheet's tables back",
      internal: true,
      schema: s.object({
        sheet: s.string(),
        tables: s.array(s.object({ name: s.string(), top: s.int(), left: s.int(), bottom: s.int(), right: s.int() })),
      }),
      describe: () => "table",
      apply(ctx, p) {
        const data = ctx.workbook.get(p.sheet).source;
        const before = data.tables.map((t) => ({ ...t }));
        data.tables = p.tables.map((t) => ({ ...t }));
        ctx.workbook.sheets.forEach((x) => x.source.clearCaches());
        return { type: "tables.restore", params: { sheet: p.sheet, tables: before } };
      },
    });

  // ------------------------------------------------------------- calc --
  registry.register<{ enabled: boolean; maxIterations?: number; maxChange?: number }>({
    type: "calc.iterative",
    title: "Turn iterative calculation on or off: circular references repeat until they settle instead of showing #CYCLE!",
    schema: s.object(
      {
        enabled: s.bool(),
        maxIterations: s.int("most passes (100 by default)", 1, 32_767),
        maxChange: s.number("stop when nothing moves more than this (0.001 by default)"),
      },
      ["enabled"],
    ),
    describe: (p) => (p.enabled ? "iterative calculation on" : "iterative calculation off"),
    recordable: true,
    apply(ctx, p) {
      const before = ctx.workbook.iterative;
      ctx.workbook.iterative = p.enabled ? { max: p.maxIterations ?? 100, change: p.maxChange ?? 0.001 } : null;
      return {
        type: "calc.iterative",
        params: before ? { enabled: true, maxIterations: before.max, maxChange: before.change } : { enabled: false },
      };
    },
  });

  // ------------------------------------------------------------ names --
  registry
    .register<{ name: string; refersTo: string; comment?: string }>({
      type: "names.define",
      title: "Give a range or a constant a name to use in formulas (=SUM(Revenue)); replaces a name that already exists",
      schema: s.object(
        {
          name: s.string("e.g. Revenue or VatRate"),
          refersTo: s.string("what it means, e.g. 'Sales'!$C$2:$C$500 or 0.2"),
          comment: s.string("a note about it"),
        },
        ["name", "refersTo"],
      ),
      describe: (p) => `name ${p.name}`,
      recordable: true,
      apply(ctx, p) {
        const before = ctx.workbook.definedNames;
        ctx.workbook.setName({ name: p.name, formula: p.refersTo, ...(p.comment ? { comment: p.comment } : {}) });
        return { type: "names.restore", params: { names: before } };
      },
    })
    .register<{ name: string }>({
      type: "names.delete",
      title: "Delete a defined name (formulas using it show #NAME?)",
      schema: s.object({ name: s.string() }),
      describe: (p) => `delete name ${p.name}`,
      recordable: true,
      apply(ctx, p) {
        if (!ctx.workbook.getName(p.name)) throw new Error(`There's no name called ${p.name}.`);
        const before = ctx.workbook.definedNames;
        ctx.workbook.deleteName(p.name);
        return { type: "names.restore", params: { names: before } };
      },
    })
    .register<{ names: NameDef[] }>({
      type: "names.restore",
      title: "Put the defined names back",
      internal: true,
      schema: s.object({ names: s.array(s.object({ name: s.string(), formula: s.string(), comment: s.string() }, ["name", "formula"])) }),
      describe: () => "names",
      apply(ctx, p) {
        const before = ctx.workbook.definedNames;
        ctx.workbook.restoreNames(p.names);
        return { type: "names.restore", params: { names: before } };
      },
    });

  // --------------------------------------------------------- versions --
  registry
    .register<{ name: string }>({
      type: "version.save",
      title: "Name the workbook as it is now (a version you can compare with or go back to later)",
      schema: s.object({ name: s.string("a name, e.g. 'sent to auditor'", { minLength: 1, maxLength: 80 }) }),
      describe: (p) => `save version "${p.name}"`,
      recordable: true,
      apply(ctx, p) {
        const name = p.name.trim();
        if (ctx.workbook.versions.some((v) => v.name.toLowerCase() === name.toLowerCase())) {
          throw new Error(`There's already a version called "${name}".`);
        }
        ctx.workbook.versions.push(captureVersion(ctx.workbook, name));
        return { type: "version.remove", params: { name } };
      },
    })
    .register<{ name: string }>({
      type: "version.delete",
      title: "Delete a named version (the workbook itself doesn't change)",
      schema: s.object({ name: s.string("the version's name") }),
      describe: (p) => `delete version "${p.name}"`,
      recordable: true,
      apply(ctx, p) {
        return removeVersion(ctx, p.name);
      },
    })
    .register<{ name: string }>({
      type: "version.remove",
      title: "Undo saving a version",
      internal: true,
      schema: s.object({ name: s.string() }),
      describe: (p) => `save version "${p.name}"`,
      apply(ctx, p) {
        return removeVersion(ctx, p.name);
      },
    })
    .register<{ version: string; index: number }>({
      type: "version.put",
      title: "Put a version back",
      internal: true,
      schema: s.object({ version: s.string(), index: s.int(undefined, 0) }),
      describe: () => "version",
      apply(ctx, p) {
        const v = ctx.blobs.get<Version>(p.version);
        ctx.workbook.versions.splice(Math.min(p.index, ctx.workbook.versions.length), 0, v);
        return { type: "version.remove", params: { name: v.name } };
      },
    })
    .register<{ name: string }>({
      type: "version.restore",
      title: "Go back to a named version: every sheet becomes what it was then (undoable)",
      schema: s.object({ name: s.string("the version's name") }),
      describe: (p) => `go back to "${p.name}"`,
      recordable: true,
      apply(ctx, p) {
        const v = ctx.workbook.versions.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
        if (!v) throw new Error(`No version called "${p.name}".`);
        const now = captureVersion(ctx.workbook, "before going back");
        ctx.workbook.replaceSheets(versionSheets(v));
        return { type: "version.swap", params: { version: ctx.blobs.put(now) } };
      },
    })
    .register<{ version: string }>({
      type: "version.swap",
      title: "Undo going back to a version",
      internal: true,
      schema: s.object({ version: s.string() }),
      describe: () => "go back to a version",
      apply(ctx, p) {
        const now = captureVersion(ctx.workbook, "before");
        ctx.workbook.replaceSheets(versionSheets(ctx.blobs.get<Version>(p.version)));
        return { type: "version.swap", params: { version: ctx.blobs.put(now) } };
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
    .register<{ at: number; count?: number; width: number | null; sheet?: string }>({
      type: "cols.width",
      title: "Set the width of columns in pixels (null for the default width)",
      schema: withSheet(
        {
          at: s.int("first column, 0-based (A = 0)", 0),
          count: s.int("how many columns", 1, 16_384),
          width: s.anyOf(s.int("width in px", 10, 2000), s.null()),
        },
        ["at", "width"],
      ),
      describe: () => "column width",
      recordable: true,
      apply(ctx, p) {
        const { id, data } = target(ctx, p.sheet);
        const cols = Array.from({ length: p.count ?? 1 }, (_, i) => p.at + i);
        const changed = data.setColWidths(cols, p.width);
        if (!changed.length) return null;
        return { type: "cols.widthList", params: { sheet: id, entries: changed } };
      },
    })
    .register<{ sheet: string; entries: [number, number | null][] }>({
      type: "cols.widthList",
      title: "Put column widths back",
      internal: true,
      schema: s.object({ sheet: s.string(), entries: s.array(s.array(s.anyOf(s.int(), s.null()))) }),
      describe: () => "column width",
      apply(ctx, p) {
        const data = ctx.workbook.get(p.sheet).source;
        return { type: "cols.widthList", params: { sheet: p.sheet, entries: data.restoreColWidths(p.entries) } };
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

type Snapshots = { sheets: Map<string, FormulaSnapshot>; names: NameDef[] };

/** Every sheet's formulas and the defined names, so a structural change can be undone exactly. */
function snapshotFormulas(ctx: SheetCtx): Snapshots {
  const sheets = new Map<string, FormulaSnapshot>();
  for (const sheet of ctx.workbook.sheets) sheets.set(sheet.id, sheet.source.formulaSnapshot());
  return { sheets, names: ctx.workbook.definedNames };
}

function restoreFormulas(ctx: SheetCtx, snaps: Snapshots): void {
  for (const sheet of ctx.workbook.sheets) {
    const snap = snaps.sheets.get(sheet.id);
    if (snap) sheet.source.restoreFormulas(snap);
  }
  ctx.workbook.restoreNames(snaps.names);
}

/** Names on the changed sheet follow inserted and deleted rows/columns too. */
function adjustNames(ctx: SheetCtx, sheetName: string, f: (ast: Node, applies: (s: string | undefined) => boolean) => Node): void {
  const lower = sheetName.toLowerCase();
  ctx.workbook.mapNames((ast) => f(ast, (s) => s !== undefined && s.toLowerCase() === lower));
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
    adjustNames(ctx, name, (ast, applies) => adjustForRowChange(ast, change, 0, 0, applies));
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
  adjustNames(ctx, name, (ast, applies) => adjustForColChange(ast, change, applies));
  return snaps;
}
