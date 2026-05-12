import "./style.css";
import { type CellRange, Grid, columnLetter } from "@cellforge/grid";
import { parseTsv, rangeSize, rangeToTsv } from "./clipboard";
import { computeStats } from "./stats";
import { SyntheticSource } from "./demo";
import { type Action, ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource, isFormula, type Fill } from "./editable";
import { download, exportCsv } from "./exporter";
import { SheetTabs } from "./tabs";
import { NUMBER_FORMATS, setupFormatBar } from "./formatbar";
import { attachFormulaAssist } from "./formulaassist";
import { setupNamesUi } from "./namesui";
import { setupInspectPanel } from "./inspectpanel";
import { openXlsx, saveXlsx } from "./xlsxio";
import { type Command, setupPalette } from "./palette";
import { setupHistoryPanel, type TrailEntry } from "./historypanel";
import { AutoSaver, fromFile, OpfsStore, packWorkbook, toFile, unpackWorkbook, type JournalEntry } from "./persist";
import { sheetNameProblem, Workbook } from "./workbook";
import { extractKeys, sortInWorker } from "./sort";
import { formatBytes, importCsv } from "./importer";

const DEMO_ROWS = 100_000_000;

const sheet = document.getElementById("sheet")!;
const statusLeft = document.getElementById("status-left")!;
const statusRight = document.getElementById("status-right")!;
const fileName = document.getElementById("file-name")!;
const cellRef = document.getElementById("cell-ref")!;
const formulaInput = document.getElementById("formula-input") as HTMLInputElement;

const rowFormat = new Intl.NumberFormat();

// /app.html?demo=1 (the landing page's "try the demo" link) opens the 100M
// row dataset; otherwise start with an empty sheet like any spreadsheet app
const startWithDemo = new URLSearchParams(location.search).has("demo");

// imported/demo data gets a few empty columns after it, for calculated columns
const SPARE_COLUMNS = 10;

/** A file name made into a valid sheet name ("sales/2026.csv" → "sales_2026"). */
function sheetNameFrom(file: string): string {
  const name = file
    .replace(/.(csv|tsv|txt)$/i, "")
    .replace(/[\/?*[]:]/g, "_")
    .replace(/^'+|'+$/g, "")
    .slice(0, 31)
    .trim();
  return name && !sheetNameProblem(name) ? name : "Sheet1";
}

let workbook = startWithDemo
  ? new Workbook({ name: "Demo", source: new EditableSource(new SyntheticSource(DEMO_ROWS), SPARE_COLUMNS) })
  : new Workbook();
let activeId = workbook.sheets[0].id;
/** the sheet on screen */
let source = workbook.sheets[0].source;
let currentName = startWithDemo ? "demo — synthetic sales" : "Untitled";
// each sheet keeps its own selection when you switch away and back
const selections = new Map<string, CellRange>();
// Fingers need bigger targets than a mouse, and iOS zooms the page when an
// input with <16px text gets focus.
const coarsePointer = matchMedia("(pointer: coarse)").matches;
const grid = new Grid(
  sheet,
  source,
  coarsePointer ? { rowHeight: 32, headerHeight: 30, defaultColumnWidth: 120, editorFontSize: 16 } : {},
);

function updateStatus() {
  const edits = source.editCount ? ` · ${source.editCount} edited` : "";
  statusLeft.textContent = `${rowFormat.format(source.rowCount)} rows × ${source.colCount} columns${edits}`;
}

function syncFormulaBar() {
  const { row, col } = grid.selection;
  cellRef.textContent = `${columnLetter(col)}${row + 1}`;
  formulaInput.value = source.getEditText(row, col);
}

// --- status bar (right side) ----------------------------------------------------
// Shows selection stats when more than one cell is selected, otherwise
// whatever info message was set last (import time, WebGPU support...).

let infoText = "gpu" in navigator ? "WebGPU available" : "WebGPU not available (CPU fallback)";
let statsToken = 0;
const numFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

function setInfo(text: string) {
  infoText = text;
  updateSelectionStats();
}

async function updateSelectionStats() {
  const token = ++statsToken;
  const range = grid.range;
  if (rangeSize(range) <= 1) {
    statusRight.textContent = infoText;
    return;
  }
  const stats = await computeStats(
    source,
    range,
    () => token !== statsToken,
    (f) => (statusRight.textContent = `Calculating… ${Math.round(f * 100)}%`),
  );
  if (!stats || token !== statsToken) return;
  const parts = [];
  if (stats.numbers) {
    parts.push(`Sum ${numFormat.format(stats.sum)}`);
    parts.push(`Average ${numFormat.format(stats.sum / stats.numbers)}`);
  }
  parts.push(`Count ${rowFormat.format(stats.count)}`);
  statusRight.textContent = parts.join(" · ");
}

// keep the name box, formula bar and stats in sync with the selection
grid.onSelectionChange = () => {
  showHint();
  syncFormulaBar();
  updateSelectionStats();
  formatBar.sync();
  historyPanel.render();
  inspectPanel.render();
};

// a lookup that found nothing for a fixable reason explains itself here
const hintBox = document.createElement("span");
hintBox.className = "status-hint";
statusLeft.after(hintBox);
function showHint() {
  const { row, col } = grid.selection;
  const hint = source.hintAt(row, col);
  hintBox.replaceChildren();
  if (!hint) return;
  const msg = document.createElement("span");
  msg.textContent = hint.message;
  hintBox.append(msg);
  const fix = hint.fix;
  if (fix) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = fix.label;
    b.addEventListener("click", () => {
      const sheet = fix.sheet ? workbook.byName(fix.sheet)?.id : activeId;
      if (!sheet) return;
      void run({ type: fix.kind === "trim" ? "cells.trim" : "cells.toNumber", params: { range: fix.range, sheet } }).then(() => {
        showHint();
        grid.focus();
      });
    });
    hintBox.append(b);
  }
}

// drag a row border (or double-click it to fit): resize that row, or every
// selected row when the drag is on one of several selected whole rows
grid.onRowResize = (row, height) => {
  const r = grid.range;
  const wholeRows = r.left === 0 && r.right === source.colCount - 1;
  const inside = wholeRows && row >= r.top && row <= r.bottom;
  void run({ type: "rows.height", params: { at: inside ? r.top : row, count: inside ? r.bottom - r.top + 1 : 1, height } });
};

// the fill handle: drag to continue a series, double-click to fill down
// alongside the neighbouring data
async function fillRange(sourceRange: CellRange, target: CellRange) {
  const down = target.top === sourceRange.top && target.bottom > sourceRange.bottom;
  const oneRow = sourceRange.top === sourceRange.bottom;
  let allFormulas = oneRow;
  for (let c = sourceRange.left; allFormulas && c <= sourceRange.right; c++) {
    allFormulas = source.getEditText(sourceRange.top, c).startsWith("=");
  }
  // a formula row filled down a long way: one fill block, instant at any size
  const action: Action =
    down && allFormulas && target.bottom - target.top > 10_000
      ? { type: "fill.down", params: { range: target } }
      : { type: "fill.series", params: { source: sourceRange, target } };
  if (await run(action)) grid.selectRange(target);
}

