/**
 * The bank rec section: the cash book and the bank statement side by side in
 * the real grid, reconciled by the real engine, with the results (and the
 * rec statement) in a panel. Picking a result selects and outlines its lines
 * on both sides.
 */
import { bankRecSample } from "../samples";
import { RULE_LABEL, runBankRec, signed, type BankRec, type RecRow } from "./compute";
import { h, ms } from "./frame";
import { cashSheet } from "./hero";
import { LiveSheet } from "./sheet";

type Tab = "explain" | "matched" | "statement";

export function mount(root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>(".af")!;
  const body = frame.querySelector<HTMLElement>(".af-body")!;
  const side = frame.querySelector<HTMLElement>(".af-side")!;
  frame.querySelector(".af-foot .af-tabs")?.replaceChildren(h("span", { class: "af-tab active", textContent: "Match" }));
  const sample = bankRecSample();

  const t0 = performance.now();
  const rec: BankRec = runBankRec(sample.ledger, sample.bank);
  const took = performance.now() - t0;
  const identity = (n: number) => Array.from({ length: n }, (_, i) => i);
  const rowsA = identity(sample.ledger.length);
  const rowsB = identity(sample.bank.length);
  const notes = (side: "a" | "b") => rec.notes[side];

  const pane = (title: string, count: number) => {
    const grid = h("div", { class: "af-grid" });
    const el = h("div", { class: "rec-pane" }, h("div", { class: "rec-pane-head" }, title, h("span", { textContent: `${count} lines` })), grid);
    return { el, grid };
  };
  const pa = pane("Cash book", sample.ledger.length);
  const pb = pane("Bank statement", sample.bank.length);
  body.replaceChildren(pa.el, pb.el, side);
  // narrower columns: two sheets share the width here
  const view = { widths: [80, 84, 132, 90, 230], frozenRows: 1 };
  const sa = new LiveSheet(pa.grid, cashSheet(sample.ledger, () => mapRows(notes("a"), rowsA)), { label: "Sample cash book", frame, idleStatus: status });
  const sb = new LiveSheet(pb.grid, cashSheet(sample.bank, () => mapRows(notes("b"), rowsB)), { label: "Sample bank statement", frame, idleStatus: status });
  sa.layout(view);
  sb.layout(view);

  function status() {
    const s = rec.result.summary;
    return `${(s.matchRate * 100).toFixed(1)}% matched · ${s.matchedA} of ${s.countA} and ${s.matchedB} of ${s.countB} lines · ${ms(took)}`;
  }

  let tab: Tab = "explain";
  let current = -1;
  const shown: RecRow[] = [];

  const pick = (i: number) => {
    current = i;
    const r = shown[i];
    side.querySelectorAll<HTMLElement>(".rs-item").forEach((b, j) => b.setAttribute("aria-current", String(j === i)));
    const mark = (sheet: LiveSheet, lines: number[]) => {
      if (!lines.length) {
        sheet.grid.setHighlights([]);
        return;
      }
      const rows = lines.map((x) => x + 1);
      const top = Math.min(...rows);
      const bottom = Math.max(...rows);
      // outline the lines, select their amounts (so the status bar adds them up)
      const together = bottom - top + 1 === rows.length;
      sheet.reveal({ top, left: 0, bottom, right: 4 }, r.tone === "ok" ? "#1e8e3e" : r.tone === "info" ? "#1a73e8" : "#d93025", { top, left: 3, bottom: together ? bottom : top, right: 3 });
      // a split: outline each part, not the block between
      if (lines.length > 1) sheet.grid.setHighlights(rows.map((row) => ({ range: { top: row, left: 0, bottom: row, right: 4 }, color: "#1e8e3e" })));
    };
    mark(sa, r.a);
    mark(sb, r.b);
    // both sides' amounts, added up as the status bar would
    const add = (lines: number[], list: { amount: number }[]) => lines.reduce((t, i) => t + Math.round(list[i].amount * 100), 0) / 100;
    const parts: string[] = [];
    if (r.a.length) parts.push(`Cash book ${signed(add(r.a, sample.ledger))}${r.a.length > 1 ? ` (${r.a.length} lines)` : ""}`);
    if (r.b.length) parts.push(`Bank ${signed(add(r.b, sample.bank))}${r.b.length > 1 ? ` (${r.b.length} lines)` : ""}`);
    const st = frame.querySelector(".af-status");
    if (st) st.textContent = parts.join(" · ");
  };

  const item = (r: RecRow, i: number) => {
    const b = h(
      "button",
      { type: "button", class: "rs-item", onclick: () => pick(i) },
      h("i", { class: r.tone }),
      h("b", { textContent: r.label }),
      h("span", { class: "amt", textContent: signed(r.amount) }),
      h("em", { textContent: r.detail }),
    );
    b.setAttribute("aria-current", String(i === current));
    return h("li", {}, b);
  };

  const render = () => {
    const s = rec.result.summary;
    shown.length = 0;
    const seg = h("div", { class: "seg", role: "group" });
    seg.setAttribute("aria-label", "Show");
    const explain = rec.rows.filter((r) => r.group !== "matched");
    const matched = rec.rows.filter((r) => r.group === "matched");
    for (const [id, text] of [
      ["explain", `To explain ${explain.length}`],
      ["matched", "Matched"],
      ["statement", "Statement"],
    ] as [Tab, string][]) {
      const b = h("button", { type: "button", textContent: text, onclick: () => ((tab = id), (current = -1), render()) });
      b.setAttribute("aria-pressed", String(tab === id));
      seg.append(b);
    }
    const kids: (Node | null)[] = [
      h("p", { class: "sp-title" }, "Reconciliation", h("span", { textContent: `${(s.matchRate * 100).toFixed(1)}% matched` })),
      h("p", { class: "sp-sub", textContent: `${s.matchedA} of ${s.countA} cash book lines and ${s.matchedB} of ${s.countB} bank lines matched, in ${ms(took)} in this tab.` }),
      seg,
    ];
    if (tab === "explain") {
      const groups: [RecRow["group"], string][] = [
        ["difference", "Errors in the cash book"],
        ["timing", "Not through the bank yet"],
        ["bank", "Only on the bank"],
      ];
      for (const [g, title] of groups) {
        const rows = explain.filter((r) => r.group === g);
        if (!rows.length) continue;
        kids.push(h("p", { class: "sp-h", textContent: title }));
        const ul = h("ul", { class: "rs-list" });
        for (const r of rows) ul.append(item(r, shown.push(r) - 1));
        kids.push(ul);
      }
    } else if (tab === "matched") {
      const tiles = h("div", { class: "tiles" });
      const by = s.byRule;
      for (const rule of ["exact", "reference", "fuzzy"] as const) tiles.append(h("div", { class: "tile" }, h("b", { textContent: String(by[rule]) }), h("span", { textContent: RULE_LABEL[rule] })));
      kids.push(tiles, h("p", { class: "sp-h", textContent: "Matched the hard way" }));
      const ul = h("ul", { class: "rs-list" });
      for (const r of matched) ul.append(item(r, shown.push(r) - 1));
      kids.push(ul);
    } else {
      kids.push(statement(rec, sample.period));
    }
    const wrap = h("div", { class: "sp" });
    wrap.append(...kids.filter((k): k is Node => !!k));
    side.replaceChildren(wrap);
  };
  render();
  // start on the most telling result: the keying error
  if (shown.length) queueMicrotask(() => pick(0));
}

