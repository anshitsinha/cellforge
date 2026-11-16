/**
 * Variant C's 100-million-row moment. The section is tall and its content
 * pinned; the page's scroll drives the real grid down the 100M-line ledger
 * (on a log scale, so the first screens cover the first thousand rows and the
 * last ones the last 90 million). An odometer shows the row, and a note pops
 * up as it passes the 1,048,576th. Grab the grid and it stops following.
 */
import { SyntheticSource } from "../demo";
import { BIG_ROWS } from "../samples";
import { int, LiveSheet } from "../landing/sheet";

const EXCEL_ROWS = 1_048_576;

export function mount(root: HTMLElement, ctx: { onScroll: (f: () => void) => void; reduce: boolean }) {
  const host = root.querySelector<HTMLElement>(".cx-sheet")!;
  const odo = root.querySelector<HTMLElement>(".cx-odo-n")!;
  host.replaceChildren();
  const sheet = new LiveSheet(host, new SyntheticSource(BIG_ROWS), {
    label: "General ledger demo, 100 million lines",
    defaultColumnWidth: 96,
  });
  const layout = () => {
    const narrow = host.clientWidth < 520;
    sheet.layout({ widths: [84, 94, 76, 168, 104, 104, 300, 86], hiddenCols: narrow ? [1, 2, 3, 5, 7] : [2] });
  };
  layout();
  new ResizeObserver(layout).observe(host);

  let owned = false;
  let last = -1;
  const go = (row: number) => {
    if (row === last) return;
    last = row;
    sheet.grid.select(row, 0);
    sheet.grid.scrollIntoView(Math.min(BIG_ROWS - 1, row + 6), 0);
    sheet.grid.scrollIntoView(row, 0);
    odo.textContent = int.format(row + 1);
    root.classList.toggle("past-excel", row + 1 > EXCEL_ROWS && row + 1 < BIG_ROWS * 0.6);
    root.classList.toggle("at-end", row + 1 >= BIG_ROWS);
  };
  for (const ev of ["pointerdown", "wheel", "keydown", "touchstart"]) host.addEventListener(ev, () => {
    owned = true;
    root.classList.add("is-owned");
  }, { passive: true });

  if (ctx.reduce) {
    go(BIG_ROWS - 1);
    return;
  }
  ctx.onScroll(() => {
    const r = root.getBoundingClientRect();
    const travel = r.height - innerHeight;
    // the grid is handed back once the section is off screen
    if (r.bottom < 0 || r.top > innerHeight) {
      owned = false;
      root.classList.remove("is-owned");
    }
    if (owned || travel <= 0) return;
    const p = Math.min(1, Math.max(0, -r.top / travel));
    // log scale from row 1 to row 100,000,000; the last stretch rests on the last row
    const q = Math.min(1, p / 0.9);
    const row = q >= 1 ? BIG_ROWS - 1 : Math.max(0, Math.round(Math.pow(BIG_ROWS, q)) - 1);
    go(row);
  });
}
