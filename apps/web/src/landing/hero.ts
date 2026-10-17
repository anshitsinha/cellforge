/**
 * The hero: the sample month's cash book and bank statement in the real
 * grid, reconciled by the real matching engine as the page opens. The card's
 * numbers and the Note column come from that run; change an amount and it
 * runs again.
 */
import { bankRecSample, type CashLine } from "../samples";
import { money, runBankRec, type BankRec, type Tone } from "./compute";
import { countUp, h, isDark, ms, reduceMotion, sheetTabs } from "./frame";
import { LiveSheet } from "./sheet";
import { AMOUNT, DATE, TableSource } from "./table";
import { isoSerial } from "./compute";
import type { CellStyle, CellValue } from "@cellforge/grid";

export const HEADERS = ["Date", "Reference", "Description", "Amount", "Note"];
export const WIDTHS = [96, 100, 228, 104, 280];

/** The note's look: the app's conditional-format colours for problems, a quiet green for matches. */
export function toneStyle(tone: Tone): CellStyle {
  switch (tone) {
    case "bad":
      return { fill: "#ffc7ce", color: "#9c0006" };
    case "warn":
      return { fill: "#ffeb9c", color: "#9c5700" };
    case "info":
      return { fill: "#dbe7fd", color: "#1a4fb4" };
    default:
      return { color: isDark() ? "#7fd3a4" : "#17794b" };
  }
}

/** A cash book or bank statement as a sheet, with the reconciliation's notes in column E. */
export function cashSheet(lines: CashLine[], notes: () => Map<number, { text: string; tone: Tone }> | undefined): TableSource {
  const rows: CellValue[][] = lines.map((l) => [isoSerial(l.date), l.reference || null, l.description, l.amount, null]);
  const src = new TableSource(HEADERS, rows, {
    formats: [DATE, null, null, AMOUNT, null],
    spare: 6,
    styleOf: (row, col) => {
      if (col !== 4) return null;
      const n = notes()?.get(row);
      return n ? toneStyle(n.tone) : null;
    },
  });
  const getCell = src.getCell.bind(src);
  src.getCell = (row, col) => (col === 4 && row > 0 ? (notes()?.get(row - 1)?.text ?? null) : getCell(row, col));
  return src;
}

/** Cash lines back from an edited sheet (rows without a date or an amount are left out). */
export function linesOf(src: TableSource): { lines: CashLine[]; rows: number[] } {
  const lines: CashLine[] = [];
  const rows: number[] = [];
  src.rows.forEach((r, i) => {
    const [d, ref, desc, amt] = r;
    if (typeof amt !== "number") return;
    const date = typeof d === "number" ? serialIso(d) : "2026-10-31";
    lines.push({ date, reference: ref === null ? "" : String(ref), description: desc === null ? "" : String(desc), amount: amt });
    rows.push(i);
  });
  return { lines, rows };
}

