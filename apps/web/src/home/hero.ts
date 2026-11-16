/**
 * Variant C hero: the sample cash book in the real grid. The real matching
 * engine reconciles it against the bank statement as the page opens (in a few
 * milliseconds); the rows then tick green one by one so a person can watch
 * what it found. Problems light up amber and red, and stickers around the
 * window call them out. Change an amount and it matches again.
 */
import type { CellStyle, CellValue } from "@cellforge/grid";
import { bankRecSample } from "../samples";
import { isoSerial, money, runBankRec, type BankRec, type Tone } from "../landing/compute";
import { isDark, ms } from "../landing/frame";
import { linesOf } from "../landing/hero";
import { LiveSheet } from "../landing/sheet";
import { AMOUNT, DATE, HEADER_STYLE, TableSource } from "../landing/table";

// The demo sheets' header row, in this page's warm paper instead of the
// templates' cool grey (only on this page: it's this page's copy of the module).
Object.defineProperties(HEADER_STYLE, {
  fill: { get: () => (isDark() ? "#2e2920" : "#f2e8d2"), enumerable: true },
  color: { get: () => (isDark() ? "#f7f0e1" : "#1d1a14"), enumerable: true },
});

/** A view of a sheet whose header row (row 0) uses the warm header look. */
export function warmHeader<T extends { getStyle?(row: number, col: number): CellStyle | null }>(src: T): T {
  return new Proxy(src, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === "getStyle" && typeof v === "function")
        return (row: number, col: number) => {
          const s = v.call(target, row, col) as CellStyle | null;
          return row === 0 ? { ...s, fill: HEADER_STYLE.fill, color: HEADER_STYLE.color, bold: true } : s;
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const HEADERS = ["Date", "Reference", "Description", "Amount", "Note"];
const WIDTHS = [92, 96, 196, 100, 260];

type Note = { text: string; tone: Tone };

/** Row fills: soft paper tints that read in both themes. */
export function rowFill(tone: Tone | "flash"): CellStyle {
  const dark = isDark();
  switch (tone) {
    case "flash":
      return dark ? { fill: "#2f6b4b", color: "#ffffff" } : { fill: "#9fe6c2", color: "#10291c" };
    case "ok":
      return dark ? { fill: "#1b2c22" } : { fill: "#e6f6ec" };
    case "bad":
      return dark ? { fill: "#4a1f1c", color: "#ffd2cc" } : { fill: "#ffd9d2", color: "#8a1606" };
    case "warn":
      return dark ? { fill: "#463613", color: "#ffe2a6" } : { fill: "#ffefc2", color: "#7a4a00" };
    case "info":
      return dark ? { fill: "#1d2a45", color: "#cfe0ff" } : { fill: "#e1ebff", color: "#173f99" };
  }
}

export function mount(root: HTMLElement, ctx: { reduce: boolean }) {
  const host = root.querySelector<HTMLElement>(".cx-sheet")!;
  const status = root.querySelector<HTMLElement>(".cx-win-status")!;
  const meter = root.querySelector<HTMLElement>(".cx-meter span")!;
  const took$ = root.querySelector<HTMLElement>(".cx-took")!;
  const replay = root.querySelector<HTMLButtonElement>(".cx-replay")!;
  const stA = root.querySelector<HTMLElement>(".cx-st-a")!;
  const stB = root.querySelector<HTMLElement>(".cx-st-b")!;
  const stC = root.querySelector<HTMLElement>(".cx-st-c")!;
  const sample = bankRecSample();

  const rows: CellValue[][] = sample.ledger.map((l) => [isoSerial(l.date), l.reference || null, l.description, l.amount, null]);
  let notes = new Map<number, Note>(); // sheet data row (0-based) -> note
  let shown = 0; // rows ticked so far
  let rec: BankRec;
  let took = 0;

  const src = new TableSource(HEADERS, rows, {
    formats: [DATE, null, null, AMOUNT, null],
    spare: 4,
    styleOf: (row, col) => {
      if (row >= shown) return null;
      const n = notes.get(row);
      if (!n) return null;
      const s = rowFill(row === shown - 1 && shown < rows.length ? "flash" : n.tone);
      if (col === 4) return { ...s, bold: n.tone !== "ok", color: s.color ?? (n.tone === "ok" ? (isDark() ? "#7fdcaa" : "#12643c") : undefined) };
      return s;
    },
  });
  const getCell = src.getCell.bind(src);
  src.getCell = (row, col) => {
    if (col !== 4 || row === 0) return getCell(row, col);
    if (row - 1 >= shown) return null;
    const n = notes.get(row - 1);
    return n ? (n.tone === "ok" ? `✓ ${n.text.replace(/^Matched: /, "")}` : `● ${n.text}`) : null;
  };

  host.replaceChildren();
  const narrow = () => host.clientWidth < 560;
  const hidden = () => (narrow() ? [0, 1] : host.clientWidth < 760 ? [0] : []);
  const sheet = new LiveSheet(host, src, {
    label: "Sample cash book, reconciled live by cellforge",
    onEdit: (cell, text) => {
      if (cell.col === 4 || cell.row < 1) return false;
      src.set(cell.row, cell.col, text);
      run();
      shown = rows.length;
      finish(false);
      return true;
    },
  });
  const layout = () => sheet.layout({ widths: WIDTHS, frozenRows: 1, hiddenCols: hidden() });
  layout();
  new ResizeObserver(() => layout()).observe(host);

  function run() {
    const { lines, rows: at } = linesOf(src);
    const t0 = performance.now();
    rec = runBankRec(lines, sample.bank);
    took = performance.now() - t0;
    notes = new Map();
    at.forEach((row, line) => {
      const n = rec.notes.a.get(line);
      if (n) notes.set(row, n);
    });
  }

  const keyRow = () => (rec.keyingExample ? rec.keyingExample.a : -1);
  const twiceRow = () => rec.rows.find((r) => r.label === "Posted twice")?.a[0] ?? -1;
  const pop = (el: HTMLElement, on: boolean) => el.classList.toggle("on", on);

  function paintProgress() {
    let ok = 0;
    for (let r = 0; r < shown; r++) if (notes.get(r)?.tone === "ok") ok++;
    stA.querySelector("b")!.textContent = String(ok);
    pop(stA, shown > 0);
    meter.style.setProperty("--p", `${(shown / rows.length) * 100}%`);
    const k = rec.keyingExample;
    if (k && shown > keyRow()) {
      if (!stB.classList.contains("on")) {
        stB.replaceChildren(document.createTextNode(`${k.label[0].toUpperCase()}${k.label.slice(1)}!`), Object.assign(document.createElement("small"), { textContent: `${k.reference}: ${money(k.ledger)} in the book, ${money(k.bank)} at the bank` }));
      }
      pop(stB, true);
    } else pop(stB, false);
    if (twiceRow() >= 0 && shown > twiceRow()) {
      if (!stC.classList.contains("on")) stC.replaceChildren(document.createTextNode("Posted twice."), Object.assign(document.createElement("small"), { textContent: "Reverse it, and the rec agrees." }));
      pop(stC, true);
    } else pop(stC, false);
    if (shown < rows.length) status.textContent = `Ticking off line ${shown} of ${rows.length}…`;
  }

  function finish(showProblem: boolean) {
    paintProgress();
    sheet.refresh();
    const c = rec.card;
    status.setAttribute("aria-live", "polite");
    status.textContent = `${c.matchPct.toFixed(1)}% matched · ${c.leftA + c.leftB} lines left to explain`;
    took$.textContent = `The sample month, matched in ${ms(took)} by the real engine in this tab. We slowed the ticks down so you could watch.`;
    replay.disabled = false;
    root.classList.add("is-done");
    if (showProblem && keyRow() >= 0) {
      const r = keyRow() + 1;
      sheet.reveal({ top: r, left: narrow() ? 2 : 0, bottom: r, right: 4 }, "#d93025", { top: r, left: 3, bottom: r, right: 3 });
    }
  }

  let timer = 0;
  function animate() {
    clearInterval(timer);
    root.classList.remove("is-done");
    replay.disabled = true;
    // the line-by-line progress isn't read out; the result is
    status.setAttribute("aria-live", "off");
    shown = 0;
    sheet.grid.setHighlights([]);
    sheet.grid.select(0, narrow() ? 2 : 0);
    sheet.grid.scrollIntoView(0, narrow() ? 2 : 0);
    if (ctx.reduce) {
      shown = rows.length;
      finish(true);
      return;
    }
    const step = Math.max(45, Math.min(110, 3200 / rows.length));
    timer = window.setInterval(() => {
      shown++;
      const col = narrow() ? 2 : 0;
      sheet.grid.scrollIntoView(Math.min(rows.length, shown + 3), col);
      sheet.refresh();
      paintProgress();
      if (shown >= rows.length) {
        clearInterval(timer);
        finish(true);
      }
    }, step);
  }

  // anyone using the sheet gets it as it is: finish at once
  const takeOver = () => {
    if (shown >= rows.length) return;
    clearInterval(timer);
    shown = rows.length;
    finish(false);
  };
  host.addEventListener("pointerdown", takeOver);
  host.addEventListener("keydown", takeOver);
  replay.addEventListener("click", animate);

  run();
  window.setTimeout(animate, ctx.reduce ? 0 : 500);
}