grid.onFill = (s, t) => void fillRange(s, t);
grid.onFillDoubleClick = (r) => {
  // fill down as far as the column beside the selection has data (Excel's rule)
  const side = r.left > 0 && source.getCell(r.bottom + 1, r.left - 1) !== null ? r.left - 1 : r.right + 1 < source.colCount ? r.right + 1 : -1;
  if (side < 0) return;
  const limit = Math.min(source.rowCount - 1, r.bottom + 5_000_000);
  let end = r.bottom;
  while (end < limit && source.getCell(end + 1, side) !== null) end++;
  if (end > r.bottom) void fillRange(r, { ...r, bottom: end });
};

// same for column borders: every selected whole column when dragging one of them
grid.onColumnResize = (col, width) => {
  const r = grid.range;
  const wholeCols = r.top === 0 && r.bottom === source.rowCount - 1;
  const inside = wholeCols && col >= r.left && col <= r.right;
  void run({ type: "cols.width", params: { at: inside ? r.left : col, count: inside ? r.right - r.left + 1 : 1, width } });
};

// function suggestions and argument hints in the formula bar and the cell editor
attachFormulaAssist(formulaInput);
attachFormulaAssist(grid.editorInput);

const formatBar = setupFormatBar({
  root: document.getElementById("format-bar")!,
  grid,
  source: () => source,
  run: (a) => run(a),
  status: (m) => (statusLeft.textContent = m),
  gridHasFocus: () => gridHasFocus(),
  sheetElement: sheet,
});

// --- edits + undo/redo -------------------------------------------------------------

// Every change goes through an action (see actions.ts): validated, undoable,
// and recordable into recipes later. Sorting runs in a worker, so actions
// can be async; the history applies them one at a time.

const undoButton = document.getElementById("btn-undo") as HTMLButtonElement;
const redoButton = document.getElementById("btn-redo") as HTMLButtonElement;

const registry = sheetActions();
const blobs = new BlobStore();
let cancelSort: (() => void) | null = null;

/** Sort keys are read on the main thread in slices; the radix sort runs in a worker. */
async function sortRows(target: EditableSource, col: number, descending: boolean): Promise<Uint32Array | null> {
  cancelSort?.();
  const name = target.getColumnName(col) ?? columnLetter(col);
  let cancelled = false;
  cancelSort = () => (cancelled = true);
  statusLeft.textContent = `Sorting by ${name}: reading values…`;
  const { keys, kinds } = await extractKeys(target, col, descending, (f) => {
    statusLeft.textContent = `Sorting by ${name}: reading values… ${Math.round(f * 100)}%`;
  });
  if (cancelled) return null;
  const job = sortInWorker({ keys, kinds, descending }, (f) => {
    statusLeft.textContent = `Sorting by ${name}… ${Math.round(f * 100)}%`;
  });
  cancelSort = job.cancel;
  try {
    return (await job.result).order;
  } catch {
    return null; // cancelled
  } finally {
    cancelSort = null;
  }
}

// a sheet that an action just added or restored is shown once it finishes
let pendingShow: string | null = null;
const ctx = (): SheetCtx => ({
  workbook,
  activeSheet: activeId,
  blobs,
  sortRows,
  onSheetShown: (id) => (pendingShow = id),
});
const history = new ActionHistory(registry, ctx);

/** Run a user action; problems are reported in the status bar, not thrown. */
async function run(action: Action) {
  try {
    const applied = await history.run(action);
    if (applied) {
      journal({ op: "run", action });
      recordTrail(action);
    }
    refresh();
    return applied;
  } catch (e) {
    statusLeft.textContent = (e as Error).message;
    return null;
  }
}

/** Show another sheet. Switching is view state, so it isn't undoable (as in Excel). */
function showSheet(id: string) {
  if (id === activeId) return;
  selections.set(activeId, grid.range);
  const sheet = workbook.get(id);
  activeId = id;
  source = sheet.source;
  attachKernelReporting(source);
  grid.setSource(source);
  const saved = selections.get(id);
  grid.selectRange(saved ?? { top: 0, left: 0, bottom: 0, right: 0 });
  tabs.render();
  refresh();
}

/** Keep the view on a sheet that exists and is visible after any action. */
function settleActiveSheet() {
  if (pendingShow && workbook.has(pendingShow)) {
    const id = pendingShow;
    pendingShow = null;
    showSheet(id);
    return;
  }
  pendingShow = null;
  if (!workbook.has(activeId) || workbook.get(activeId).hidden) {
    const next = workbook.visible[Math.min(workbook.visible.length - 1, 0)] ?? workbook.sheets[0];
    showSheet(next.id);
  }
  // the sheet on screen was replaced (going back to a version): show the new one
  const current = workbook.get(activeId).source;
  if (current !== source) {
    source = current;
    attachKernelReporting(source);
    grid.setSource(source);
  }
}

/** Repaint and update everything that shows cell contents. */
function refresh() {
  settleActiveSheet();
  showHint();
  tabs.render();
  grid.syncShape();
  grid.setHiddenRows(source.hiddenRowIntervals());
  grid.setHiddenColumns(source.hiddenColumns);
  grid.setColumnWidths(source.columnWidths, `${activeId}:${source.columnWidthsVersion}:${source.colCount}`);
  grid.setRowHeights(source.rowHeightsByView());
  grid.setFrozen(source.frozen.rows, source.frozen.cols);
  grid.setMerges(source.getMerges());
  grid.invalidate();
  syncFormulaBar();
  formatBar.sync();
  historyPanel.render();
  inspectPanel.render();
  updateStatus();
  updateSelectionStats();
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
}

type CellInput = { row: number; col: number; input: string | null };

/** Write several cells (as typed text, or null to empty) as one undoable step. */
function writeCells(cells: CellInput[], label: string) {
  if (cells.length === 0) return;
  void run(setCells(cells, label));
}

async function undo() {
  try {
    const label = await history.undo();
    if (label) journal({ op: "undo" });
    refresh();
    if (label) statusLeft.textContent = `Undid ${label}`;
  } catch (e) {
    statusLeft.textContent = `Couldn't undo: ${(e as Error).message}`;
  }
}

async function redo() {
  try {
    const label = await history.redo();
    if (label) journal({ op: "redo" });
    refresh();
    if (label) statusLeft.textContent = `Redid ${label}`;
  } catch (e) {
    statusLeft.textContent = `Couldn't redo: ${(e as Error).message}`;
  }
}

