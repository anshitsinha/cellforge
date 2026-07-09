/** The "Explain this number" panel: the lineage tree, jump-to, and a write-up to copy. */
import { explainCell, writeUp, type LineageNode, type LineageOptions } from "./lineage";
import type { Workbook } from "./workbook";

export interface LineageDeps {
  workbook: () => Workbook;
  sheetId: () => string;
  cell: () => { row: number; col: number };
  lastEdit: LineageOptions["lastEdit"];
  goTo: (sheetId: string, row: number, col: number) => void;
  status: (t: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const KIND: Record<LineageNode["kind"], string> = { formula: "formula", typed: "typed in", imported: "imported", empty: "empty", range: "range", spill: "from a formula's result" };

export function openLineage(d: LineageDeps): void {
  document.querySelector(".lineage-panel")?.remove();
  const { row, col } = d.cell();
  const root = explainCell(d.workbook(), d.sheetId(), row, col, { lastEdit: d.lastEdit });
  const panel = el("aside", { className: "recipe-panel lineage-panel" });
  panel.setAttribute("aria-label", "Where this number came from");
  const close = el("button", { type: "button", textContent: "×", title: "Close" });
  close.addEventListener("click", () => panel.remove());
  panel.append(el("div", { className: "recipe-head" }, el("strong", { textContent: `Where ${root.label} came from` }), close));

  const node = (n: LineageNode): HTMLElement => {
    const li = el("li");
    const go = el("button", { type: "button", className: "hp-cell", textContent: n.label, title: "Show it in the sheet" });
    go.addEventListener("click", () => d.goTo(n.sheetId, n.row, n.col));
    const what = el("span", { className: "hp-muted", textContent: ` ${KIND[n.kind]}` });
    const value = el("span", { className: "lineage-value", textContent: n.kind === "range" ? `${n.range!.cells.toLocaleString()} cells, total ${n.range!.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : n.value || "(empty)" });
    li.append(go, " ", value, what);
    if (n.formula) li.append(el("div", { className: "lineage-formula", textContent: n.formula }));
    if (n.typed) li.append(el("div", { className: "hp-muted", textContent: `typed ${new Date(n.typed.at).toLocaleString()}` }));
    if (n.origin) li.append(el("div", { className: "hp-muted", textContent: n.origin }));
    if (n.provenance) li.append(el("div", { className: "hp-muted", textContent: `this row: ${n.provenance}` }));
    if (n.repeat) li.append(el("div", { className: "hp-muted", textContent: "(explained above)" }));
    if (n.children.length) {
      const ul = el("ul", { className: "lineage-tree" });
      for (const c of n.children) ul.append(node(c));
      li.append(ul);
    }
    return li;
  };
  panel.append(el("ul", { className: "lineage-tree lineage-root" }, node(root)));

  const text = writeUp(root);
  const copy = el("button", { type: "button", textContent: "Copy the write-up" });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      d.status("Copied the explanation");
    } catch {
      d.status("Couldn't copy; select the text below instead.");
    }
  });
  panel.append(el("div", { className: "numfmt-actions" }, copy), el("pre", { className: "lineage-writeup", textContent: text }));
  panel.addEventListener("keydown", (e) => e.key === "Escape" && panel.remove());
  document.body.append(panel);
  copy.focus();
}
