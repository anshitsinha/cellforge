/**
 * The history panel: every change this session (click one to go back to
 * it, and forward again), named versions (save, compare, go back), and the
 * history of the selected cell.
 */
import type { Action } from "@cellforge/actions";
import { columnLetter } from "@cellforge/grid";
import type { EditableSource } from "./editable";
import { compareWorkbooks, versionWorkbook, type Comparison, type Version } from "./versions";
import type { Workbook } from "./workbook";

export interface TrailEntry {
  at: number;
  text: string;
}

export interface HistoryPanelDeps {
  root: HTMLElement;
  workbook: () => Workbook;
  activeSheet: () => string;
  selection: () => { row: number; col: number };
  timeline: () => { done: { label: string; at: number }[]; undone: { label: string; at: number }[] };
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
  run: (action: Action) => Promise<unknown>;
  /** select a cell, switching sheet if needed */
  goTo: (sheet: string, row: number, col: number) => void;
  /** what was typed into this cell this session, by row identity */
  trail: (sheet: string, rowId: number, col: number) => TrailEntry[];
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const date = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function setupHistoryPanel(d: HistoryPanelDeps): { toggle: () => void; render: () => void; readonly open: boolean } {
  const { root } = d;
  let open = false;
  let comparison: { name: string; result: Comparison } | null = null;
  // versions as workbooks, built once (versions never change)
  const built = new WeakMap<Version, Workbook>();
  const asWorkbook = (v: Version) => {
    let wb = built.get(v);
    if (!wb) {
      wb = versionWorkbook(v);
      built.set(v, wb);
    }
    return wb;
  };

  async function jump(steps: number) {
    for (let i = 0; i < Math.abs(steps); i++) await (steps < 0 ? d.undo() : d.redo());
  }

  function section(title: string): HTMLElement {
    const s = el("section", "hp-section");
    s.append(el("h4", undefined, title));
    root.append(s);
    return s;
  }

  function render() {
    if (!open) return;
    const scroll = root.scrollTop;
    root.innerHTML = "";

    // header
    const head = el("div", "hp-head");
    head.append(el("h3", undefined, "History"));
    const close = el("button", "hp-close", "×");
    close.type = "button";
    close.title = "Close";
    close.addEventListener("click", toggle);
    head.append(close);
    root.append(head);

    // --- named versions
    const wb = d.workbook();
    const vs = section("Versions");
    const form = el("form", "hp-version-form");
    const input = el("input");
    input.placeholder = "Name this version, e.g. sent to auditor";
    input.maxLength = 80;
    const save = el("button", undefined, "Save");
    save.type = "submit";
    form.append(input, save);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name) void d.run({ type: "version.save", params: { name } });
    });
    vs.append(form);
    if (!wb.versions.length) vs.append(el("p", "hp-muted", "Save a version before sending the file to someone, so you can see later exactly what changed."));
    for (const v of [...wb.versions].reverse()) {
      const row = el("div", "hp-version");
      const label = el("div");
      label.append(el("strong", undefined, v.name), el("small", undefined, date(v.at)));
      const actions = el("div", "hp-buttons");
      const cmp = el("button", undefined, "Compare");
      cmp.type = "button";
      cmp.title = "Which cells changed since this version";
      cmp.addEventListener("click", () => {
        comparison = { name: v.name, result: compareWorkbooks(asWorkbook(v), d.workbook()) };
        render();
      });
      const back = el("button", undefined, "Go back");
      back.type = "button";
      back.title = "Make every sheet what it was then (you can undo this)";
      back.addEventListener("click", () => void d.run({ type: "version.restore", params: { name: v.name } }));
      const del = el("button", undefined, "Delete");
      del.type = "button";
      del.addEventListener("click", () => void d.run({ type: "version.delete", params: { name: v.name } }));
      actions.append(cmp, back, del);
      row.append(label, actions);
      vs.append(row);
    }

    // --- comparison result
    if (comparison) {
      const cs = section(`Changes since "${comparison.name}"`);
      const { changes, notes, truncated } = comparison.result;
      for (const n of notes) cs.append(el("p", "hp-note", n));
      if (!changes.length && !notes.length) cs.append(el("p", "hp-muted", "Nothing has changed."));
      const list = el("ul", "hp-changes");
      for (const c of changes) {
        const li = el("li");
        const where = el("button", "hp-cell", `${c.sheet}!${c.cell}`);
        where.type = "button";
        where.addEventListener("click", () => {
          const sheet = d.workbook().sheets.find((s) => s.name === c.sheet);
          if (sheet) d.goTo(sheet.id, c.row, c.col);
        });
        li.append(where, el("span", "hp-before", c.before || "(empty)"), el("span", "hp-arrow", "→"), el("span", "hp-after", c.after || "(empty)"));
        list.append(li);
      }
      cs.append(list);
      if (truncated) cs.append(el("p", "hp-muted", `Showing the first ${changes.length.toLocaleString()} changes.`));
      const done = el("button", undefined, "Hide comparison");
      done.type = "button";
      done.addEventListener("click", () => {
        comparison = null;
        render();
      });
      cs.append(done);
    }

    // --- this cell
    const sheetId = d.activeSheet();
    const src: EditableSource = wb.get(sheetId).source;
    const { row, col } = d.selection();
    const ref = `${columnLetter(col)}${row + 1}`;
    const cellSec = section(`Cell ${ref}`);
    const show = (s: EditableSource, r: number) => {
      if (r < 0) return "(row not there)";
      const t = s.getEditText(r, col);
      const v = s.getCell(r, col);
      return t.startsWith("=") ? `${t} → ${v ?? ""}` : t || "(empty)";
    };
    const rowId = src.toBase(row);
    const cellList = el("ul", "hp-cellhist");
    for (const v of wb.versions) {
      const vw = asWorkbook(v);
      const vsSheet = vw.sheets.find((s) => s.id === sheetId);
      const li = el("li");
      li.append(el("small", undefined, v.name));
      li.append(el("span", undefined, vsSheet ? show(vsSheet.source, vsSheet.source.rowIdToView()(rowId)) : "(sheet not there)"));
      cellList.append(li);
    }
    for (const t of d.trail(sheetId, rowId, col)) {
      const li = el("li");
      li.append(el("small", undefined, `typed ${time(t.at)}`), el("span", undefined, t.text || "(cleared)"));
      cellList.append(li);
    }
    const now = el("li", "hp-now");
    now.append(el("small", undefined, "now"), el("span", undefined, show(src, row)));
    cellList.append(now);
    cellSec.append(cellList);

    // --- timeline
    const tl = section("This session");
    const { done, undone } = d.timeline();
    const list = el("ol", "hp-timeline");
    const item = (label: string, at: number | null, state: "done" | "current" | "undone", steps: number) => {
      const li = el("li", `hp-step ${state}`);
      const b = el("button");
      b.type = "button";
      b.append(el("span", undefined, label));
      if (at) b.append(el("small", undefined, time(at)));
      b.title = state === "current" ? "You are here" : steps < 0 ? "Go back to just after this" : "Go forward to this";
      b.disabled = state === "current";
      b.addEventListener("click", () => void jump(steps));
      li.append(b);
      list.append(li);
    };
    item("Start", null, done.length ? "done" : "current", -done.length);
    done.forEach((e, i) => item(e.label, e.at, i === done.length - 1 ? "current" : "done", -(done.length - 1 - i)));
    undone.forEach((e, i) => item(e.label, e.at, "undone", i + 1));
    tl.append(list);
    if (!done.length && !undone.length) tl.append(el("p", "hp-muted", "Changes you make appear here. Click one to go back to it."));

    root.scrollTop = scroll;
  }

  function toggle() {
    open = !open;
    root.hidden = !open;
    document.body.classList.toggle("history-open", open);
    if (open) render();
  }

  return {
    toggle,
    render,
    get open() {
      return open;
    },
  };
}