undoButton.addEventListener("click", () => {
  void undo();
  grid.focus();
});
redoButton.addEventListener("click", () => {
  void redo();
  grid.focus();
});

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  // leave text inputs alone so ctrl+z inside the formula bar undoes typing
  if (document.activeElement instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) {
    e.preventDefault();
    void undo();
  } else if (k === "y" || (k === "z" && e.shiftKey)) {
    e.preventDefault();
    void redo();
  }
});

// --- sorting ---------------------------------------------------------------------
// Peak memory is ~17 bytes/row (8 key + 1 kind + 2x4 index), so the 100M demo
// needs ~1.7GB free.

async function sortBy(descending: boolean) {
  const { col } = grid.selection;
  const name = source.getColumnName(col) ?? columnLetter(col);
  const started = performance.now();
  const applied = await run({ type: "rows.sort", params: { col, descending } });
  if (!applied) return; // cancelled by a newer sort, or failed
  statusLeft.textContent = `Sorted ${rowFormat.format(source.rowCount)} rows by ${name} in ${(
    (performance.now() - started) / 1000
  ).toFixed(2)}s`;
}

document.getElementById("btn-sort-asc")!.addEventListener("click", () => {
  sortBy(false);
  grid.focus();
});
document.getElementById("btn-sort-desc")!.addEventListener("click", () => {
  sortBy(true);
  grid.focus();
});

// --- fill down (Ctrl+D) -------------------------------------------------------------
// Copies the top row of the selection into every row below it. On an
// unsorted sheet each column becomes a single Fill object - O(1) storage no
// matter how many rows - whose formula gets compiled to a typed-array kernel.

async function fillDown() {
  const range = grid.range;
  if (range.bottom === range.top) {
    statusLeft.textContent = "Select the cell to copy and the cells below it, then fill down (Ctrl+D).";
    return;
  }
  const rows = range.bottom - range.top;
  // sorted sheets fill cell by cell (rows adjacent in the view are scattered
  // in the data), which goes through the sparse edit map
  if (source.rowOrder && rows * (range.right - range.left + 1) > MAX_BULK_CELLS) {
    statusLeft.textContent = `Fill down on a sorted sheet is limited to ${rowFormat.format(MAX_BULK_CELLS)} cells.`;
    return;
  }
  const target = source;
  const applied = await run({ type: "fill.down", params: { range } });
  if (!applied) return;

  // unsorted fills are one compiled-or-interpreted Fill per column: say which
  let how = "";
  const inverse = applied.inverse;
  if (inverse?.type === "fill.remove") {
    const fills = blobs.get<Fill[]>((inverse.params as { fills: string }).fills);
    const compiled = fills.filter((f) => target.isCompiled(f)).length;
    const formulaFills = fills.filter((f) => isFormula(f.template)).length;
    how =
      formulaFills === 0 ? "" : compiled === formulaFills ? " · compiled" : compiled === 0 ? " · interpreted" : ` · ${compiled}/${formulaFills} columns compiled`;
  }
  statusLeft.textContent = `Filled ${rowFormat.format(rows)} rows${how}`;
}

document.getElementById("btn-fill")!.addEventListener("click", () => {
  void fillDown();
  grid.focus();
});

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "d") return;
  if (document.activeElement instanceof HTMLInputElement) return;
  e.preventDefault(); // otherwise the browser opens "bookmark this page"
  void fillDown();
});

function attachKernelReporting(s: EditableSource) {
  // Kernels run per 64K-row chunk as rows are needed, so report throughput
  // over the last second rather than one message per chunk.
  let rows = 0;
  let ms = 0;
  let timer = 0;
  s.onKernelRun = (run) => {
    rows += run.rows;
    ms += run.ms;
    const name = s.getColumnName(run.col) ?? columnLetter(run.col);
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const perSec = ms > 0 ? (rows / ms) * 1000 : 0;
      setInfo(
        `${name}: compiled kernel computed ${rowFormat.format(rows)} rows in ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` +
          (perSec ? ` (${rowFormat.format(Math.round(perSec / 1e6))}M rows/s)` : ""),
      );
      rows = 0;
      ms = 0;
    }, 150);
  };
}
attachKernelReporting(source);

grid.onCellEdit = ({ row, col }, text) => {
  writeCells([{ row, col, input: text }], `edit in ${columnLetter(col)}${row + 1}`);
};

// Clearing goes cell by cell into the sparse edit map, so a whole 100M row
// column would mean 100M map entries. Cap it until there's a column-level op.
const MAX_BULK_CELLS = 1_000_000;

grid.onClearRange = (range) => {
  if (rangeSize(range) > MAX_BULK_CELLS) {
    statusLeft.textContent = `Clearing more than ${rowFormat.format(MAX_BULK_CELLS)} cells at once isn't supported yet.`;
    return;
  }
  const cells: CellInput[] = [];
  for (let row = range.top; row <= range.bottom; row++) {
    for (let col = range.left; col <= range.right; col++) {
      if (source.getCell(row, col) !== null) cells.push({ row, col, input: null });
    }
  }
  writeCells(cells, "clear");
};

// --- clipboard ------------------------------------------------------------------
// Only handle copy/paste when the grid itself has focus, so the formula bar
// and cell editor keep normal text clipboard behaviour.

function gridHasFocus() {
  const el = document.activeElement;
  return el instanceof HTMLCanvasElement && sheet.contains(el);
}

function copySelection(e: ClipboardEvent): boolean {
  const range = grid.range;
  if (rangeSize(range) > MAX_BULK_CELLS) {
    statusLeft.textContent = `Copying more than ${rowFormat.format(MAX_BULK_CELLS)} cells isn't supported yet.`;
    e.preventDefault();
    return false;
  }
  const text = rangeToTsv(source, range);
  e.clipboardData?.setData("text/plain", text);
  e.preventDefault();
  // remember it: pasting it back here moves formulas and keeps formats
  copied = { sheet: activeId, range, text };
  return true;
}

/** The last range copied in this tab, so a paste of it can be a real copy. */
let copied: { sheet: string; range: CellRange; text: string } | null = null;

/** "all" pastes formulas and formats from cellforge; "values" pastes results only. */
type PasteMode = "all" | "values";
let defaultPaste: PasteMode = (() => {
  try {
    return localStorage.getItem("cellforge.pasteMode") === "values" ? "values" : "all";
  } catch {
    return "all";
  }
})();
function setDefaultPaste(mode: PasteMode) {
  defaultPaste = mode;
  try {
    localStorage.setItem("cellforge.pasteMode", mode);
  } catch {
    // private mode: the setting lasts for this tab
  }
}

/** Ctrl+Shift+V pastes values only (the paste event can't tell, so remember the keys). */
let pasteValuesNext = false;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") pasteValuesNext = true;
});

