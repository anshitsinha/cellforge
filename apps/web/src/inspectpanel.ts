/** The inspect panel: the selected cell's formula, step by step, its precedents, dependents and audit findings. */
import type { Step } from "@cellforge/core";
import type { CellRange } from "@cellforge/grid";
import { columnLetter } from "@cellforge/grid";
import { inspectCell, type Place } from "./inspect";
import type { Workbook } from "./workbook";

export interface InspectPanelDeps {
  root: HTMLElement;
  workbook: () => Workbook;
  activeSheet: () => string;
  selection: () => { row: number; col: number };
  goTo: (sheetId: string, row: number, col: number) => void;
  highlight: (list: { range: CellRange; color: string }[]) => void;
  onOpen?: () => void;
}

const PRECEDENT = "#4f8ff7";
const DEPENDENT = "#34a853";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function setupInspectPanel(d: InspectPanelDeps) {
  const { root } = d;
  let open = false;

  function stepTree(s: Step): HTMLElement {
    const li = el("li");
    const line = el("div", "ip-step");
    line.append(el("code", undefined, s.text), el("span", "ip-arrow", "→"), el("strong", undefined, s.value));
    li.append(line);
    if (s.children.length) {
      const ul = el("ul");
      for (const c of s.children) ul.append(stepTree(c));
      li.append(ul);
    }
    return li;
  }

  function places(title: string, list: Place[], color: string) {
    const sec = el("section", "hp-section");
    sec.append(el("h4", undefined, `${title} (${list.length})`));
    if (!list.length) sec.append(el("p", "hp-muted", title === "Reads" ? "No cell references." : "Nothing reads this cell."));
    const ul = el("ul", "ip-places");
    for (const p of list.slice(0, 200)) {
      const b = el("button", "hp-cell", p.label);
      b.type = "button";
      b.style.color = color;
      b.addEventListener("click", () => d.goTo(p.sheetId, p.range.top, p.range.left));
      const li = el("li");
      li.append(b);
      ul.append(li);
    }
    sec.append(ul);
    root.append(sec);
  }

  function render() {
    if (!open) return;
    const sheetId = d.activeSheet();
    const { row, col } = d.selection();
    const i = inspectCell(d.workbook(), sheetId, row, col);
    root.innerHTML = "";
    const head = el("div", "hp-head");
    head.append(el("h3", undefined, `Inspect ${columnLetter(col)}${row + 1}`));
    const close = el("button", "hp-close", "×");
    close.type = "button";
    close.title = "Close";
    close.setAttribute("aria-label", "Close inspect");
    close.addEventListener("click", toggle);
    head.append(close);
    root.append(head);

    if (i.findings.length) {
      const sec = el("section", "hp-section");
      sec.append(el("h4", undefined, "Worth a look"));
      for (const f of i.findings) sec.append(el("p", "ip-finding", f.message));
      root.append(sec);
    }
    if (i.steps) {
      const sec = el("section", "hp-section");
      sec.append(el("h4", undefined, "How it's worked out"));
      const ul = el("ul", "ip-steps");
      ul.append(stepTree(i.steps));
      sec.append(ul);
      root.append(sec);
      places("Reads", i.precedents, PRECEDENT);
    } else {
      const sec = el("section", "hp-section");
      sec.append(el("p", "hp-muted", "No formula here. Below is everything that reads this cell."));
      root.append(sec);
    }
    places("Read by", i.dependents, DEPENDENT);

    // outline them on this sheet
    d.highlight([
      ...i.precedents.filter((p) => p.sheetId === sheetId).map((p) => ({ range: p.range, color: PRECEDENT })),
      ...i.dependents.filter((p) => p.sheetId === sheetId).map((p) => ({ range: p.range, color: DEPENDENT })),
    ]);
  }

  function toggle() {
    open = !open;
    root.hidden = !open;
    if (open) {
      d.onOpen?.();
      render();
    } else d.highlight([]);
  }

  return {
    toggle,
    render,
    close: () => open && toggle(),
    get open() {
      return open;
    },
  };
}