function serialIso(s: number): string {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(s) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function mount(root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>(".af")!;
  const host = frame.querySelector<HTMLElement>(".af-grid")!;
  const card = root.querySelector<HTMLElement>(".hero-card")!;
  const runBtn = frame.querySelector<HTMLButtonElement>(".af-run");
  const sample = bankRecSample();

  let rec: BankRec | null = null;
  // sheet row (0-based under the header) -> line index used in the last run, per side
  let rowsA: number[] = [];
  let rowsB: number[] = [];
  const noteMap = (side: "a" | "b") => {
    if (!rec) return undefined;
    const byLine = rec.notes[side];
    const rows = side === "a" ? rowsA : rowsB;
    const out = new Map<number, { text: string; tone: Tone }>();
    rows.forEach((row, line) => {
      const n = byLine.get(line);
      if (n) out.set(row, n);
    });
    return out;
  };
  const cash = cashSheet(sample.ledger, () => noteMap("a"));
  const bank = cashSheet(sample.bank, () => noteMap("b"));
  const sheets = [cash, bank];
  host.replaceChildren();
  const view = { widths: WIDTHS, frozenRows: 1 };
  let active = 0;
  const sheet = new LiveSheet(host, cash, {
    label: "Sample cash book, a live cellforge sheet",
    frame,
    idleStatus: () => `${sheets[active].rows.length} lines`,
    onEdit: (cell, text) => {
      const src = sheets[active];
      if (cell.col === 4) return false; // the notes are the reconciliation's
      src.set(cell.row, cell.col, text);
      run(false);
      return true;
    },
  });
  sheet.layout(view);
  const tabs = sheetTabs(frame, ["Cash book", "Bank statement"], (i) => {
    active = i;
    sheet.grid.setHighlights([]);
    sheet.show(sheets[i], view);
  });

  function run(animate: boolean) {
    const a = linesOf(cash);
    const b = linesOf(bank);
    const t0 = performance.now();
    rec = runBankRec(a.lines, b.lines);
    const took = performance.now() - t0;
    rowsA = a.rows;
    rowsB = b.rows;
    sheet.refresh();
    renderCard(rec, took, animate);
  }

  // jump to the lines behind a result
  const show = (side: 0 | 1, lines: number[]) => {
    if (!lines.length) return;
    tabs.set(side);
    const rows = (side === 0 ? rowsA : rowsB).filter((_, i) => lines.includes(i)).map((r) => r + 1);
    const top = Math.min(...rows);
    const bottom = Math.max(...rows);
    sheet.reveal({ top, left: 0, bottom, right: 4 }, "#d93025");
    sheet.grid.focus();
  };

  function renderCard(r: BankRec, took: number, animate: boolean) {
    const c = r.card;
    const pct = h("b", { textContent: c.matchPct.toFixed(1) });
    const meter = h("span", { class: "hc-fill" });
    meter.style.setProperty("--p", `${c.matchPct}%`);
    const item = (label: string, value: string, tone: string, onClick?: () => void) => {
      const dd = onClick ? h("button", { type: "button", class: `hc-link ${tone}`, textContent: value, onclick: onClick }) : h("span", { class: tone, textContent: value });
      if (onClick) dd.setAttribute("aria-label", `${label}: ${value}. Show in the sheet`);
      return h("div", { class: "hc-row" }, h("dt", { textContent: label }), h("dd", {}, dd));
    };
    const k = r.keyingExample;
    const twice = r.rows.find((x) => x.label === "Posted twice");
    const split = r.result.matches.find((m) => m.rule === "one-to-many" || m.rule === "many-to-one");
    card.replaceChildren(
      h(
        "div",
        { class: "hc-head" },
        h("span", { class: "hc-icon", textContent: "⇄" }),
        h("div", {}, h("strong", { textContent: "Reconcile two sheets" }), h("span", { textContent: "Cash book ⇄ Bank statement" })),
      ),
      h("div", { class: "hc-meter" }, meter),
      h("p", { class: "hc-big" }, pct, "% matched"),
      h(
        "dl",
        { class: "hc-list" },
        item("Cash book lines matched", `${c.matchedA} of ${c.countA}`, ""),
        item("Bank lines matched", `${c.matchedB} of ${c.countB}`, ""),
        item("Split payment found", String(c.splits), "ok", split ? () => show(1, split.b) : undefined),
        item("Keying error", String(c.keying), c.keying ? "warn" : "ok", k ? () => show(0, [k.a]) : undefined),
        item("Posted twice", String(c.postedTwice), c.postedTwice ? "warn" : "ok", twice ? () => show(0, twice.a) : undefined),
        item("Left to explain: book · bank", `${c.leftA} · ${c.leftB}`, ""),
      ),
      k
        ? h(
            "div",
            { class: "hc-why" },
            h("span", { class: "hc-tag", textContent: "Why don't these match?" }),
            h("p", {}, h("b", { textContent: k.reference }), ` · cash book ${money(k.ledger)}, bank ${money(k.bank)}`),
            h("p", { class: "hc-note", textContent: `${k.label[0].toUpperCase()}${k.label.slice(1)}. Difference ${money(Math.abs(k.bank - k.ledger))}.` }),
          )
        : h("div", { class: "hc-why" }, h("p", { class: "hc-note", textContent: "No keying errors left." })),
      h("p", { class: "hc-foot", textContent: `Matched in ${ms(took)}, in this tab. Nothing uploaded.` }),
    );
    if (animate) {
      countUp(pct, c.matchPct, 1);
      card.classList.remove("hc-in");
      void card.offsetWidth;
      card.classList.add("hc-in");
    }
  }

  runBtn?.addEventListener("click", () => run(true));
  if (runBtn) runBtn.disabled = false;
  // run it as the page opens, a moment after the sheet appears, so the notes visibly arrive
  setTimeout(() => run(true), reduceMotion() ? 0 : 450);
  return () => sheet.destroy();
}