async function pasteCopied(mode: "all" | "values" | "formulas" | "formats") {
  if (!copied || !workbook.has(copied.sheet)) return false;
  const { row, col } = grid.selection;
  const r = copied.range;
  const ok = await run({ type: "cells.paste", params: { from: r, fromSheet: copied.sheet, to: { row, col }, mode } });
  if (ok) {
    grid.selectRange({
      top: row,
      left: col,
      bottom: Math.min(source.rowCount - 1, row + r.bottom - r.top),
      right: Math.min(source.colCount - 1, col + r.right - r.left),
    });
  }
  return true;
}

document.addEventListener("copy", (e) => {
  if (gridHasFocus()) copySelection(e);
});

document.addEventListener("cut", (e) => {
  if (gridHasFocus() && copySelection(e)) grid.onClearRange?.(grid.range);
});

document.addEventListener("paste", (e) => {
  if (!gridHasFocus()) return;
  const text = e.clipboardData?.getData("text/plain");
  const valuesOnly = pasteValuesNext || defaultPaste === "values";
  pasteValuesNext = false;
  if (!text) return;
  e.preventDefault();
  // our own copy: paste it properly (formulas moved, formats kept)
  if (copied && text.replace(/\r?\n$/, "") === copied.text) {
    void pasteCopied(valuesOnly ? "values" : "all");
    return;
  }

  const rows = parseTsv(text.replace(/\r?\n$/, "")); // Excel adds a trailing newline
  const { row: top, col: left } = grid.selection;
  const cells: CellInput[] = [];
  let right = left;
  for (let i = 0; i < rows.length && top + i < source.rowCount; i++) {
    for (let j = 0; j < rows[i].length && left + j < source.colCount; j++) {
      cells.push({ row: top + i, col: left + j, input: rows[i][j] });
      right = Math.max(right, left + j);
    }
  }
  writeCells(cells, "paste");
  // select what was pasted so it's obvious where it went
  grid.selectRange({
    top,
    left,
    bottom: Math.min(source.rowCount - 1, top + rows.length - 1),
    right,
  });
});

// formula bar: enter commits to the active cell, escape throws the edit away
formulaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    grid.onCellEdit?.(grid.selection, formulaInput.value);
    grid.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    syncFormulaBar();
    grid.focus();
  }
});

// mirror what's being typed in the cell editor into the formula bar
sheet.addEventListener("input", (e) => {
  if (e.target instanceof HTMLInputElement) formulaInput.value = e.target.value;
});

function workbookEdited() {
  return workbook.sheets.length > 1 || workbook.sheets.some((x) => x.source.editCount > 0);
}

const tabs = new SheetTabs(document.getElementById("sheet-tabs")!, {
  workbook: () => workbook,
  active: () => activeId,
  switchTo: (id) => {
    showSheet(id);
    grid.focus();
  },
  run: (action) => run(action),
});
tabs.render();

// Ctrl+PgUp / Ctrl+PgDn: previous / next sheet (capture, before the grid's own PgUp/PgDn)
document.addEventListener(
  "keydown",
  (e) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== "PageUp" && e.key !== "PageDown")) return;
    if (document.activeElement instanceof HTMLInputElement && !sheet.contains(document.activeElement)) return;
    e.preventDefault();
    e.stopPropagation();
    const visible = workbook.visible;
    const i = visible.findIndex((x) => x.id === activeId);
    const next = visible[(i + (e.key === "PageDown" ? 1 : -1) + visible.length) % visible.length];
    showSheet(next.id);
    grid.focus();
  },
  true,
);

// --- inserting and deleting rows -----------------------------------------------

function selectedCols() {
  const r = grid.range;
  return { left: r.left, count: r.right - r.left + 1 };
}

async function insertCols(right: boolean) {
  const { left, count } = selectedCols();
  const at = right ? left + count : left;
  grid.spliceColumns(at, 0, count); // move widths before the data moves
  if (await run({ type: "cols.insert", params: { at, count } })) {
    grid.selectRange({ top: grid.range.top, left: at, bottom: grid.range.bottom, right: at + count - 1 });
  } else {
    grid.spliceColumns(at, count, 0);
  }
}

async function deleteCols() {
  const { left, count } = selectedCols();
  const top = grid.range.top;
  grid.spliceColumns(left, count, 0); // move widths with the data
  if (await run({ type: "cols.delete", params: { at: left, count } })) {
    const col = Math.min(left, source.colCount - 1);
    grid.selectRange({ top, left: col, bottom: top, right: col });
  } else {
    grid.spliceColumns(left, 0, count);
  }
}

function selectedRows() {
  const r = grid.range;
  return { top: r.top, count: r.bottom - r.top + 1 };
}

async function insertRows(below: boolean) {
  const { top, count } = selectedRows();
  const at = below ? top + count : top;
  if (await run({ type: "rows.insert", params: { at, count } })) {
    grid.selectRange({ top: at, left: grid.range.left, bottom: at + count - 1, right: grid.range.right });
  }
}

async function deleteRows() {
  const { top, count } = selectedRows();
  if (await run({ type: "rows.delete", params: { at: top, count } })) {
    const row = Math.min(top, source.rowCount - 1);
    grid.selectRange({ top: row, left: grid.range.left, bottom: row, right: grid.range.left });
  }
}

/** Hide the selected rows or columns, or show the hidden ones inside the selection. */
async function hideRows(hidden: boolean) {
  const { top, count } = selectedRows();
  if (hidden && count >= source.rowCount) {
    statusLeft.textContent = "At least one row has to stay visible.";
    return;
  }
  await run({ type: "rows.hide", params: { at: top, count, hidden } });
}

async function hideCols(hidden: boolean) {
  const { left, count } = selectedCols();
  await run({ type: "cols.hide", params: { at: left, count, hidden } });
}

// Excel: Ctrl+9 hides rows, Ctrl+Shift+9 shows them, Ctrl+0 hides columns,
// Ctrl+Shift+0 shows them (by code, so Shift doesn't turn 9 into "(").
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !gridHasFocus()) return;
  if (e.code === "Digit9") {
    e.preventDefault();
    void hideRows(!e.shiftKey);
  } else if (e.code === "Digit0") {
    e.preventDefault();
    void hideCols(!e.shiftKey);
  }
});

// Excel's Ctrl++ / Ctrl+- insert rows above the selection and delete them.
// Browsers may keep Ctrl+- for page zoom, so Google Sheets' Ctrl+Alt+= /
// Ctrl+Alt+- work too.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !gridHasFocus()) return;
  if (e.key === "+" || (e.key === "=" && (e.shiftKey || e.altKey))) {
    e.preventDefault();
    void insertRows(false);
  } else if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    void deleteRows();
  }
});

