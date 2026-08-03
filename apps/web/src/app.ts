import "./style.css";
import { Grid, columnLetter } from "@cellforge/grid";
import { parseTsv, rangeSize, rangeToTsv } from "./clipboard";
import { computeStats } from "./stats";
import { SyntheticSource } from "./demo";
import { BlankSource, EditableSource, parseInput, type Stored } from "./editable";
import { download, exportCsv } from "./exporter";
import { History } from "./history";
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

let source = new EditableSource(
  startWithDemo ? new SyntheticSource(DEMO_ROWS) : new BlankSource(),
);
let currentName = startWithDemo ? "demo — synthetic sales" : "Untitled";
const grid = new Grid(sheet, source);

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

const history = new History();
const undoButton = document.getElementById("btn-undo") as HTMLButtonElement;
const redoButton = document.getElementById("btn-redo") as HTMLButtonElement;

// `undefined` means "no edit" (show the underlying data), which is different
// from null ("edited to be empty") - undo needs to tell those apart.
type CellChange = { row: number; col: number; value: Stored | undefined };

function applyChanges(target: EditableSource, changes: CellChange[]) {
  for (const { row, col, value } of changes) {
    if (value === undefined) target.revertCell(row, col);
    else target.setCell(row, col, value);
  }
}

/** Repaint and update everything that shows cell contents. */
function refresh() {
  grid.invalidate();
  syncFormulaBar();
  updateStatus();
  updateSelectionStats();
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
}

/** Write several cells as one undoable step. */
function writeCells(changes: CellChange[], label: string) {
  if (changes.length === 0) return;
  // capture the sheet itself - history is cleared when a new sheet loads, but
  // being explicit means an undo can never write into the wrong one
  const target = source;
  const before = changes.map(({ row, col }) => ({ row, col, value: target.getStored(row, col) }));
  applyChanges(target, changes);
  history.push({
    label,
    undo: () => applyChanges(target, before),
    redo: () => applyChanges(target, changes),
  });
  refresh();
}

function undo() {
  const cmd = history.undo();
  if (cmd) statusLeft.textContent = `Undid ${cmd.label}`;
  refresh();
}

function redo() {
  const cmd = history.redo();
  if (cmd) statusLeft.textContent = `Redid ${cmd.label}`;
  refresh();
}

undoButton.addEventListener("click", () => {
  undo();
  grid.focus();
});
redoButton.addEventListener("click", () => {
  redo();
  grid.focus();
});

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  // leave text inputs alone so ctrl+z inside the formula bar undoes typing
  if (document.activeElement instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (k === "y" || (k === "z" && e.shiftKey)) {
    e.preventDefault();
    redo();
  }
});

grid.onCellEdit = ({ row, col }, text) => {
  writeCells([{ row, col, value: parseInput(text) }], `edit in ${columnLetter(col)}${row + 1}`);
};

// Clearing goes cell by cell into the sparse edit map, so a whole 100M row
// column would mean 100M map entries. Cap it until there's a column-level op.
const MAX_BULK_CELLS = 1_000_000;

grid.onClearRange = (range) => {
  if (rangeSize(range) > MAX_BULK_CELLS) {
    statusLeft.textContent = `Clearing more than ${rowFormat.format(MAX_BULK_CELLS)} cells at once isn't supported yet.`;
    return;
  }
  const changes: CellChange[] = [];
  for (let row = range.top; row <= range.bottom; row++) {
    for (let col = range.left; col <= range.right; col++) {
      if (source.getCell(row, col) !== null) changes.push({ row, col, value: null });
    }
  }
  writeCells(changes, "clear");
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
  const changes: CellChange[] = [];
  let right = left;
  for (let i = 0; i < rows.length && top + i < source.rowCount; i++) {
    for (let j = 0; j < rows[i].length && left + j < source.colCount; j++) {
      changes.push({ row: top + i, col: left + j, value: parseInput(rows[i][j]) });
      right = Math.max(right, left + j);
    }
  }
  writeCells(changes, "paste");
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

fileName.textContent = currentName;
statusRight.textContent = infoText;
syncFormulaBar();
updateStatus();
grid.focus();

function loadSource(next: EditableSource, name: string) {
  source = next;
  currentName = name;
  history.clear();
  grid.setSource(source);
  fileName.textContent = name;
  refresh();
  grid.focus();
}

document.getElementById("btn-new")!.addEventListener("click", () => {
  if (source.editCount && !confirm("Discard your changes and start a new sheet?")) return;
  loadSource(new EditableSource(new BlankSource()), "Untitled");
});

document.getElementById("btn-demo")!.addEventListener("click", () => {
  if (source.editCount && !confirm("Discard your changes and load the demo?")) return;
  loadSource(new EditableSource(new SyntheticSource(DEMO_ROWS)), "demo — synthetic sales");
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
    loadSource(new EditableSource(table), file.name);
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