function mapRows<T>(byLine: Map<number, T>, rows: number[]): Map<number, T> {
  const out = new Map<number, T>();
  rows.forEach((row, line) => {
    const v = byLine.get(line);
    if (v !== undefined) out.set(row, v);
  });
  return out;
}

/** The rec statement, as recStatement() built it. */
function statement(rec: BankRec, period: string): HTMLElement {
  const st = rec.statement;
  const t = h("table", { class: "stmt" });
  const row = (label: string, value: number, cls = "") => {
    const tr = h("tr", { class: cls }, h("th", { scope: "row", textContent: label }), h("td", { textContent: signed(value) }));
    t.append(tr);
    return tr;
  };
  for (const l of st.bankLines) if (l.id === "bank" || l.total || l.items.length) row(l.label, l.total);
  row("Adjusted bank balance", st.adjustedBank, "sum");
  t.append(h("tr", { class: "gap" }, h("td", { colSpan: 2 })));
  for (const l of st.ledgerLines) if (l.id === "ledger" || l.total || l.items.length) row(l.label, l.total);
  row("Adjusted cash book balance", st.adjustedLedger, "sum");
  const z = row("Difference", st.difference, "zero");
  z.lastElementChild!.append(h("span", { class: `pill${st.difference ? " bad" : ""}`, textContent: st.difference ? "Doesn't agree" : "✓ Agreed" }));
  return h("div", {}, h("p", { class: "sp-h", textContent: `Rec statement · ${period}` }), t);
}