/** Fit the selected rows to their contents (one undo step). */
async function fitRows() {
  const { top, count } = selectedRows();
  const rows = Math.min(count, 5000); // measuring is per row; keep it quick
  const heights: (number | null)[] = [];
  for (let r = top; r < top + rows; r++) {
    const h = grid.fitRowHeight(r);
    heights.push(h === grid.defaultRowHeight ? null : h);
  }
  await run({ type: "rows.height", params: { at: top, heights } });
}

let cellMenu: HTMLElement | null = null;
function closeCellMenu() {
  cellMenu?.remove();
  cellMenu = null;
}
document.addEventListener("pointerdown", (e) => {
  if (cellMenu && !cellMenu.contains(e.target as Node)) closeCellMenu();
});
sheet.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  closeCellMenu();
  const kind = grid.selectForMenu(e.clientX, e.clientY);
  if (!kind) return;
  const { count } = selectedRows();
  const rows = count === 1 ? "row" : `${count.toLocaleString()} rows`;
  const nCols = selectedCols().count;
  const cols = nCols === 1 ? "column" : `${nCols} columns`;
  const menu = document.createElement("div");
  menu.className = "tab-menu";
  menu.setAttribute("role", "menu");
  const item = (label: string, keys: string, act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item";
    b.setAttribute("role", "menuitem");
    b.innerHTML = `<span>${label}</span><kbd>${keys}</kbd>`;
    b.addEventListener("click", () => {
      closeCellMenu();
      act();
      grid.focus();
    });
    menu.append(b);
  };
  // a row header shows only row actions, a column header only column ones
  if (kind !== "cols") {
    item(`Insert ${rows} above`, "Ctrl Alt =", () => void insertRows(false));
    item(`Insert ${rows} below`, "", () => void insertRows(true));
    item(`Delete ${rows}`, "Ctrl Alt −", () => void deleteRows());
    item(`Hide ${rows}`, "Ctrl 9", () => void hideRows(true));
    item("Unhide rows", "Ctrl Shift 9", () => void hideRows(false));
    item(`Fit ${count === 1 ? "row height" : "row heights"}`, "", () => void fitRows());
  }
  const sep = () => {
    const d = document.createElement("div");
    d.className = "menu-sep";
    menu.append(d);
  };
  if (kind === "cell") sep();
  if (kind !== "rows") {
    item(`Insert ${cols} left`, "", () => void insertCols(false));
    item(`Insert ${cols} right`, "", () => void insertCols(true));
    item(`Delete ${cols}`, "", () => void deleteCols());
    item(`Hide ${cols}`, "Ctrl 0", () => void hideCols(true));
    item("Unhide columns", "Ctrl Shift 0", () => void hideCols(false));
  }
  // paste options, for a range copied in cellforge
  if (kind === "cell" && copied && workbook.has(copied.sheet)) {
    sep();
    item("Paste", "Ctrl V", () => void pasteCopied("all"));
    item("Paste values only", "Ctrl Shift V", () => void pasteCopied("values"));
    item("Paste formulas only", "", () => void pasteCopied("formulas"));
    item("Paste formats only", "", () => void pasteCopied("formats"));
    item(defaultPaste === "values" ? "Ctrl V pastes: values only ✓ (switch to everything)" : "Ctrl V pastes: everything ✓ (switch to values only)", "", () =>
      setDefaultPaste(defaultPaste === "values" ? "all" : "values"),
    );
  }
  if (kind === "cell") {
    sep();
    item("Inspect this cell", "Ctrl [", () => inspectPanel.toggle());
    item("Make a table", "Ctrl T", () => void namesUi.makeTable());
    item("Define a name…", "", () => namesUi.defineName());
    item("Names and tables…", "Ctrl F3", () => namesUi.manager());
  }
  // merging, for a selection of more than one cell
  const sel = grid.range;
  const touchesMerge = source.getMerges().some((m) => m.top <= sel.bottom && sel.top <= m.bottom && m.left <= sel.right && sel.left <= m.right);
  if (kind === "cell" && (sel.top !== sel.bottom || sel.left !== sel.right)) {
    sep();
    if (touchesMerge) item("Unmerge cells", "", () => void run({ type: "cells.unmerge", params: { range: sel } }));
    item("Merge cells", "", () => void run({ type: "cells.merge", params: { range: sel } }));
    item("Merge and centre", "", () => void run({ type: "cells.merge", params: { range: sel, center: true } }));
    if (sel.bottom > sel.top) item("Merge across", "", () => void run({ type: "cells.merge", params: { range: sel, across: true } }));
    if (sel.right > sel.left) item("Centre across selection (no merge)", "", () => void run({ type: "format.set", params: { range: sel, style: { align: "centerAcross" } } }));
  }
  // freeze panes, as in Excel: rows above and columns left of the active cell
  sep();
  const { row: ar, col: acol } = grid.selection;
  const frozen = source.frozen.rows > 0 || source.frozen.cols > 0;
  if (frozen) item("Unfreeze panes", "", () => void run({ type: "view.freeze", params: { rows: 0, cols: 0 } }));
  if (kind === "cell" && (ar > 0 || acol > 0)) {
    item(`Freeze above row ${ar + 1}${acol > 0 ? ` and left of ${columnLetter(acol)}` : ""}`, "", () => void run({ type: "view.freeze", params: { rows: ar, cols: acol } }));
  }
  if (kind !== "cols") item("Freeze top row", "", () => void run({ type: "view.freeze", params: { rows: 1, cols: 0 } }));
  if (kind !== "rows") item("Freeze first column", "", () => void run({ type: "view.freeze", params: { rows: 0, cols: 1 } }));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  cellMenu = menu;
});

fileName.textContent = currentName;
statusRight.textContent = infoText;
syncFormulaBar();
updateStatus();
grid.focus();

// --- saving -------------------------------------------------------------------
// Autosave: every change goes into a journal in the browser's private file
// system (OPFS) as it happens, with a full snapshot now and then. After a
// crash or a closed tab, the next start loads the snapshot and replays the
// journal. Save / Open write and read one .cellforge file.

const saveState = document.getElementById("save-state")!;
let saver: AutoSaver | null = null;
let replaying = false;
// how many journal entries an undo / redo can still be expressed against;
// past that (undoing something from before the last snapshot) we snapshot
let journalRuns = 0;
let journalUndone = 0;
let snapshotTimer = 0;

function showSaved(text: string) {
  saveState.textContent = text;
}

async function snapshotNow() {
  if (!saver) return;
  window.clearTimeout(snapshotTimer);
  showSaved("saving…");
  try {
    await saver.snapshot(workbook, activeId, currentName);
    journalRuns = 0;
    journalUndone = 0;
    showSaved("saved");
  } catch (e) {
    showSaved("not saved");
    statusLeft.textContent = `Autosave failed: ${(e as Error).message}`;
  }
}

