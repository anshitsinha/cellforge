import "./style.css";
import { Grid, columnLetter, formatCell } from "@cellforge/grid";
import { SyntheticSource } from "./demo";

const DEMO_ROWS = 100_000_000;

const sheet = document.getElementById("sheet")!;
const statusLeft = document.getElementById("status-left")!;
const statusRight = document.getElementById("status-right")!;
const fileName = document.getElementById("file-name")!;

const cellRef = document.getElementById("cell-ref")!;
const formulaInput = document.getElementById("formula-input") as HTMLInputElement;

const rowFormat = new Intl.NumberFormat();

let source = new SyntheticSource(DEMO_ROWS);
const grid = new Grid(sheet, source);

// keep the name box + formula bar in sync with whatever cell is active
grid.onSelectionChange = ({ row, col }) => {
  cellRef.textContent = `${columnLetter(col)}${row + 1}`;
  formulaInput.value = formatCell(source.getCell(row, col));
};
grid.onSelectionChange(grid.selection);
grid.focus();

fileName.textContent = "demo — synthetic sales";
statusLeft.textContent = `${rowFormat.format(source.rowCount)} rows × ${source.colCount} columns`;
statusRight.textContent = "gpu" in navigator ? "WebGPU available" : "WebGPU not available (CPU fallback)";

document.getElementById("btn-demo")!.addEventListener("click", () => {
  source = new SyntheticSource(DEMO_ROWS);
  grid.setSource(source);
  grid.focus();
});

// handy for poking at things from devtools
declare global {
  interface Window {
    grid: Grid;
  }
}
window.grid = grid;
