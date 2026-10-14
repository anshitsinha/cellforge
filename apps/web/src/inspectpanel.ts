/**
 * The inspect panel (in the shared side panel): the selected cell's
 * formula worked out step by step, what it reads and what reads it
 * (outlined on the sheet), and audit findings worth a look.
 */
import type { Step } from "@cellforge/core";
import type { CellRange } from "@cellforge/grid";
import { columnLetter } from "@cellforge/grid";
import "./analysis.css";
import "./historypanel.css";
import { inspectCell, type Place } from "./inspect";
import { icon } from "./ui/icons";
import { closeSidePanel, currentSidePanel, onSidePanelChange, openSidePanel, type SidePanelContext } from "./ui/sidepanel";
import type { Workbook } from "./workbook";

export interface InspectPanelDeps {
  /** the old fixed panel element; kept hidden (the side panel is used instead) */
  root?: HTMLElement;
  workbook: () => Workbook;
  activeSheet: () => string;
  selection: () => { row: number; col: number };
  goTo: (sheetId: string, row: number, col: number) => void;
  highlight: (list: { range: CellRange; color: string }[]) => void;
  onOpen?: () => void;
}

/** Outline colours on the grid (the grid draws them; same in both themes). */
const PRECEDENT = "#4f8ff7";
const DEPENDENT = "#34a853";

export const INSPECT_PANEL = "inspect";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function section(parent: HTMLElement, title: string, extra?: HTMLElement): HTMLElement {
  const s = el("section", "an-section");
  const head = el("div", "an-section__head");
  head.append(el("h3", "an-section__title", title));
  if (extra) head.append(extra);
  s.append(head);
  parent.append(s);
  return s;
}

export function setupInspectPanel(d: InspectPanelDeps) {
  if (d.root) d.root.hidden = true;
  let ctx: SidePanelContext | null = null;
  const isOpen = () => currentSidePanel() === INSPECT_PANEL;
  onSidePanelChange((id) => {
    if (id !== INSPECT_PANEL && ctx) {
      ctx = null;
      d.highlight([]);
    }
  });

  function stepTree(s: Step): HTMLElement {
    const li = el("li");
    const line = el("div", "insp-step");
    line.append(el("code", undefined, s.text), el("span", undefined, "→"), el("strong", undefined, s.value));
    li.append(line);
    if (s.children.length) {
      const ul = el("ul");
      for (const c of s.children) ul.append(stepTree(c));
      li.append(ul);
    }
    return li;
  }

  function places(root: HTMLElement, title: string, list: Place[], color: string, none: string) {
    const sec = section(root, title, el("span", "cf-badge", String(list.length)));
    if (!list.length) {
      sec.append(el("p", "an-hint", none));
      return;
    }
    const ul = el("ul", "insp-places");
    for (const p of list.slice(0, 200)) {
      const b = el("button", "insp-place", p.label);
      b.type = "button";
      b.style.setProperty("--swatch", color);
      b.title = "Go to it";
      b.addEventListener("click", () => d.goTo(p.sheetId, p.range.top, p.range.left));
      const li = el("li");
      li.append(b);
      ul.append(li);
    }
    sec.append(ul);
    if (list.length > 200) sec.append(el("p", "an-hint", `And ${(list.length - 200).toLocaleString()} more.`));
  }

  function fill(p: SidePanelContext) {
    const sheetId = d.activeSheet();
    const { row, col } = d.selection();
    const i = inspectCell(d.workbook(), sheetId, row, col);
    const ref = `${columnLetter(col)}${row + 1}`;
    p.setTitle(`Inspect ${ref}`, "How it's worked out, what it reads and what reads it");
    const root = el("div", "an-stack an-stack--loose insp");

    if (i.findings.length) {
      const sec = section(root, "Worth a look");
      for (const f of i.findings) {
        const n = el("div", "an-note an-note--warning");
        n.append(icon("warning"), el("span", undefined, f.message));
        sec.append(n);
      }
    }
    if (i.steps) {
      const sec = section(root, "How it's worked out");
      const ul = el("ul", "insp-steps");
      ul.append(stepTree(i.steps));
      sec.append(ul);
      places(root, "Reads", i.precedents, PRECEDENT, "No cell references: the formula only uses numbers and functions.");
    } else {
      const empty = el("div", "an-empty");
      empty.append(el("p", undefined, `${ref} holds a value, not a formula. Select a formula cell to see it worked out step by step; below is everything that reads ${ref}.`));
      root.append(empty);
    }
    places(root, "Read by", i.dependents, DEPENDENT, `Nothing reads ${ref}.`);
    const legend = el("p", "an-hint insp-legend");
    legend.textContent = "Cells it reads are outlined in blue on the sheet, cells that read it in green.";
    root.append(legend);
    p.body.replaceChildren(root);

    // outline them on this sheet
    d.highlight([
      ...i.precedents.filter((x) => x.sheetId === sheetId).map((x) => ({ range: x.range, color: PRECEDENT })),
      ...i.dependents.filter((x) => x.sheetId === sheetId).map((x) => ({ range: x.range, color: DEPENDENT })),
    ]);
  }

  function render() {
    if (ctx && isOpen()) fill(ctx);
  }

  function toggle() {
    if (isOpen()) {
      closeSidePanel();
      return;
    }
    d.onOpen?.();
    openSidePanel({
      id: INSPECT_PANEL,
      title: "Inspect",
      render: (p) => {
        ctx = p;
        fill(p);
        return () => {
          ctx = null;
          d.highlight([]);
        };
      },
    });
  }

  return {
    toggle,
    render,
    close: () => isOpen() && closeSidePanel(),
    get open() {
      return isOpen();
    },
  };
}