function journal(entry: JournalEntry) {
  if (!saver || replaying) return;
  if (entry.op === "run") {
    journalRuns++;
    journalUndone = 0;
  } else if (entry.op === "undo") {
    if (journalRuns === 0) return void snapshotNow();
    journalRuns--;
    journalUndone++;
  } else {
    if (journalUndone === 0) return void snapshotNow();
    journalUndone--;
    journalRuns++;
  }
  showSaved("saving…");
  saver.record(entry).then(
    () => showSaved("saved"),
    (e) => {
      showSaved("not saved");
      statusLeft.textContent = `Autosave failed: ${(e as Error).message}`;
    },
  );
  // compact now and then: a snapshot after a quiet spell or many changes
  window.clearTimeout(snapshotTimer);
  if (saver.pending >= 200) void snapshotNow();
  else snapshotTimer = window.setTimeout(() => void snapshotNow(), 20_000);
}

/** Start autosave; bring back the last session unless a demo was asked for. */
async function startAutosave() {
  // one tab owns the autosave; others still work, they just don't save
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks) {
    const got = await new Promise<boolean>((resolve) => {
      void locks.request("cellforge-autosave", { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? new Promise<void>(() => undefined) : undefined; // hold it for the page's life
      });
    });
    if (!got) {
      showSaved("autosave is on in another tab");
      return;
    }
  }
  const store = await OpfsStore.open();
  if (!store) {
    showSaved("autosave unavailable");
    return;
  }
  saver = new AutoSaver(store);
  if (startWithDemo) return void snapshotNow();
  try {
    const last = await AutoSaver.load(store);
    if (!last) return void snapshotNow();
    loadWorkbook(last.workbook, last.active, last.name);
    replaying = true;
    for (const e of last.journal) {
      if (e.op === "run") await history.run(e.action);
      else if (e.op === "undo") await history.undo();
      else await history.redo();
    }
    replaying = false;
    refresh();
    statusLeft.textContent = "Picked up where you left off.";
    void snapshotNow();
  } catch (e) {
    replaying = false;
    // don't overwrite what's there: it may be recoverable by a later version
    saver = null;
    showSaved("autosave off");
    statusLeft.textContent = `Couldn't restore the last session (${(e as Error).message}); autosave is off for this tab.`;
  }
}

void startAutosave();

// Save / Save as: one .cellforge file, via the File System Access API where
// the browser has it (so Ctrl+S saves in place), a download otherwise
let fileHandle: FileSystemFileHandle | null = null;
type SavePicker = (opts: unknown) => Promise<FileSystemFileHandle>;

async function saveFile(saveAs = false) {
  const name = `${currentName.replace(/\.(csv|tsv|txt|cellforge)$/i, "") || "workbook"}.cellforge`;
  let blob: Blob;
  try {
    blob = toFile(packWorkbook(workbook, activeId, currentName));
  } catch (e) {
    statusLeft.textContent = `Couldn't save: ${(e as Error).message}`;
    return;
  }
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) {
    download(blob, name);
    statusLeft.textContent = `Downloaded ${name}`;
    return;
  }
  try {
    if (!fileHandle || saveAs) {
      fileHandle = await picker({
        suggestedName: name,
        types: [{ description: "cellforge workbook", accept: { "application/x-cellforge": [".cellforge"] } }],
      });
    }
    const w = await fileHandle.createWritable();
    await w.write(blob);
    await w.close();
    statusLeft.textContent = `Saved ${fileHandle.name}`;
  } catch (e) {
    if ((e as DOMException).name !== "AbortError") statusLeft.textContent = `Couldn't save: ${(e as Error).message}`;
  }
}

document.getElementById("btn-save")!.addEventListener("click", () => void saveFile());

async function exportExcel() {
  try {
    statusLeft.textContent = "Writing the Excel file…";
    const blob = await saveXlsx(workbook);
    const name = `${currentName.replace(/\.(csv|tsv|txt|cellforge|xlsx|xlsm)$/i, "") || "workbook"}.xlsx`;
    download(blob, name);
    statusLeft.textContent = `Downloaded ${name}`;
  } catch (e) {
    statusLeft.textContent = `Couldn't export: ${(e as Error).message}`;
  }
}
document.getElementById("btn-export-xlsx")!.addEventListener("click", () => void exportExcel());
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "s") {
    e.preventDefault();
    void saveFile(e.shiftKey);
  } else if (k === "o" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("btn-open")?.click();
  }
});

// --- history panel ------------------------------------------------------------

// what was typed into each cell this session, by row identity so it follows sorts
const trail = new Map<string, TrailEntry[]>();
function recordTrail(action: Action) {
  if (action.type !== "cells.set") return;
  const p = action.params as { cells: { row: number; col: number; input: string | null }[]; sheet?: string };
  const sheetId = p.sheet ?? activeId;
  if (!workbook.has(sheetId)) return;
  const src = workbook.get(sheetId).source;
  const at = Date.now();
  for (const c of p.cells.slice(0, 500)) {
    const key = `${sheetId}:${src.toBase(c.row)}:${c.col}`;
    const list = trail.get(key) ?? [];
    list.push({ at, text: c.input ?? "" });
    if (list.length > 50) list.shift();
    trail.set(key, list);
  }
}

const historyPanel = setupHistoryPanel({
  root: document.getElementById("history-panel")!,
  workbook: () => workbook,
  activeSheet: () => activeId,
  selection: () => grid.selection,
  timeline: () => history.timeline,
  undo,
  redo,
  run: (a) => run(a),
  goTo: (sheetId, row, col) => {
    showSheet(sheetId);
    grid.select(row, col);
    grid.focus();
  },
  trail: (sheetId, rowId, col) => trail.get(`${sheetId}:${rowId}:${col}`) ?? [],
});

const inspectPanel = setupInspectPanel({
  root: document.getElementById("inspect-panel")!,
  workbook: () => workbook,
  activeSheet: () => activeId,
  selection: () => grid.selection,
  goTo: (sheetId, row, col) => {
    showSheet(sheetId);
    grid.select(row, col);
    grid.focus();
  },
  highlight: (list) => grid.setHighlights(list),
  onOpen: () => {
    if (historyPanel.open) historyPanel.toggle();
  },
});

document.getElementById("btn-history")!.addEventListener("click", () => {
  inspectPanel.close();
  historyPanel.toggle();
});
// Ctrl+[ inspects the cell (Excel's "go to precedents" key)
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "[") {
    e.preventDefault();
    inspectPanel.toggle();
  }
});
// Excel: Ctrl+T makes a table, Ctrl+F3 opens the name manager
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !gridHasFocus()) return;
  if (e.key.toLowerCase() === "t" && !e.shiftKey) {
    e.preventDefault();
    void namesUi.makeTable();
  } else if (e.key === "F3") {
    e.preventDefault();
    namesUi.manager();
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "h") {
    e.preventDefault();
    historyPanel.toggle();
  }
});

