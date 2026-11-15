/**
 * Lab A, the scale moment: the real grid over the 100M-line demo ledger
 * (computed from the row number, nothing stored), driven by the page's
 * scroll. As the section passes, the grid travels from line 1 to line
 * 100,000,000. Using the grid (pointer, wheel, keys) hands it over.
 */
import { SyntheticSource } from "../demo";
import { BIG_ROWS } from "../samples";
import { int, LiveSheet } from "../landing/sheet";

export interface ScaleStage {
  go(row: number): void;
  /** true once the visitor has taken the grid over */
  readonly yours: boolean;
}

export function mountScale(root: HTMLElement, onLine: (row: number) => void): ScaleStage {
  const frame = root.querySelector<HTMLElement>(".af")!;
  const host = frame.querySelector<HTMLElement>(".af-grid")!;
  host.replaceChildren();
  const source = new SyntheticSource(BIG_ROWS);
  let yours = false;
  const sheet = new LiveSheet(host, source, {
    label: "Demo general ledger, 100 million lines, a live cellforge sheet",
    frame,
    defaultColumnWidth: 96,
    idleStatus: () => `Line ${int.format(sheet.grid.selection.row + 1)} of ${int.format(BIG_ROWS)}`,
    onSelect: (r) => {
      if (yours) onLine(r.top);
    },
  });
  sheet.layout({ widths: [84, 94, 76, 168, 104, 104, 300, 86] });
  sheet.grid.select(0, 0);
  const take = () => {
    yours = true;
    root.classList.add("is-yours");
  };
  for (const ev of ["pointerdown", "wheel", "keydown", "touchstart"]) host.addEventListener(ev, take, { passive: true });

  let last = -1;
  return {
    go(row) {
      if (yours || row === last) return;
      last = row;
      const g = sheet.grid;
      g.select(row, 0);
      // the line at the top, with the lines after it below
      g.scrollIntoView(Math.min(BIG_ROWS - 1, row + 400), 0);
      g.scrollIntoView(row, 0);
    },
    get yours() {
      return yours;
    },
  };
}
