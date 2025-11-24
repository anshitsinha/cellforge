import "./style.css";
import { Grid } from "@cellforge/grid";
import { SyntheticSource } from "./demo";

const DEMO_ROWS = 100_000_000;

const sheet = document.getElementById("sheet")!;
const statusLeft = document.getElementById("status-left")!;
const statusRight = document.getElementById("status-right")!;
const fileName = document.getElementById("file-name")!;

const rowFormat = new Intl.NumberFormat();

const source = new SyntheticSource(DEMO_ROWS);
const grid = new Grid(sheet, source);

fileName.textContent = "demo — synthetic sales";
statusLeft.textContent = `${rowFormat.format(source.rowCount)} rows × ${source.colCount} columns`;
statusRight.textContent = "gpu" in navigator ? "WebGPU available" : "WebGPU not available (CPU fallback)";

document.getElementById("btn-demo")!.addEventListener("click", () => {
  grid.setSource(new SyntheticSource(DEMO_ROWS));
});

// handy for poking at things from devtools
declare global {
  interface Window {
    grid: Grid;
  }
}
window.grid = grid;