// --- names and tables -----------------------------------------------------------
const namesUi = setupNamesUi({
  workbook: () => workbook,
  sheetName: () => workbook.get(activeId).name,
  range: () => grid.range,
  run: (a) => run(a),
  focusGrid: () => grid.focus(),
  goTo: (sheetId, row, col) => {
    showSheet(sheetId);
    grid.select(row, col);
    grid.focus();
  },
});

// --- command palette (Ctrl+K) -------------------------------------------------

const click = (id: string) => () => document.getElementById(id)?.click();
const fmt = (style: Record<string, unknown>) => () => run({ type: "format.set", params: { range: grid.range, style } });
const toggle = (prop: "bold" | "italic" | "underline" | "strike" | "wrap") => () => {
  const { row, col } = grid.selection;
  return fmt({ [prop]: source.getStyle(row, col)?.[prop] ? null : true })();
};
const border = (which: string) => () => run({ type: "format.borders", params: { range: grid.range, which, line: { style: "thin", color: "auto" } } });

function paletteCommands(): Command[] {
  const { row, col } = grid.selection;
  const list: Command[] = [
    { id: "undo", title: "Undo", keys: "Ctrl Z", run: undo },
    { id: "iterative", title: workbook.iterative ? "Turn off iterative calculation" : "Turn on iterative calculation (for circular references)", hint: "circular cycle", run: () => run({ type: "calc.iterative", params: { enabled: !workbook.iterative } }) },
    { id: "inspect", title: "Inspect this cell", keys: "Ctrl [", hint: "trace precedents dependents evaluate formula audit", run: () => inspectPanel.toggle() },
    { id: "history", title: "Show history and versions", keys: "Ctrl H", hint: "timeline compare changes audit", run: () => historyPanel.toggle() },
    { id: "version-save", title: "Save a version…", hint: "name snapshot checkpoint", run: () => { if (!historyPanel.open) historyPanel.toggle(); document.querySelector<HTMLInputElement>(".hp-version-form input")?.focus(); } },
    { id: "redo", title: "Redo", keys: "Ctrl Y", run: redo },
    { id: "bold", title: "Bold", keys: "Ctrl B", run: toggle("bold") },
    { id: "italic", title: "Italic", keys: "Ctrl I", run: toggle("italic") },
    { id: "underline", title: "Underline", keys: "Ctrl U", run: toggle("underline") },
    { id: "strike", title: "Strikethrough", keys: "Ctrl 5", run: toggle("strike") },
    { id: "wrap", title: "Wrap text", run: toggle("wrap") },
    { id: "align-left", title: "Align left", run: fmt({ align: "left" }) },
    { id: "align-center", title: "Align centre", hint: "center", run: fmt({ align: "center" }) },
    { id: "align-right", title: "Align right", run: fmt({ align: "right" }) },
    { id: "center-across", title: "Centre across selection", hint: "center across", run: fmt({ align: "centerAcross" }) },
    { id: "clear-format", title: "Clear formatting", keys: "Ctrl \\", run: () => run({ type: "format.clear", params: { range: grid.range } }) },
    { id: "borders-all", title: "Borders: all", run: border("all") },
    { id: "borders-outline", title: "Borders: outline", run: border("outline") },
    { id: "borders-none", title: "Borders: none", run: border("none") },
    { id: "table", title: "Make a table from the selection", hint: "format as table structured", keys: "Ctrl T", run: () => namesUi.makeTable() },
    { id: "define-name", title: "Define a name for the selection…", hint: "named range", run: () => namesUi.defineName() },
    { id: "name-manager", title: "Names and tables…", hint: "name manager", keys: "Ctrl F3", run: () => namesUi.manager() },
    { id: "merge", title: "Merge cells", run: () => run({ type: "cells.merge", params: { range: grid.range } }) },
    { id: "merge-center", title: "Merge and centre", hint: "center", run: () => run({ type: "cells.merge", params: { range: grid.range, center: true } }) },
    { id: "merge-across", title: "Merge across", run: () => run({ type: "cells.merge", params: { range: grid.range, across: true } }) },
    { id: "unmerge", title: "Unmerge cells", run: () => run({ type: "cells.unmerge", params: { range: grid.range } }) },
    { id: "insert-rows", title: "Insert rows above", keys: "Ctrl Alt =", run: () => insertRows(false) },
    { id: "insert-rows-below", title: "Insert rows below", run: () => insertRows(true) },
    { id: "delete-rows", title: "Delete rows", keys: "Ctrl Alt −", run: deleteRows },
    { id: "insert-cols", title: "Insert columns left", run: () => insertCols(false) },
    { id: "insert-cols-right", title: "Insert columns right", run: () => insertCols(true) },
    { id: "delete-cols", title: "Delete columns", run: deleteCols },
    { id: "hide-rows", title: "Hide rows", keys: "Ctrl 9", run: () => hideRows(true) },
    { id: "unhide-rows", title: "Unhide rows", keys: "Ctrl Shift 9", run: () => hideRows(false) },
    { id: "hide-cols", title: "Hide columns", keys: "Ctrl 0", run: () => hideCols(true) },
    { id: "unhide-cols", title: "Unhide columns", keys: "Ctrl Shift 0", run: () => hideCols(false) },
    { id: "fit-rows", title: "Fit row height", hint: "autofit", run: fitRows },
    { id: "freeze-here", title: `Freeze panes above row ${row + 1}${col ? ` and left of ${columnLetter(col)}` : ""}`, run: () => run({ type: "view.freeze", params: { rows: row, cols: col } }) },
    { id: "freeze-row", title: "Freeze top row", run: () => run({ type: "view.freeze", params: { rows: 1, cols: 0 } }) },
    { id: "freeze-col", title: "Freeze first column", run: () => run({ type: "view.freeze", params: { rows: 0, cols: 1 } }) },
    { id: "unfreeze", title: "Unfreeze panes", run: () => run({ type: "view.freeze", params: { rows: 0, cols: 0 } }) },
    { id: "sort-asc", title: "Sort A→Z by this column", hint: "ascending smallest", run: () => sortBy(false) },
    { id: "sort-desc", title: "Sort Z→A by this column", hint: "descending largest", run: () => sortBy(true) },
    { id: "fill-down", title: "Fill down", keys: "Ctrl D", run: fillDown },
    { id: "paste-values", title: "Paste values only", keys: "Ctrl Shift V", run: () => pasteCopied("values") },
    { id: "paste-formats", title: "Paste formats only", run: () => pasteCopied("formats") },
    { id: "paste-formulas", title: "Paste formulas only", run: () => pasteCopied("formulas") },
    { id: "new", title: "New workbook", run: click("btn-new") },
    { id: "open", title: "Open…", keys: "Ctrl O", hint: "import csv file cellforge", run: click("btn-open") },
    { id: "save", title: "Save", keys: "Ctrl S", hint: "file cellforge", run: () => saveFile() },
    { id: "save-as", title: "Save as…", keys: "Ctrl Shift S", run: () => saveFile(true) },
    { id: "export-xlsx", title: "Export Excel (.xlsx)", hint: "download save excel xlsx", run: () => exportExcel() },
    { id: "export", title: "Export CSV", hint: "download save", run: click("btn-export") },
    { id: "demo", title: "Load the 100M-row demo", run: click("btn-demo") },
  ];
  for (const [name, code, example] of NUMBER_FORMATS) {
    list.push({ id: `numfmt:${name}`, title: `Number format: ${name}`, hint: example, run: fmt({ numFmt: code || null }) });
  }
  return list;
}

