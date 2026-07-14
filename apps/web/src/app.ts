import "./style.css";
import { Grid, columnLetter, formatCell } from "@cellforge/grid";
import { SyntheticSource } from "./demo";
import { BlankSource, EditableSource, parseInput } from "./editable";
import { download, exportCsv } from "./exporter";
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
  formulaInput.value = formatCell(source.getCell(row, col));
}

// keep the name box + formula bar in sync with whatever cell is active
grid.onSelectionChange = syncFormulaBar;

grid.onCellEdit = ({ row, col }, text) => {
  source.setCell(row, col, parseInput(text));
  grid.invalidate();
  syncFormulaBar();
  updateStatus();
};

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
statusRight.textContent = "gpu" in navigator ? "WebGPU available" : "WebGPU not available (CPU fallback)";
syncFormulaBar();
updateStatus();
grid.focus();

function loadSource(next: EditableSource, name: string) {
  source = next;
  currentName = name;
  grid.setSource(source);
  fileName.textContent = name;
  updateStatus();
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
    statusRight.textContent = `Exported ${formatBytes(blob.size)}`;
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
    statusRight.textContent = `Imported ${formatBytes(file.size)} in ${(ms / 1000).toFixed(2)}s`;
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
