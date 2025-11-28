import "./home.css";
import { Grid } from "@cellforge/grid";
import { SyntheticSource } from "./demo";

// The hero shows a real grid rather than a screenshot - it's the best proof
// that the 100M-row claim isn't marketing.
const ROWS = 100_000_000;
const container = document.getElementById("demo-grid")!;
const label = document.getElementById("demo-label")!;
const fmt = new Intl.NumberFormat();

const grid = new Grid(container, new SyntheticSource(ROWS), { defaultColumnWidth: 100 });

// Respect people who've asked for less motion.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Glide down, then periodically "teleport" deeper into the sheet so it's
// obvious we're not just looping over the first few hundred rows.
const JUMPS = [0, 1_250_000, 18_000_000, 47_500_000, 99_999_000];
let jump = 0;
let row = 0;
let paused = false;

container.addEventListener("mouseenter", () => (paused = true));
container.addEventListener("mouseleave", () => (paused = false));

function tick() {
  if (!paused && !reduceMotion) {
    row += 0.06;
    grid.select(Math.floor(row), 4);
    label.textContent = `row ${fmt.format(Math.floor(row) + 1)} of ${fmt.format(ROWS)}`;
  }
  requestAnimationFrame(tick);
}

setInterval(() => {
  if (paused || reduceMotion) return;
  jump = (jump + 1) % JUMPS.length;
  row = JUMPS[jump];
}, 4000);

requestAnimationFrame(tick);
