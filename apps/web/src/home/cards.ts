/**
 * Variant C's workflow cards: one small, cropped live sheet each.
 *
 * - Bank rec: what the real match left to explain, and the difference (none).
 * - Close: the close sample's Flux sheet with a threshold slider that types
 *   into Settings!B2, so the template's own formulas re-flag the movements.
 * - Audit: the sample journal scored by the eleven journal entry tests,
 *   highest scores first.
 */
import type { CellValue } from "@cellforge/grid";
import { auditSample, bankRecSample } from "../samples";
import { isoSerial, runBankRec, runJournalTests, type Tone } from "../landing/compute";
import { openBook } from "../landing/book";
import { JE_TEST_LABEL } from "../landing/engine";
import { countUp } from "../landing/frame";
import { LiveSheet } from "../landing/sheet";
import { AMOUNT, TableSource } from "../landing/table";
import { rowFill, warmHeader } from "./hero";

const sheetHost = (root: HTMLElement) => {
  const host = root.querySelector<HTMLElement>(".cx-sheet")!;
  host.replaceChildren();
  return host;
};
const narrowOf = (el: HTMLElement) => el.clientWidth < 520;

// ------------------------------------------------------------- bank rec --

export function mountRec(root: HTMLElement) {
  const host = sheetHost(root);
  const big = root.querySelector<HTMLElement>(".cx-big-n")!;
  const s = bankRecSample();
  const rec = runBankRec(s.ledger, s.bank);
  const items = rec.rows.filter((r) => r.group !== "matched");
  const rows: CellValue[][] = items.map((r) => [r.label, r.detail, r.amount]);
  const tones: (Tone | null)[] = items.map((r) => r.tone);
  const diff = rec.statement.difference;
  rows.push([null, null, null], ["Difference", diff ? "Book and bank don't agree yet" : "✓ Book and bank agree", diff]);
  tones.push(null, diff ? "bad" : "ok");
  const src = new TableSource(["What", "Detail", "Amount"], rows, {
    formats: [null, null, AMOUNT],
    spare: 2,
    styleOf: (row, col) => {
      const t = tones[row];
      if (!t) return null;
      const f = rowFill(t);
      return col === 0 || row === rows.length - 1 ? { ...f, bold: true } : f;
    },
  });
  const sheet = new LiveSheet(host, src, { label: "What the sample bank rec left to explain" });
  const layout = () => sheet.layout({ widths: narrowOf(host) ? [154, 230, 100] : [176, 300, 110], frozenRows: 1, hiddenCols: narrowOf(host) ? [1] : [] });
  layout();
  new ResizeObserver(layout).observe(host);
  // start on the most telling line: the keying error
  const bad = tones.indexOf("bad");
  const fits = Math.floor((host.clientHeight - 30) / 24) - 1;
  sheet.grid.select(bad >= 0 && bad + 1 <= fits ? bad + 1 : 1, 0);
  countUp(big, rec.card.matchPct, 1);
  big.dataset.suffix = "%";
}

// ---------------------------------------------------------------- close --

export async function mountClose(root: HTMLElement) {
  const host = sheetHost(root);
  const input = root.querySelector<HTMLInputElement>("#cx-thr-in")!;
  const out = root.querySelector<HTMLOutputElement>(".cx-thr-v")!;
  const count = root.querySelector<HTMLElement>(".cx-thr-n b")!;
  const book = await openBook("close");
  const flux = book.wb.byName("Flux")!;
  const settings = book.wb.byName("Settings")!;
  const view = warmHeader(book.view(flux.id));
  const sheet = new LiveSheet(host, view, { label: "Sample month-end close, Flux sheet" });

  const show = () => {
    sheet.show(view, book.layout(flux.id), true);
    const narrow = narrowOf(host);
    // Name, This month, Change, Change %, Flag
    sheet.grid.setColumnWidths(new Map([[1, narrow ? 116 : 176], [3, 108], [5, narrow ? 100 : 104], [6, 76], [7, 66]]), `cx-flux-${narrow}`);
    sheet.grid.setHiddenColumns(narrow ? [0, 2, 3, 4, 6, 8] : [0, 2, 4, 8]);
    sheet.refresh();
  };
  show();
  new ResizeObserver(show).observe(host);

  const explain = () => {
    const src = flux.source;
    let n = 0;
    const rows = src.usedRange().rows;
    for (let r = 1; r < rows; r++) if (src.getCell(r, 7) === "Explain") n++;
    return n;
  };
  const fmt = (n: number) => n.toLocaleString("en-US");
  const start = Number(settings.source.getCell(1, 1)) || 10000;
  input.value = String(start);
  out.value = fmt(start);
  count.textContent = String(explain());
  input.disabled = false;

  // one change at a time; the slider's latest value wins
  let busy = false;
  let want: number | null = null;
  const apply = async () => {
    if (busy) return;
    busy = true;
    while (want !== null) {
      const v = want;
      want = null;
      await book.type(settings.id, [{ row: 1, col: 1, input: String(v) }]);
      show();
      count.textContent = String(explain());
      root.classList.remove("bump");
      void root.offsetWidth;
      root.classList.add("bump");
    }
    busy = false;
  };
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.value = fmt(v);
    want = v;
    void apply();
  });
  // start on the flags
  sheet.grid.select(1, 7);
  sheet.grid.scrollIntoView(1, 1);
}

// ---------------------------------------------------------------- audit --

export function mountAudit(root: HTMLElement) {
  const host = sheetHost(root);
  const big = root.querySelector<HTMLElement>(".cx-big-n")!;
  const sample = auditSample();
  const je = runJournalTests(sample);
  const score = new Map<string, number>();
  const why = new Map<string, string>();
  for (const e of je.result.ranked) {
    score.set(e.id, e.score);
    why.set(e.id, [...new Set(e.flags.map((f) => JE_TEST_LABEL[f.test]))].join(" · "));
  }
  const lines = sample.lines.map((l, i) => ({ l, i, s: score.get(String(l.entry)) ?? 0 }));
  lines.sort((a, b) => b.s - a.s || Number(a.l.entry) - Number(b.l.entry) || a.i - b.i);
  const seen = new Set<string>();
  const rows: CellValue[][] = lines.map(({ l, s }) => {
    const id = String(l.entry);
    const first = !seen.has(id);
    seen.add(id);
    return [l.entry, isoSerial(l.date), l.user, l.description, l.amount, s || null, first ? (why.get(id) ?? null) : null];
  });
  const src = new TableSource(["Entry", "Date", "User", "Description", "Amount", "Score", "Why it's here"], rows, {
    formats: [null, "yyyy-mm-dd", null, null, AMOUNT, null, null],
    spare: 2,
    styleOf: (row, col) => {
      const s = rows[row][5];
      if (typeof s !== "number" || (col !== 5 && col !== 6)) return null;
      const f = rowFill(s >= 5 ? "bad" : s >= 3 ? "warn" : "info");
      return col === 5 ? { ...f, bold: true } : f;
    },
  });
  const sheet = new LiveSheet(host, src, { label: "Sample journal, scored by the journal entry tests" });
  const layout = () => sheet.layout({ widths: [64, 92, 70, 170, 96, 56, 320], frozenRows: 1, hiddenCols: narrowOf(host) ? [1, 2, 3] : [1] });
  layout();
  new ResizeObserver(layout).observe(host);
  sheet.grid.select(1, 5);
  countUp(big, je.result.ranked.length, 0);
}
