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
  syncFormulaBar();
  updateSelectionStats();
};

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
}

/** Repaint and update everything that shows cell contents. */
function refresh() {
  settleActiveSheet();
  tabs.render();
  grid.invalidate();
  syncFormulaBar();
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
    refresh();
    if (label) statusLeft.textContent = `Undid ${label}`;
  } catch (e) {
    statusLeft.textContent = `Couldn't undo: ${(e as Error).message}`;
  }
}

async function redo() {
  try {
    const label = await history.redo();
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
  e.clipboardData?.setData("text/plain", rangeToTsv(source, range));
  e.preventDefault();
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
  if (!text) return;
  e.preventDefault();

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
  const { count } = selectedRows();
  const rows = count === 1 ? "row" : `${count.toLocaleString()} rows`;
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
  item(`Insert ${rows} above`, "Ctrl Alt =", () => void insertRows(false));
  item(`Insert ${rows} below`, "", () => void insertRows(true));
  item(`Delete ${rows}`, "Ctrl Alt −", () => void deleteRows());
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

function loadSource(next: EditableSource, name: string) {
  workbook = new Workbook({ name: sheetNameFrom(name), source: next });
  activeId = workbook.sheets[0].id;
  selections.clear();
  source = next;
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
fileInput.accept = ".csv,.tsv,.txt,text/csv,text/tab-separated-values";
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) openFile(file);
  fileInput.value = ""; // so picking the same file again still fires change
});
document.getElementById("btn-open")!.addEventListener("click", () => fileInput.click());

let cancelImport: (() => void) | null = null;

async function openFile(file: File) {
  cancelImport?.();
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