setupPalette({
  commands: paletteCommands,
  catalog: () => registry.catalog(),
  run: (a) => run(a),
  range: () => grid.range,
  focusGrid: () => grid.focus(),
});

function loadSource(next: EditableSource, name: string) {
  const wb = new Workbook({ name: sheetNameFrom(name), source: next });
  loadWorkbook(wb, wb.sheets[0].id, name);
  void snapshotNow();
}

/** Replace the whole workbook (open, new, restore). */
function loadWorkbook(next: Workbook, active: string, name: string) {
  trail.clear();
  workbook = next;
  activeId = active;
  selections.clear();
  source = workbook.get(active).source;
  currentName = name;
  attachKernelReporting(source);
  cancelSort?.();
  history.clear();
  blobs.clear();
  grid.setSource(source);
  fileName.textContent = name;
  refresh();
  grid.focus();
}

document.getElementById("btn-new")!.addEventListener("click", () => {
  if (workbookEdited() && !confirm("Discard your changes and start a new workbook?")) return;
  loadSource(new EditableSource(new BlankSource()), "Untitled");
});

document.getElementById("btn-demo")!.addEventListener("click", () => {
  if (workbookEdited() && !confirm("Discard your changes and load the demo?")) return;
  loadSource(new EditableSource(new SyntheticSource(DEMO_ROWS), SPARE_COLUMNS), "demo — synthetic sales");
});

// --- CSV export ---------------------------------------------------------------

// Above this we warn first: the 100M demo would be several GB of CSV.
const LARGE_EXPORT_ROWS = 5_000_000;
let exporting = false;

document.getElementById("btn-export")!.addEventListener("click", async () => {
  if (exporting) return;
  const { rows, cols } = source.usedRange();
  if (rows === 0 || cols === 0) {
    statusLeft.textContent = "Nothing to export yet — the sheet is empty.";
    return;
  }
  if (
    rows > LARGE_EXPORT_ROWS &&
    !confirm(`This will build a CSV with ${rowFormat.format(rows)} rows, which can take a while and a lot of memory. Continue?`)
  ) {
    return;
  }

  exporting = true;
  // blank sheets have no header row; imported/demo data has column names
  const includeHeader = source.getColumnName(0) !== undefined;
  try {
    const blob = await exportCsv(source, rows, cols, includeHeader, (done) => {
      statusLeft.textContent = `Exporting… ${Math.round((done / rows) * 100)}%`;
    });
    const base = currentName.replace(/\.(csv|tsv|txt)$/i, "").replace(/[^\w.-]+/g, "_");
    download(blob, `${base || "sheet"}.csv`);
    setInfo(`Exported ${formatBytes(blob.size)}`);
  } finally {
    exporting = false;
    updateStatus();
  }
});

// --- CSV import ---------------------------------------------------------------

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".cellforge,.xlsx,.xlsm,.csv,.tsv,.txt,text/csv,text/tab-separated-values";
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) openFile(file);
  fileInput.value = ""; // so picking the same file again still fires change
});
document.getElementById("btn-open")!.addEventListener("click", () => fileInput.click());

let cancelImport: (() => void) | null = null;

async function openFile(file: File) {
  cancelImport?.();
  if (/\.xls[xm]$/i.test(file.name)) {
    try {
      statusLeft.textContent = `Opening ${file.name}…`;
      const wb = await openXlsx(await file.arrayBuffer());
      fileHandle = null;
      loadWorkbook(wb, (wb.visible[0] ?? wb.sheets[0]).id, file.name.replace(/\.xls[xm]$/i, ""));
      void snapshotNow();
      statusLeft.textContent = `Opened ${file.name}: ${wb.sheets.length} sheet${wb.sheets.length === 1 ? "" : "s"}`;
    } catch (e) {
      statusLeft.textContent = `Couldn't open ${file.name}: ${(e as Error).message}`;
    }
    return;
  }
  if (/\.cellforge$/i.test(file.name)) {
    try {
      statusLeft.textContent = `Opening ${file.name}…`;
      const packed = fromFile(await file.arrayBuffer());
      const opened = await unpackWorkbook(packed.meta, async (n) => {
        const data = packed.files.get(n);
        if (data === undefined) throw new Error(`The file is missing ${n}.`);
        return data;
      });
      fileHandle = null;
      loadWorkbook(opened.workbook, opened.active, file.name.replace(/\.cellforge$/i, ""));
      void snapshotNow();
      statusLeft.textContent = `Opened ${file.name}`;
    } catch (e) {
      statusLeft.textContent = `Couldn't open ${file.name}: ${(e as Error).message}`;
    }
    return;
  }
  statusLeft.textContent = `Opening ${file.name}…`;

  const job = importCsv(file, ({ bytes, total, rows }) => {
    const pct = total ? Math.round((bytes / total) * 100) : 0;
    statusLeft.textContent =
      `Importing ${file.name} — ${pct}% (${formatBytes(bytes)} of ${formatBytes(total)}, ` +
      `${rowFormat.format(rows)} rows)`;
  });
  cancelImport = job.cancel;

  try {
    const { table, ms } = await job.result;
    loadSource(new EditableSource(table, SPARE_COLUMNS), file.name);
    setInfo(`Imported ${formatBytes(file.size)} in ${(ms / 1000).toFixed(2)}s`);
  } catch (err) {
    // a newer import cancelling this one isn't an error worth showing
    if ((err as Error).message !== "Import cancelled") {
      statusLeft.textContent = `Couldn't open ${file.name}: ${(err as Error).message}`;
    }
  } finally {
    if (cancelImport === job.cancel) cancelImport = null;
  }
}

// drag a file anywhere onto the window
const dropOverlay = document.getElementById("drop-overlay")!;
let dragDepth = 0; // dragenter/leave fire for every child element, so count them

window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault()); // required to allow drop
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const file = e.dataTransfer?.files[0];
  if (file) openFile(file);
});

// handy for poking at things from devtools
declare global {
  interface Window {
    grid: Grid;
  }
}
window.grid = grid;
