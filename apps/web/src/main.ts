import "./style.css";
import { Grid, columnLetter, formatCell } from "@cellforge/grid";
import { SyntheticSource } from "./demo";
import { EditableSource, parseInput } from "./editable";

const DEMO_ROWS = 100_000_000;

const sheet = document.getElementById("sheet")!;
const statusLeft = document.getElementById("status-left")!;
const statusRight = document.getElementById("status-right")!;
const fileName = document.getElementById("file-name")!;
const cellRef = document.getElementById("cell-ref")!;
const formulaInput = document.getElementById("formula-input") as HTMLInputElement;

const rowFormat = new Intl.NumberFormat();

let source = new EditableSource(new SyntheticSource(DEMO_ROWS));
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

fileName.textContent = "demo — synthetic sales";
statusRight.textContent = "gpu" in navigator ? "WebGPU available" : "WebGPU not available (CPU fallback)";
syncFormulaBar();
updateStatus();
grid.focus();

document.getElementById("btn-demo")!.addEventListener("click", () => {
  source = new EditableSource(new SyntheticSource(DEMO_ROWS));
  grid.setSource(source);
  updateStatus();
  grid.focus();
});

// handy for poking at things from devtools
declare global {
  interface Window {
    grid: Grid;
  }
}
window.grid = grid;
